//! Full-text search over a worktree for the editor's "Find in Files" (⇧⌘F), run through `git grep`: tracked and
//! untracked files are searched in their working-tree state, ignored and binary files are skipped.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

/// Matching lines reported at most; the search stops there and says so.
const MATCH_LIMIT: usize = 500;
/// Characters of a matching line shown before its first match once the line is cut at the front.
const PREVIEW_LEAD: usize = 40;
/// Characters a preview keeps at most, measured from where it starts.
const PREVIEW_LENGTH: usize = 300;
/// The escape sequence `git grep` writes before a match with `color.grep.match=reverse`; `ESC[m` ends it.
const MATCH_START: &str = "7";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextQuery {
    pub text: String,
    pub match_case: bool,
    pub whole_words: bool,
    /// `text` is a Perl-compatible regular expression instead of a literal string.
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchResult {
    pub matches: Vec<TextMatch>,
    /// More lines matched than `matches` holds.
    pub is_truncated: bool,
}

/// Searches the worktree for `query`; at most `MATCH_LIMIT` lines, in path and line order.
pub async fn search(worktree: &Path, query: &TextQuery) -> Result<TextSearchResult, String> {
    if query.text.is_empty() {
        return Ok(TextSearchResult { matches: Vec::new(), is_truncated: false });
    }
    let mut args: Vec<String> = [
        "-c",
        "color.grep.match=reverse",
        "-c",
        "color.grep.filename=normal",
        "-c",
        "color.grep.lineNumber=normal",
        "-c",
        "color.grep.column=normal",
        "-c",
        "color.grep.separator=normal",
        "grep",
        "--color=always",
        "-I",
        "-n",
        "-z",
        "--untracked",
        if query.is_regex { "-P" } else { "-F" },
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    if !query.match_case {
        args.push("-i".to_string());
    }
    if query.whole_words {
        args.push("-w".to_string());
    }
    args.extend(["-e".to_string(), query.text.clone(), "--".to_string()]);
    args.extend(pathspecs(&query.file_mask));

    let mut child = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to run git grep: {error}"))?;
    let stdout = child.stdout.take().ok_or("failed to read git grep: no output")?;
    let mut stderr = child.stderr.take().ok_or("failed to read git grep: no error output")?;
    // Read alongside stdout, so a full stderr pipe cannot stall git.
    let errors = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let mut reader = BufReader::new(stdout);

    let mut matches = Vec::new();
    let mut record = Vec::new();
    loop {
        record.clear();
        let read = reader.read_until(b'\n', &mut record).await.map_err(|error| format!("failed to read git grep: {error}"))?;
        if read == 0 {
            break;
        }
        if matches.len() == MATCH_LIMIT {
            return Ok(TextSearchResult { matches, is_truncated: true });
        }
        if let Some(found) = parse_record(&String::from_utf8_lossy(&record)) {
            matches.push(found);
        }
    }

    let stderr = errors.await.unwrap_or_default();
    let status = child.wait().await.map_err(|error| format!("failed to run git grep: {error}"))?;
    // Exit code 1 means nothing matched.
    if !status.success() && status.code() != Some(1) {
        let message = stderr.trim().trim_start_matches("fatal: ");
        return Err(format!("failed to search: {message}"));
    }
    Ok(TextSearchResult { matches, is_truncated: false })
}

/// The pathspecs of a file mask: `*.ts` matches the file name in every folder, `!*.spec.ts` excludes, and a mask
/// with `/` matches the whole worktree-relative path.
fn pathspecs(file_mask: &str) -> Vec<String> {
    file_mask
        .split(',')
        .map(str::trim)
        .filter(|mask| !mask.is_empty() && *mask != "!")
        .map(|mask| {
            let (magic, pattern) = match mask.strip_prefix('!') {
                Some(pattern) => ("exclude,glob", pattern.trim()),
                None => ("glob", mask),
            };
            if pattern.contains('/') {
                format!(":({magic}){}", pattern.trim_start_matches('/'))
            } else {
                format!(":({magic})**/{pattern}")
            }
        })
        .collect()
}

/// Parses one `<path>\0<line>\0<colored content>\n` record of `git grep -n -z --color=always`.
fn parse_record(record: &str) -> Option<TextMatch> {
    let mut parts = record.splitn(3, '\0');
    let path = parts.next()?.to_string();
    let line = parts.next()?.parse().ok()?;
    let content = parts.next()?.trim_end_matches(['\n', '\r']);

    let (chars, ranges) = strip_colors(content);
    let first = *ranges.first()?;
    // `offsets[index]` is the UTF-16 offset of `chars[index]`; the last entry is the line's length.
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0u32;
    for char in &chars {
        offsets.push(offset);
        offset += char.len_utf16() as u32;
    }
    offsets.push(offset);

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
    let ranges = ranges
        .iter()
        .filter(|(from, to)| *to > start && *from < end)
        .map(|(from, to)| TextRange { start: offsets[(*from).max(start)] - base, end: offsets[(*to).min(end)] - base })
        .collect();

    Some(TextMatch { path, line, column: offsets[first.0] + 1, end_column: offsets[first.1] + 1, preview, ranges })
}

/// The characters of `content` without its escape sequences, and the character ranges `git grep` colored as matches.
fn strip_colors(content: &str) -> (Vec<char>, Vec<(usize, usize)>) {
    let mut chars = Vec::new();
    let mut ranges = Vec::new();
    let mut match_start = None;
    let mut rest = content.chars().peekable();
    while let Some(char) = rest.next() {
        if char != '\u{1b}' || rest.peek() != Some(&'[') {
            chars.push(char);
            continue;
        }
        rest.next();
        let mut parameters = String::new();
        for next in rest.by_ref() {
            if next.is_ascii_alphabetic() {
                break;
            }
            parameters.push(next);
        }
        if parameters == MATCH_START {
            match_start = Some(chars.len());
        } else if let Some(start) = match_start.take() {
            if chars.len() > start {
                ranges.push((start, chars.len()));
            }
        }
    }
    (chars, ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: &str) -> TextQuery {
        TextQuery { text: text.to_string(), match_case: false, whole_words: false, is_regex: false, file_mask: String::new() }
    }

    async fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(repo).args(args).status().await.unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn found(result: &TextSearchResult) -> Vec<(&str, u32, &str)> {
        result.matches.iter().map(|found| (found.path.as_str(), found.line, found.preview.as_str())).collect()
    }

    #[test]
    fn parse_record_reads_position_preview_and_ranges() {
        let found = parse_record("src/a.ts\x0012\x00    const \x1b[7mPrivate\x1b[m = \x1b[7mprivate\x1b[m;\n").unwrap();
        assert_eq!((found.path.as_str(), found.line, found.column, found.end_column), ("src/a.ts", 12, 11, 18));
        assert_eq!(found.preview, "const Private = private;");
        assert_eq!(found.ranges, vec![TextRange { start: 6, end: 13 }, TextRange { start: 16, end: 23 }]);
    }

    #[test]
    fn parse_record_counts_utf16_units_and_cuts_long_lines() {
        let found = parse_record("a.md\x001\x00😀 \x1b[7mx\x1b[m\n").unwrap();
        assert_eq!((found.column, found.end_column), (4, 5));
        assert_eq!(found.ranges, vec![TextRange { start: 3, end: 4 }]);

        let long = format!("a.js\x001\x00{}\x1b[7mneedle\x1b[m{}\n", "a".repeat(100), "b".repeat(400));
        let found = parse_record(&long).unwrap();
        assert_eq!(found.column, 101);
        assert!(found.preview.starts_with('…') && found.preview.ends_with('…'));
        assert_eq!(found.ranges, vec![TextRange { start: 41, end: 47 }]);
        assert_eq!(&found.preview[41 + 2..47 + 2], "needle");
    }

    #[test]
    fn pathspecs_match_file_names_everywhere_and_exclude_with_a_bang() {
        assert_eq!(pathspecs(""), Vec::<String>::new());
        assert_eq!(pathspecs("*.ts, !*.spec.ts,src/**/*.md"), vec![":(glob)**/*.ts", ":(exclude,glob)**/*.spec.ts", ":(glob)src/**/*.md"]);
    }

    #[tokio::test]
    async fn search_finds_tracked_and_untracked_files_with_the_query_options() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        std::fs::create_dir(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/user.ts"), "class User {}\nconst users = new User();\n").unwrap();
        std::fs::write(repo.join("src/user.spec.ts"), "new User()\n").unwrap();
        std::fs::write(repo.join("notes.md"), "a user\n").unwrap();
        std::fs::write(repo.join("ignored.ts"), "User\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.ts\n").unwrap();
        git(repo, &["add", "src/user.ts"]).await;

        let all = search(repo, &query("user")).await.unwrap();
        assert_eq!(found(&all), vec![("notes.md", 1, "a user"), ("src/user.spec.ts", 1, "new User()"), ("src/user.ts", 1, "class User {}"), ("src/user.ts", 2, "const users = new User();")]);
        assert_eq!(all.matches[3].ranges.len(), 2);

        let exact = TextQuery { match_case: true, whole_words: true, file_mask: "*.ts, !*.spec.ts".to_string(), ..query("User") };
        assert_eq!(found(&search(repo, &exact).await.unwrap()), vec![("src/user.ts", 1, "class User {}"), ("src/user.ts", 2, "const users = new User();")]);

        let regex = TextQuery { is_regex: true, ..query(r"class \w+") };
        assert_eq!(found(&search(repo, &regex).await.unwrap()), vec![("src/user.ts", 1, "class User {}")]);

        assert!(search(repo, &TextQuery { is_regex: true, ..query("(") }).await.is_err());
        assert!(search(repo, &query("")).await.unwrap().matches.is_empty());
    }
}
