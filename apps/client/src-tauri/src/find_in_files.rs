//! Full-text search over a worktree for the editor's "Find in Files" (⇧⌘F). Like an IDE's index, the text of every
//! project file (`git::list_files`: tracked and untracked, never ignored) is kept in memory per worktree, from its
//! first search until its session is removed: a search re-reads only the files whose size or modification time
//! changed and scans the texts on every core.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::git;

/// Matching lines reported at most; the search stops there and says so.
const MATCH_LIMIT: usize = 500;
/// Characters of a matching line shown before its first match once the line is cut at the front.
const PREVIEW_LEAD: usize = 40;
/// Characters a preview keeps at most, measured from where it starts.
const PREVIEW_LENGTH: usize = 300;
/// Larger files (bundles, dumps) are not searched.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// A NUL byte within this many leading bytes marks a file as binary, as in git.
const BINARY_PROBE_BYTES: usize = 8000;
/// The file list is listed again in the background once it is older; new and deleted files show with the next search.
const LIST_MAX_AGE: Duration = Duration::from_secs(2);
/// Files a search thread takes at a time; the chunks' results are merged in path order.
const CHUNK_FILES: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextQuery {
    pub text: String,
    pub match_case: bool,
    pub whole_words: bool,
    /// `text` is a regular expression (Rust `regex` syntax: no look-around, no backreferences) instead of a literal.
    pub is_regex: bool,
    /// Comma-separated file name masks such as `*.ts, !*.spec.ts`; a mask with `/` applies to the whole path.
    pub file_mask: String,
}

/// A range of UTF-16 code units, the unit JavaScript strings and Monaco columns count in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TextRange {
    pub start: u32,
    pub end: u32,
}

/// One matching line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub path: String,
    /// 1-based.
    pub line: u32,
    /// 1-based columns of the first match in the line, end exclusive, in UTF-16 code units like Monaco's.
    pub column: u32,
    pub end_column: u32,
    /// The line without its indentation, cut around the first match when it is long.
    pub preview: String,
    /// Every match within `preview`.
    pub ranges: Vec<TextRange>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchResult {
    pub matches: Vec<TextMatch>,
    /// More lines matched than `matches` holds.
    pub is_truncated: bool,
}

/// The in-memory texts of every searched worktree.
#[derive(Default)]
pub struct FindRegistry {
    worktrees: Mutex<HashMap<PathBuf, Arc<WorktreeIndex>>>,
}

#[derive(Default)]
struct WorktreeIndex {
    /// When the searches in progress were issued (see `search`).
    running: Mutex<Vec<f64>>,
    files: tokio::sync::Mutex<FileIndex>,
}

/// A search in progress: listed in `WorktreeIndex::running` until it is dropped.
struct RunningSearch {
    index: Arc<WorktreeIndex>,
    issued_at: f64,
}

impl RunningSearch {
    fn start(index: Arc<WorktreeIndex>, issued_at: f64) -> RunningSearch {
        index.running.lock().unwrap().push(issued_at);
        RunningSearch { index, issued_at }
    }

    /// False once a search issued after this one is in progress.
    fn is_current(&self) -> bool {
        !self.index.running.lock().unwrap().iter().any(|&other| other > self.issued_at)
    }
}

impl Drop for RunningSearch {
    fn drop(&mut self) {
        let mut running = self.index.running.lock().unwrap();
        if let Some(position) = running.iter().position(|&other| other == self.issued_at) {
            running.swap_remove(position);
        }
    }
}

#[derive(Default)]
struct FileIndex {
    paths: Arc<Vec<String>>,
    listed_at: Option<Instant>,
    texts: HashMap<String, CachedText>,
}

/// A file's text as of its size and modification time; `None` for binary, oversized, unreadable or deleted files.
#[derive(Clone)]
struct CachedText {
    modified: Option<SystemTime>,
    len: u64,
    text: Option<Arc<str>>,
}

impl FindRegistry {
    fn index(&self, worktree: &Path) -> Arc<WorktreeIndex> {
        self.worktrees.lock().unwrap().entry(worktree.to_path_buf()).or_default().clone()
    }

    /// Frees the texts of `worktree`, once no session works in it any more.
    pub fn forget(&self, worktree: &Path) {
        self.worktrees.lock().unwrap().remove(worktree);
    }
}

