//! The commands of the built-in editor and of WebStorm: the worktree's project tree, files and deleted files, Find in
//! Files and the usage search, import resolution, Prettier and the ESLint rules, and opening the worktree, a file or the
//! changed files' diff in WebStorm.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use tauri::{AppHandle, State};
use uuid::Uuid;

use super::changes::{comparison_base, Comparison};
use super::{session_file, worktree_session};
use crate::agent::acp::bundled_script_path;
use crate::git;
use crate::ide;
use crate::ide::documents::DocumentRegistry;
use crate::ide::find_in_files::{self, FindRegistry, TextQuery, TextSearchResult};
use crate::ide::formatter::{self, PrettierOutput};
use crate::ide::lint_rules::{self, LintRules};
use crate::ide::workspace;

#[tauri::command]
pub async fn open_worktree_in_webstorm(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    ide::open_path(&record.worktree_path).await
}

/// Opens a worktree file in WebStorm with the caret on `line`:`column` (1-based).
#[tauri::command]
pub async fn open_file_in_webstorm(app: AppHandle, id: Uuid, path: String, line: u32, column: u32) -> Result<(), String> {
    let (record, target) = session_file(&app, id, &path)?;
    ide::open_path_at(&record.worktree_path, &target, line, column).await
}

/// Mirrors the base and current version of every changed file into a temp directory pair and opens
/// WebStorm's directory diff on them, which lists all changed files in a tree next to the diff.
/// The current side is a read-only copy: edits belong in the worktree, not in the snapshot.
#[tauri::command]
pub async fn open_changed_files_diff_in_webstorm(app: AppHandle, id: Uuid, comparison: Comparison) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let base = comparison_base(&record, comparison);
    let files = git::changed_files(&record.worktree_path, &base).await?;

    let snapshot_dir = std::env::temp_dir().join("hunt").join(id.to_string());
    let base_dir = snapshot_dir.join("base");
    let current_dir = snapshot_dir.join("current");
    for directory in [&base_dir, &current_dir] {
        if directory.exists() {
            std::fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
        }
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }

    for file in &files {
        if let Some(base_content) = git::show(&record.worktree_path, &base, &file.path).await {
            let target = base_dir.join(&file.path);
            create_parent_dir(&target)?;
            std::fs::write(&target, base_content).map_err(|error| error.to_string())?;
        }

        let current_path = record.worktree_path.join(&file.path);
        if !current_path.is_file() {
            continue;
        }
        let target = current_dir.join(&file.path);
        create_parent_dir(&target)?;
        std::fs::copy(&current_path, &target).map_err(|error| error.to_string())?;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).map_err(|error| error.to_string())?;
    }

    ide::open_diff(&base_dir, &current_dir).await
}

fn create_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Entries of a worktree directory for the project tree (`path` is relative; empty for the root).
#[tauri::command]
pub async fn list_dir(app: AppHandle, id: Uuid, path: String) -> Result<Vec<workspace::DirEntry>, String> {
    let (record, _) = session_file(&app, id, &path)?;
    workspace::list_dir(&record.worktree_path, &path)
}

/// Every project file of the worktree for the file search (⌘P / double shift).
#[tauri::command]
pub async fn list_files(app: AppHandle, id: Uuid) -> Result<Vec<String>, String> {
    let record = worktree_session(&app, id)?;
    git::list_files(&record.worktree_path).await
}

/// Worktree-relative paths below `dir` that a commit of the checked-out history deleted, such as replaced ADRs.
#[tauri::command]
pub async fn list_deleted_files(app: AppHandle, id: Uuid, dir: String) -> Result<Vec<String>, String> {
    let (record, _) = session_file(&app, id, &dir)?;
    git::deleted_files(&record.worktree_path, &dir).await
}

/// Text content of a worktree file for the built-in editor.
#[tauri::command]
pub async fn read_file(app: AppHandle, id: Uuid, path: String) -> Result<String, String> {
    let (record, _) = session_file(&app, id, &path)?;
    workspace::read_file(&record.worktree_path, &path)
}

/// `text` as the Prettier the worktree installs formats the file `path`; see `PrettierOutput` for files it leaves alone.
#[tauri::command]
pub async fn format_with_prettier(app: AppHandle, id: Uuid, path: String, text: String) -> Result<PrettierOutput, String> {
    let (record, file) = session_file(&app, id, &path)?;
    let script = bundled_script_path(&app, formatter::SCRIPT)?;
    formatter::format_with_prettier(&script, &record.worktree_path, &file, &text).await
}

/// The ESLint rules every `eslint.config.*` of the worktree sets, as the ESLint the worktree installs reads them.
#[tauri::command]
pub async fn read_lint_rules(app: AppHandle, id: Uuid) -> Result<LintRules, String> {
    let record = worktree_session(&app, id)?;
    let configs: Vec<String> = git::list_files(&record.worktree_path).await?.into_iter().filter(|path| lint_rules::is_config(path)).collect();
    let script = bundled_script_path(&app, lint_rules::SCRIPT)?;
    lint_rules::read_lint_rules(&script, &record.worktree_path, &configs).await
}

/// Worktree files containing `word` as a whole word, from the Find in Files index; candidates for the editor's usage search.
#[tauri::command]
pub async fn search_word(
    app: AppHandle,
    registry: State<'_, FindRegistry>,
    documents: State<'_, DocumentRegistry>,
    id: Uuid,
    word: String,
) -> Result<Vec<String>, String> {
    let record = worktree_session(&app, id)?;
    let is_identifier = !word.is_empty() && word.chars().all(|char| char.is_alphanumeric() || char == '_' || char == '$');
    if !is_identifier {
        return Err(format!("not an identifier: {word:?}"));
    }
    let query = TextQuery { text: word, match_case: true, whole_words: true, is_regex: false, file_mask: String::new() };
    let unsaved = documents.unsaved_texts(&record.worktree_path).await;
    find_in_files::files_containing(&registry, &record.worktree_path, &query, unsaved).await
}

/// Lines of worktree files matching `query`, for the editor's Find in Files; a file with unsaved edits is searched in its editor text.
#[tauri::command]
pub async fn find_in_files(
    app: AppHandle,
    registry: State<'_, FindRegistry>,
    documents: State<'_, DocumentRegistry>,
    id: Uuid,
    query: TextQuery,
    issued_at: f64,
) -> Result<TextSearchResult, String> {
    let record = worktree_session(&app, id)?;
    let unsaved = documents.unsaved_texts(&record.worktree_path).await;
    find_in_files::search(&registry, &record.worktree_path, &query, unsaved, issued_at).await
}

/// Resolves the relative import specifiers of `from` to worktree paths (`None` where no file matches).
#[tauri::command]
pub async fn resolve_imports(app: AppHandle, id: Uuid, from: String, specifiers: Vec<String>) -> Result<Vec<Option<String>>, String> {
    let (record, _) = session_file(&app, id, &from)?;
    workspace::resolve_imports(&record.worktree_path, &from, &specifiers)
}
