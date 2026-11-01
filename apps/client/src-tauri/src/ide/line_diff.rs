//! The line diff of the editors' change markers and of the diff views: imara-diff's Histogram algorithm with its line
//! postprocessing, over lines that keep their line break, so `\r\n` and `\n` differ and a last line without a break
//! differs from the same line with one. The markers diff the shared document (`ide/documents.rs`) against the file's
//! content at the diff base, which `BaseTexts` keeps as `head_text` last read it, so no text crosses IPC per edit; the
//! diff views send both texts (`diff_lines`).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use imara_diff::{Algorithm, Diff, InternedInput};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::git;
use crate::ide::documents::DocumentRegistry;
use crate::session::commands::session_file;

/// How many base contents `BaseTexts` keeps; the one stored longest ago goes first.
const BASE_TEXT_CAPACITY: usize = 64;

/// Lines `start..end` (1-based, `end` exclusive); `start == end` is an empty range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// Original lines `original` became modified lines `modified`; an empty side marks a pure insertion or deletion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ChangeBlock {
    pub original: LineRange,
    pub modified: LineRange,
}

/// The change blocks of `new` against `old` in document order. Myers like jsdiff before it: Histogram turns quadratic on
/// many scattered changes (181 ms against Myers' 0.7 ms on 20 000 lines with every third changed).
pub fn change_blocks(old: &str, new: &str) -> Vec<ChangeBlock> {
    let input = InternedInput::new(old, new);
    let mut diff = Diff::compute(Algorithm::Myers, &input);
    diff.postprocess_lines(&input);
    diff.hunks()
        .map(|hunk| ChangeBlock {
            original: LineRange { start: hunk.before.start + 1, end: hunk.before.end + 1 },
            modified: LineRange { start: hunk.after.start + 1, end: hunk.after.end + 1 },
        })
        .collect()
}

/// A file at a diff base of a worktree.
#[derive(Clone, PartialEq, Eq, Hash)]
struct BaseKey {
    worktree: PathBuf,
    base: String,
    path: String,
}

impl BaseKey {
    fn new(worktree: &Path, base: &str, path: &str) -> Self {
        Self { worktree: worktree.to_path_buf(), base: base.to_string(), path: path.to_string() }
    }
}

/// The content of files at their diff base (see `git::base_content`), as `head_text` last read it; the change markers
/// diff against it.
#[derive(Default)]
pub struct BaseTexts(Mutex<BaseCache>);

#[derive(Default)]
struct BaseCache {
    texts: HashMap<BaseKey, Option<Arc<str>>>,
    /// The keys of `texts`, the one stored longest ago first.
    order: VecDeque<BaseKey>,
}

impl BaseTexts {
    fn get(&self, key: &BaseKey) -> Option<Option<Arc<str>>> {
        self.0.lock().unwrap().texts.get(key).cloned()
    }

    fn insert(&self, key: BaseKey, text: Option<Arc<str>>) {
        let mut cache = self.0.lock().unwrap();
        cache.order.retain(|stored| stored != &key);
        cache.order.push_back(key.clone());
        cache.texts.insert(key, text);
        while cache.order.len() > BASE_TEXT_CAPACITY {
            if let Some(oldest) = cache.order.pop_front() {
                cache.texts.remove(&oldest);
            }
        }
    }

    /// Reads the base content of `key` from git and keeps it.
    async fn load(&self, key: BaseKey) -> Option<Arc<str>> {
        let text: Option<Arc<str>> = git::base_content(&key.worktree, &key.base, &key.path).await.map(Arc::from);
        self.insert(key, text.clone());
        text
    }
}

/// Diffs on a blocking thread, so a large file holds up no other command.
async fn diff_off_the_runtime(old: Arc<str>, new: String) -> Result<Vec<ChangeBlock>, String> {
    tauri::async_runtime::spawn_blocking(move || change_blocks(&old, &new))
        .await
        .map_err(|error| format!("failed to diff the lines: {error}"))
}

/// Content of `path` at the session's diff base: empty for a file the changes add, None for a file outside the changes.
/// Read afresh every time, it is also what the change markers of `document_change_blocks` diff against from now on.
#[tauri::command]
pub async fn head_text(app: AppHandle, id: Uuid, path: String) -> Result<Option<String>, String> {
    let (record, _) = session_file(&app, id, &path)?;
    let key = BaseKey::new(&record.worktree_path, record.diff_base(), &path);
    Ok(app.state::<BaseTexts>().load(key).await.map(|text| text.to_string()))
}

