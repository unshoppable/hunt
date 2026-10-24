//! Attributes working-tree changes to the session whose tool call produced them. Sessions sharing a
//! worktree (a session and its sub sessions) cannot be told apart by git, so the worktree is snapshotted
//! as a tree object when a tool call that may write starts and again when it finishes; the paths that
//! differ are recorded as touched by the finishing session.
//!
//! Every snapshot that differs from the previous one is appended to the worktree's edit log, together with
//! the session that made the difference (`None` for changes made between tool calls). The log and the
//! snapshot objects live in Hunt's app data, never in the repository; replaying a file through the log tells
//! which session wrote which of its lines.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{SessionNotification, SessionUpdate, ToolCallStatus, ToolKind};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::git;
use crate::session::store;

/// Oldest entries are dropped beyond this many; a file history then starts at the oldest kept snapshot.
const MAX_LOG_ENTRIES: usize = 2000;

/// Per-worktree snapshot state plus the in-flight tool calls that may write.
#[derive(Default)]
pub struct AttributionRegistry {
    trackers: Mutex<HashMap<PathBuf, Arc<WorktreeTracker>>>,
    /// Tool calls that may change files, keyed by session and tool call id; completion updates carry no kind.
    writing_calls: Mutex<HashSet<(Uuid, String)>>,
}

/// Snapshots of one worktree run one after the other; the lock holds the edit log, loaded on first use.
#[derive(Default)]
struct WorktreeTracker {
    log: tokio::sync::Mutex<Option<EditLog>>,
}

/// One snapshot of the edit log: `session_id` made the changes since the previous entry.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditEntry {
    session_id: Option<Uuid>,
    tree: String,
}

struct EditLog {
    dir: PathBuf,
    store: git::SnapshotStore,
    entries: Vec<EditEntry>,
}

impl EditLog {
    async fn open(app: &AppHandle, worktree: &Path) -> Result<Self, String> {
        let dir = edit_log_dir(app, worktree)?;
        let store = git::SnapshotStore::open(worktree, &dir.join("objects")).await?;
        let entries = match std::fs::read_to_string(dir.join("log.json")) {
            Ok(text) => serde_json::from_str(&text).map_err(|error| format!("failed to read the edit log: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("failed to read the edit log: {error}")),
        };
        Ok(Self { dir, store, entries })
    }

    fn append(&mut self, entry: EditEntry) -> Result<(), String> {
        self.entries.push(entry);
        if self.entries.len() > MAX_LOG_ENTRIES {
            self.entries.drain(..self.entries.len() - MAX_LOG_ENTRIES);
        }
        let text = serde_json::to_string(&self.entries).map_err(|error| format!("failed to write the edit log: {error}"))?;
        let temp = self.dir.join("log.json.tmp");
        std::fs::write(&temp, text).map_err(|error| format!("failed to write the edit log: {error}"))?;
        std::fs::rename(&temp, self.dir.join("log.json")).map_err(|error| format!("failed to write the edit log: {error}"))
    }
}

/// One version of a file in the edit log: its content (`None` when it did not exist) and the session that
/// produced it (`None` for the oldest version and for changes made between tool calls).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    session_id: Option<Uuid>,
    content: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttributionEvent {
    worktree_path: PathBuf,
}

fn may_write(kind: ToolKind) -> bool {
    matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move | ToolKind::Execute | ToolKind::Other)
}

/// Folder of the edit logs in the app data folder.
const EDIT_LOG_DIR: &str = "edit-log";

/// The name of the edit log directory of `worktree`: a UUID derived from the worktree path.
fn edit_log_name(worktree: &Path) -> String {
    Uuid::new_v5(&Uuid::NAMESPACE_URL, worktree.to_string_lossy().as_bytes()).to_string()
}

/// The edit log directory of `worktree` in the app data.
fn edit_log_dir(app: &AppHandle, worktree: &Path) -> Result<PathBuf, String> {
    let dir = store::app_data_dir(app)?.join(EDIT_LOG_DIR).join(edit_log_name(worktree));
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create the edit log: {error}"))?;
    Ok(dir)
}

/// Inspects one `session/update` of `session_id` and schedules the snapshots it calls for.
pub fn observe(app: &AppHandle, session_id: Uuid, worktree: &Path, notification: &SessionNotification) {
    let registry = app.state::<AttributionRegistry>();
    match &notification.update {
        SessionUpdate::ToolCall(tool_call) if may_write(tool_call.kind) => {
            registry.writing_calls.lock().unwrap().insert((session_id, tool_call.tool_call_id.to_string()));
            schedule(app, worktree, None);
        }
        SessionUpdate::ToolCallUpdate(update)
            if matches!(update.fields.status, Some(ToolCallStatus::Completed | ToolCallStatus::Failed)) =>
        {
            let key = (session_id, update.tool_call_id.to_string());
            if registry.writing_calls.lock().unwrap().remove(&key) {
                schedule(app, worktree, Some(session_id));
            }
        }
        _ => {}
    }
}

/// Drops the in-flight tool calls of a session whose agent stopped.
pub fn forget_session(app: &AppHandle, session_id: Uuid) {
    app.state::<AttributionRegistry>().writing_calls.lock().unwrap().retain(|(id, _)| *id != session_id);
}

/// Renames the edit log in `data_dir` of a worktree that moved from `from` to `to`; does nothing when it has none.
pub fn relocate_edit_log(data_dir: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let logs = data_dir.join(EDIT_LOG_DIR);
    let source = logs.join(edit_log_name(from));
    let target = logs.join(edit_log_name(to));
    if !source.is_dir() || target.exists() {
        return Ok(());
    }
    std::fs::rename(&source, &target).map_err(|error| format!("failed to move the edit log of {}: {error}", from.display()))
}

/// Deletes the edit log of `worktree` once no session works in it any more.
pub fn forget_worktree(app: &AppHandle, worktree: &Path) -> Result<(), String> {
    app.state::<AttributionRegistry>().trackers.lock().unwrap().remove(worktree);
    let dir = edit_log_dir(app, worktree)?;
    std::fs::remove_dir_all(&dir).map_err(|error| format!("failed to delete the edit log: {error}"))
}

/// Runs `write`, a change to `worktree` made on behalf of `session_id` outside its agent, between two snapshots,
/// so the change counts as the session's own. A failed snapshot is logged and does not fail the write.
pub async fn record_write(app: &AppHandle, worktree: &Path, session_id: Uuid, write: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let tracker = tracker(app, worktree);
    if let Err(error) = snapshot(app, &tracker, worktree, None).await {
        eprintln!("change attribution in {} failed: {error}", worktree.display());
    }
    write()?;
    if let Err(error) = snapshot(app, &tracker, worktree, Some(session_id)).await {
        eprintln!("change attribution in {} failed: {error}", worktree.display());
    }
    Ok(())
}

/// The versions of `path` in the edit log of `worktree`, oldest first; consecutive equal versions count once.
pub async fn file_history(app: &AppHandle, worktree: &Path, path: &str) -> Result<Vec<FileVersion>, String> {
    let tracker = tracker(app, worktree);
    let mut guard = tracker.log.lock().await;
    let log = loaded(app, worktree, &mut guard).await?;
    if log.entries.is_empty() {
        return Ok(Vec::new());
    }

    let trees: Vec<String> = log.entries.iter().map(|entry| entry.tree.clone()).collect();
    let ids = git::blob_ids_at(worktree, &log.store, &trees, path).await?;
    let mut versions = Vec::new();
    let mut contents: HashMap<String, String> = HashMap::new();
    for (index, id) in ids.iter().enumerate() {
        if index > 0 && ids[index - 1] == *id {
            continue;
        }
        let content = match id {
            Some(id) => {
                if !contents.contains_key(id) {
                    contents.insert(id.clone(), git::read_blob(worktree, &log.store, id).await?);
                }
                contents.get(id).cloned()
            }
            None => None,
        };
        let session_id = if index == 0 { None } else { log.entries[index].session_id };
        versions.push(FileVersion { session_id, content });
    }
    Ok(versions)
}

/// The edit log behind a tracker's lock, read from disk on first use.
async fn loaded<'a>(app: &AppHandle, worktree: &Path, slot: &'a mut Option<EditLog>) -> Result<&'a mut EditLog, String> {
    match slot {
        Some(log) => Ok(log),
        None => Ok(slot.insert(EditLog::open(app, worktree).await?)),
    }
}