/// Searches the worktree for `query`; at most `MATCH_LIMIT` lines, in path and line order. An empty query only
/// brings the worktree's texts into memory, so the first real search is fast too. `issued_at` is when the caller
/// asked (milliseconds since the epoch): a search stops and returns an empty result once one of the same worktree
/// issued after it is in progress, whatever order the two arrive in.
pub async fn search(registry: &FindRegistry, worktree: &Path, query: &TextQuery, issued_at: f64) -> Result<TextSearchResult, String> {
    let matcher = Matcher::new(query)?;
    let index = registry.index(worktree);
    let running = RunningSearch::start(index.clone(), issued_at);
    let mut files = index.files.lock().await;
    if !running.is_current() {
        return Ok(TextSearchResult::default());
    }

    match files.listed_at {
        None => {
            files.paths = Arc::new(git::list_files(worktree).await?);
            files.listed_at = Some(Instant::now());
        }
        Some(listed_at) if listed_at.elapsed() > LIST_MAX_AGE => {
            files.listed_at = Some(Instant::now());
            let (index, worktree) = (index.clone(), worktree.to_path_buf());
            tokio::spawn(async move {
                match git::list_files(&worktree).await {
                    Ok(paths) => index.files.lock().await.paths = Arc::new(paths),
                    Err(error) => eprintln!("failed to list the files to search: {error}"),
                }
            });
        }
        Some(_) => {}
    }

    let paths = files.paths.clone();
    let texts = std::mem::take(&mut files.texts);
    let root = worktree.to_path_buf();
    let (texts, result) = tokio::task::spawn_blocking(move || search_files(&root, &paths, texts, matcher.as_ref(), &|| running.is_current()))
    .await
    .map_err(|error| format!("failed to search: {error}"))?;
    files.texts = texts;
    Ok(result)
}

/// A compiled non-empty query: its pattern and its file mask.
struct Matcher {
    regex: Regex,
    includes: Vec<Mask>,
    excludes: Vec<Mask>,
}

/// A file mask; `on_path` masks (with `/`) match the whole path, the others the file name.
struct Mask {
    pattern: glob::Pattern,
    on_path: bool,
}

const MASK_OPTIONS: glob::MatchOptions = glob::MatchOptions { case_sensitive: true, require_literal_separator: true, require_literal_leading_dot: false };

impl Matcher {
    /// The matcher of `query`, `None` for an empty one.
    fn new(query: &TextQuery) -> Result<Option<Matcher>, String> {
        if query.text.is_empty() {
            return Ok(None);
        }
        let pattern = if query.is_regex { query.text.clone() } else { regex::escape(&query.text) };
        let pattern = if query.whole_words { format!(r"\b(?:{pattern})\b") } else { pattern };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!query.match_case)
            .multi_line(true)
            .build()
            .map_err(|error| format!("failed to search: {}", error.to_string().lines().last().unwrap_or_default().trim_start_matches("error: ")))?;

        let (mut includes, mut excludes) = (Vec::new(), Vec::new());
        for mask in query.file_mask.split(',').map(str::trim) {
            let (target, pattern) = match mask.strip_prefix('!') {
                Some(pattern) => (&mut excludes, pattern.trim()),
                None => (&mut includes, mask),
            };
            if pattern.is_empty() {
                continue;
            }
            let on_path = pattern.contains('/');
            let pattern = glob::Pattern::new(pattern.trim_start_matches('/')).map_err(|error| format!("failed to read the file mask {mask}: {error}"))?;
            target.push(Mask { pattern, on_path });
        }
        Ok(Some(Matcher { regex, includes, excludes }))
    }

    fn accepts(&self, path: &str) -> bool {
        let name = path.rsplit('/').next().unwrap_or(path);
        let matches = |mask: &Mask| mask.pattern.matches_with(if mask.on_path { path } else { name }, MASK_OPTIONS);
        (self.includes.is_empty() || self.includes.iter().any(matches)) && !self.excludes.iter().any(matches)
    }
}

/// What one chunk of files yields: its re-read texts by index into the paths, and its matching lines (at most one
/// more than the limit).
#[derive(Default)]
struct ChunkResult {
    updates: Vec<(usize, CachedText)>,
    matches: Vec<TextMatch>,
}