/// Change blocks of the shared document of `path` against its `head_text`, while the document is at `version` and
/// `length` UTF-16 code units long, as the window's model is; None otherwise (the window then diffs its own text with
/// `diff_lines`) and for a file outside the changes.
#[tauri::command]
pub async fn document_change_blocks(
    app: AppHandle,
    id: Uuid,
    path: String,
    version: i32,
    length: usize,
) -> Result<Option<Vec<ChangeBlock>>, String> {
    let (record, _) = session_file(&app, id, &path)?;
    let Some(text) = app.state::<DocumentRegistry>().text_at(&record.worktree_path, &path, version).await else {
        return Ok(None);
    };
    if text.encode_utf16().count() != length {
        return Ok(None);
    }
    let key = BaseKey::new(&record.worktree_path, record.diff_base(), &path);
    let base_texts = app.state::<BaseTexts>();
    let base = match base_texts.get(&key) {
        Some(base) => base,
        None => base_texts.load(key).await,
    };
    let Some(base) = base else {
        return Ok(None);
    };
    diff_off_the_runtime(base, text).await.map(Some)
}

/// Change blocks of `new_text` against `old_text`, for views that hold both texts.
#[tauri::command]
pub async fn diff_lines(old_text: String, new_text: String) -> Result<Vec<ChangeBlock>, String> {
    diff_off_the_runtime(Arc::from(old_text), new_text).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(original: (u32, u32), modified: (u32, u32)) -> ChangeBlock {
        ChangeBlock { original: LineRange { start: original.0, end: original.1 }, modified: LineRange { start: modified.0, end: modified.1 } }
    }

    fn lines(count: usize) -> String {
        (1..=count).map(|index| format!("line {index}\n")).collect()
    }

    #[test]
    fn a_pure_insertion_has_an_empty_original_range() {
        assert_eq!(change_blocks("a\nb\n", "a\nx\ny\nb\n"), [block((2, 2), (2, 4))]);
    }

    #[test]
    fn removed_and_added_lines_form_one_modification() {
        assert_eq!(change_blocks("a\nb\nc\n", "a\nB\nc\n"), [block((2, 3), (2, 3))]);
    }

    #[test]
    fn a_deletion_at_the_end_has_an_empty_modified_range() {
        assert_eq!(change_blocks("a\nb\n", "a\n"), [block((2, 3), (2, 2))]);
    }

    #[test]
    fn several_blocks_come_in_document_order() {
        let original = lines(12);
        let modified = original.replace("line 2\n", "").replace("line 6", "LINE 6").replace("line 10\n", "line 10\nnew\n");
        assert_eq!(change_blocks(&original, &modified), [block((2, 3), (2, 2)), block((6, 7), (5, 6)), block((11, 11), (10, 11))]);
    }

    #[test]
    fn identical_and_empty_texts_have_no_blocks() {
        assert_eq!(change_blocks("a\nb\n", "a\nb\n"), []);
        assert_eq!(change_blocks("", ""), []);
        assert_eq!(change_blocks("", "x\ny"), [block((1, 1), (1, 3))]);
        assert_eq!(change_blocks("x\ny", ""), [block((1, 3), (1, 1))]);
    }

    #[test]
    fn line_breaks_belong_to_their_line() {
        assert_eq!(change_blocks("a\nb", "a\nb\n"), [block((2, 3), (2, 3))]);
        assert_eq!(change_blocks("a\nb", "a\nb\nx"), [block((2, 3), (2, 4))]);
        assert_eq!(change_blocks("a\r\nb\r\n", "a\r\nB\r\n"), [block((2, 3), (2, 3))]);
        assert_eq!(change_blocks("a\r\nb\r\n", "a\nb\r\n"), [block((1, 2), (1, 2))]);
        assert_eq!(change_blocks("a\rb\n", "a\rc\n"), [block((1, 2), (1, 2))]);
    }

    #[test]
    fn an_ambiguous_insertion_ends_where_the_indentation_suggests() {
        let original = "fn a() {\n    one();\n}\n\nfn c() {\n    three();\n}\n";
        let modified = "fn a() {\n    one();\n}\n\nfn b() {\n    two();\n}\n\nfn c() {\n    three();\n}\n";
        assert_eq!(change_blocks(original, modified), [block((5, 5), (5, 9))]);
    }

    #[test]
    fn the_base_cache_drops_the_oldest_entry() {
        let cache = BaseTexts::default();
        let key = |index: usize| BaseKey::new(Path::new("/worktree"), "HEAD", &format!("file-{index}"));
        for index in 0..=BASE_TEXT_CAPACITY {
            cache.insert(key(index), Some(Arc::from(index.to_string())));
        }
        cache.insert(key(1), None);
        cache.insert(key(BASE_TEXT_CAPACITY + 1), None);

        assert_eq!(cache.get(&key(0)), None);
        assert_eq!(cache.get(&key(2)), None);
        assert_eq!(cache.get(&key(1)), Some(None));
        assert_eq!(cache.get(&key(3)).flatten().as_deref(), Some("3"));
    }
}