fn tracker(app: &AppHandle, worktree: &Path) -> Arc<WorktreeTracker> {
    let registry = app.state::<AttributionRegistry>();
    let mut trackers = registry.trackers.lock().unwrap();
    trackers.entry(worktree.to_path_buf()).or_default().clone()
}

/// Snapshots `worktree` in the background. With `attribute_to`, every path that changed since the
/// previous snapshot is recorded as touched by that session and `attribution:changed` is emitted.
fn schedule(app: &AppHandle, worktree: &Path, attribute_to: Option<Uuid>) {
    let tracker = tracker(app, worktree);
    let app = app.clone();
    let worktree = worktree.to_path_buf();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = snapshot(&app, &tracker, &worktree, attribute_to).await {
            eprintln!("change attribution in {} failed: {error}", worktree.display());
        }
    });
}

async fn snapshot(app: &AppHandle, tracker: &WorktreeTracker, worktree: &Path, attribute_to: Option<Uuid>) -> Result<(), String> {
    let mut guard = tracker.log.lock().await;
    let log = loaded(app, worktree, &mut guard).await?;
    let tree = git::snapshot_tree(worktree, &log.store).await?;
    let previous = log.entries.last().map(|entry| entry.tree.clone());
    if previous.as_deref() == Some(tree.as_str()) {
        return Ok(());
    }

    if let (Some(previous), Some(session_id)) = (previous.as_deref(), attribute_to) {
        let paths = git::changed_paths_between(worktree, &log.store, previous, &tree).await?;
        store::add_touched_files(app, session_id, &paths)?;
        store::note_worktree_changed(app, session_id)?;
        let _ = app.emit("attribution:changed", AttributionEvent { worktree_path: worktree.to_path_buf() });
    }

    log.append(EditEntry { session_id: previous.and(attribute_to), tree })
}