/// Brings the texts of `paths` up to date and searches them with `matcher` on every core; returns the texts to keep.
/// Stops early once the result is complete or `is_current` turns false.
fn search_files(root: &Path, paths: &[String], mut texts: HashMap<String, CachedText>, matcher: Option<&Matcher>, is_current: &(dyn Fn() -> bool + Sync)) -> (HashMap<String, CachedText>, TextSearchResult) {
    let chunks: Vec<&[String]> = paths.chunks(CHUNK_FILES).collect();
    let results: Mutex<Vec<Option<ChunkResult>>> = Mutex::new((0..chunks.len()).map(|_| None).collect());
    let next = AtomicUsize::new(0);
    // Set once the finished chunks at the front hold more lines than the limit; later chunks cannot change the result.
    let is_done = AtomicBool::new(false);
    let threads = std::thread::available_parallelism().map_or(4, |count| count.get()).min(chunks.len().max(1));

    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                if is_done.load(Ordering::Relaxed) || !is_current() {
                    break;
                }
                let chunk_index = next.fetch_add(1, Ordering::Relaxed);
                let Some(chunk) = chunks.get(chunk_index) else { break };
                let mut result = ChunkResult::default();
                for (offset, path) in chunk.iter().enumerate() {
                    let cached = texts.get(path);
                    let fresh = load_text(&root.join(path), cached);
                    let text = fresh.as_ref().or(cached).and_then(|entry| entry.text.clone());
                    if let Some(fresh) = fresh {
                        result.updates.push((chunk_index * CHUNK_FILES + offset, fresh));
                    }
                    let (Some(matcher), Some(text)) = (matcher, text) else { continue };
                    if result.matches.len() <= MATCH_LIMIT && matcher.accepts(path) {
                        search_text(path, &text, &matcher.regex, MATCH_LIMIT + 1, &mut result.matches);
                    }
                }
                let mut results = results.lock().unwrap();
                results[chunk_index] = Some(result);
                let found: usize = results.iter().map_while(|result| result.as_ref().map(|result| result.matches.len())).sum();
                if matcher.is_some() && found > MATCH_LIMIT {
                    is_done.store(true, Ordering::Relaxed);
                }
            });
        }
    });

    let mut result = TextSearchResult::default();
    for chunk in results.into_inner().unwrap().into_iter().flatten() {
        for (index, update) in chunk.updates {
            texts.insert(paths[index].clone(), update);
        }
        result.matches.extend(chunk.matches);
    }
    if result.matches.len() > MATCH_LIMIT {
        result.matches.truncate(MATCH_LIMIT);
        result.is_truncated = true;
    }
    if texts.len() > paths.len() {
        let listed: HashSet<&String> = paths.iter().collect();
        texts.retain(|path, _| listed.contains(path));
    }
    (texts, result)
}

/// The entry of `file` when its size or modification time differs from `cached`, else `None`; a file that is gone
/// gets an entry without text.
fn load_text(file: &Path, cached: Option<&CachedText>) -> Option<CachedText> {
    let Ok(metadata) = std::fs::metadata(file) else {
        return cached.filter(|cached| cached.text.is_some()).map(|_| CachedText { modified: None, len: 0, text: None });
    };
    let (modified, len) = (metadata.modified().ok(), metadata.len());
    if modified.is_some() && cached.is_some_and(|cached| cached.modified == modified && cached.len == len) {
        return None;
    }
    let mut bytes = Vec::new();
    let is_readable = metadata.is_file() && len <= MAX_FILE_BYTES && std::fs::File::open(file).and_then(|mut handle| handle.read_to_end(&mut bytes)).is_ok();
    let is_binary = memchr::memchr(0, &bytes[..bytes.len().min(BINARY_PROBE_BYTES)]).is_some();
    let text = (is_readable && !is_binary).then(|| Arc::from(String::from_utf8_lossy(&bytes)));
    Some(CachedText { modified, len, text })
}

/// Appends the lines of `text` that `regex` matches to `matches` until it holds `limit` lines.
fn search_text(path: &str, text: &str, regex: &Regex, limit: usize, matches: &mut Vec<TextMatch>) {
    let bytes = text.as_bytes();
    let mut line = 1u32;
    let mut counted_to = 0;
    let mut found = regex.find_iter(text).filter(|found| !found.is_empty()).peekable();
    while let Some(first) = found.next() {
        if matches.len() >= limit {
            return;
        }
        let line_start = memchr::memrchr(b'\n', &bytes[..first.start()]).map_or(0, |index| index + 1);
        let line_end = memchr::memchr(b'\n', &bytes[first.start()..]).map_or(bytes.len(), |index| first.start() + index);
        line += memchr::memchr_iter(b'\n', &bytes[counted_to..line_start]).count() as u32;
        counted_to = line_start;
        let mut ranges = vec![(first.start() - line_start, first.end().min(line_end) - line_start)];
        while let Some(next) = found.next_if(|next| next.start() < line_end) {
            ranges.push((next.start() - line_start, next.end().min(line_end) - line_start));
        }
        matches.push(line_match(path, line, &text[line_start..line_end], &ranges));
    }
}

/// The match of `line`, whose text `content` has no line break, with the byte ranges `ranges` of its matches.
fn line_match(path: &str, line: u32, content: &str, ranges: &[(usize, usize)]) -> TextMatch {
    let content = content.trim_end_matches('\r');
    let chars: Vec<char> = content.chars().collect();
    // `char_at_byte` maps byte offsets to character indexes; `offsets[index]` is the UTF-16 offset of `chars[index]`,
    // its last entry the line's length.
    let mut char_at_byte = vec![chars.len(); content.len() + 1];
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0u32;
    for (index, (byte, char)) in content.char_indices().enumerate() {
        char_at_byte[byte] = index;
        offsets.push(offset);
        offset += char.len_utf16() as u32;
    }
    offsets.push(offset);
    let ranges: Vec<(usize, usize)> = ranges
        .iter()
        .map(|(start, end)| (char_at_byte[(*start).min(content.len())], char_at_byte[(*end).min(content.len())]))
        .filter(|(start, end)| end > start)
        .collect();
    let first = ranges.first().copied().unwrap_or((0, 0));

    let indentation = chars.iter().take_while(|char| char.is_whitespace()).count();
    let is_cut_at_start = first.0 > indentation + PREVIEW_LEAD + PREVIEW_LEAD / 2;
    let start = if is_cut_at_start { first.0 - PREVIEW_LEAD } else { indentation.min(first.0) };
    let mut end = chars.len().min(start + PREVIEW_LENGTH);
    let is_cut_at_end = end < chars.len();
    while end > start && !is_cut_at_end && chars[end - 1].is_whitespace() {
        end -= 1;
    }

    let mut preview: String = if is_cut_at_start { "…".to_string() } else { String::new() };
    let base = offsets[start] - if is_cut_at_start { 1 } else { 0 };
    preview.extend(&chars[start..end]);
    if is_cut_at_end {
        preview.push('…');
    }
    let preview_ranges = ranges
        .iter()
        .filter(|(from, to)| *to > start && *from < end)
        .map(|(from, to)| TextRange { start: offsets[(*from).max(start)] - base, end: offsets[(*to).min(end)] - base })
        .collect();

    TextMatch { path: path.to_string(), line, column: offsets[first.0] + 1, end_column: offsets[first.1] + 1, preview, ranges: preview_ranges }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: &str) -> TextQuery {
        TextQuery { text: text.to_string(), match_case: false, whole_words: false, is_regex: false, file_mask: String::new() }
    }

    async fn git(repo: &Path, args: &[&str]) {
        let status = tokio::process::Command::new("git").arg("-C").arg(repo).args(args).status().await.unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn found(result: &TextSearchResult) -> Vec<(&str, u32, &str)> {
        result.matches.iter().map(|found| (found.path.as_str(), found.line, found.preview.as_str())).collect()
    }

    #[test]
    fn line_match_reads_position_preview_and_ranges() {
        let found = line_match("src/a.ts", 12, "    const Private = private;\r", &[(10, 17), (20, 27)]);
        assert_eq!((found.path.as_str(), found.line, found.column, found.end_column), ("src/a.ts", 12, 11, 18));
        assert_eq!(found.preview, "const Private = private;");
        assert_eq!(found.ranges, vec![TextRange { start: 6, end: 13 }, TextRange { start: 16, end: 23 }]);
    }

    #[test]
    fn line_match_counts_utf16_units_and_cuts_long_lines() {
        let found = line_match("a.md", 1, "😀 x", &[(5, 6)]);
        assert_eq!((found.column, found.end_column), (4, 5));
        assert_eq!(found.ranges, vec![TextRange { start: 3, end: 4 }]);

        let long = format!("{}needle{}", "a".repeat(100), "b".repeat(400));
        let found = line_match("a.js", 1, &long, &[(100, 106)]);
        assert_eq!(found.column, 101);
        assert!(found.preview.starts_with('…') && found.preview.ends_with('…'));
        assert_eq!(found.ranges, vec![TextRange { start: 41, end: 47 }]);
        assert_eq!(&found.preview[41 + 2..47 + 2], "needle");
    }

    #[test]
    fn search_text_groups_matches_per_line() {
        let regex = Regex::new("ab").unwrap();
        let mut matches = Vec::new();
        search_text("a.txt", "x\nab ab\n\nzab", &regex, 10, &mut matches);
        let lines: Vec<(u32, usize)> = matches.iter().map(|found| (found.line, found.ranges.len())).collect();
        assert_eq!(lines, vec![(2, 2), (4, 1)]);
    }

    #[test]
    fn masks_match_file_names_everywhere_and_exclude_with_a_bang() {
        let matcher = Matcher::new(&TextQuery { file_mask: "*.ts, !*.spec.ts,docs/**/*.md".to_string(), ..query("x") }).unwrap().unwrap();
        assert!(matcher.accepts("src/deep/user.ts"));
        assert!(!matcher.accepts("src/user.spec.ts"));
        assert!(matcher.accepts("docs/a/b.md"));
        assert!(!matcher.accepts("readme.md"));
        assert!(Matcher::new(&query("x")).unwrap().unwrap().accepts("any/file"));
    }

    #[tokio::test]
    async fn search_finds_tracked_and_untracked_files_and_follows_edits() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        std::fs::create_dir(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/user.ts"), "class User {}\nconst users = new User();\n").unwrap();
        std::fs::write(repo.join("src/user.spec.ts"), "new User()\n").unwrap();
        std::fs::write(repo.join("notes.md"), "a user\n").unwrap();
        std::fs::write(repo.join("logo.png"), b"user\0binary").unwrap();
        std::fs::write(repo.join("ignored.ts"), "User\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.ts\n").unwrap();
        git(repo, &["add", "src/user.ts"]).await;
        let registry = FindRegistry::default();

        let all = search(&registry, repo, &query("user"), 0.0).await.unwrap();
        assert_eq!(found(&all), vec![("notes.md", 1, "a user"), ("src/user.spec.ts", 1, "new User()"), ("src/user.ts", 1, "class User {}"), ("src/user.ts", 2, "const users = new User();")]);
        assert_eq!(all.matches[3].ranges.len(), 2);

        let exact = TextQuery { match_case: true, whole_words: true, file_mask: "*.ts, !*.spec.ts".to_string(), ..query("User") };
        assert_eq!(found(&search(&registry, repo, &exact, 0.0).await.unwrap()), vec![("src/user.ts", 1, "class User {}"), ("src/user.ts", 2, "const users = new User();")]);

        let regex = TextQuery { is_regex: true, ..query(r"^class \w+") };
        assert_eq!(found(&search(&registry, repo, &regex, 0.0).await.unwrap()), vec![("src/user.ts", 1, "class User {}")]);

        std::fs::write(repo.join("notes.md"), "no match\nanother user here\n").unwrap();
        std::fs::remove_file(repo.join("src/user.spec.ts")).unwrap();
        let edited = TextQuery { file_mask: "*.md, *.spec.ts".to_string(), ..query("user") };
        assert_eq!(found(&search(&registry, repo, &edited, 0.0).await.unwrap()), vec![("notes.md", 2, "another user here")]);

        assert_eq!(search(&registry, repo, &TextQuery { is_regex: true, ..query("(") }, 0.0).await, Err("failed to search: unclosed group".to_string()));
        assert!(search(&registry, repo, &query(""), 0.0).await.unwrap().matches.is_empty());
    }

    #[tokio::test]
    async fn search_stops_at_the_limit_in_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        for index in 0..200 {
            std::fs::write(repo.join(format!("f{index:03}.txt")), "hit\nhit\nhit\n").unwrap();
        }
        let result = search(&FindRegistry::default(), repo, &query("hit"), 0.0).await.unwrap();
        assert!(result.is_truncated);
        assert_eq!(result.matches.len(), MATCH_LIMIT);
        assert_eq!((result.matches[0].path.as_str(), result.matches[499].path.as_str(), result.matches[499].line), ("f000.txt", "f166.txt", 2));
    }

    #[tokio::test]
    async fn an_earlier_search_arriving_later_leaves_the_later_one_its_result() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        std::fs::write(repo.join("a.txt"), "hit\n").unwrap();
        let registry = FindRegistry::default();

        let later = registry.index(repo);
        let in_progress = RunningSearch::start(later, 2.0);
        assert!(search(&registry, repo, &query("hit"), 1.0).await.unwrap().matches.is_empty());
        drop(in_progress);
        assert_eq!(found(&search(&registry, repo, &query("hit"), 2.0).await.unwrap()), vec![("a.txt", 1, "hit")]);
        assert!(registry.index(repo).running.lock().unwrap().is_empty());
    }
}
