//! Attributes working-tree changes to the session whose tool call produced them. Sessions sharing a
//! worktree (a session and its sub sessions) cannot be told apart by git, so the worktree is snapshotted
//! as a tree object when a tool call that may write starts and again when it finishes; the paths that
//! differ are recorded as touched by the finishing session.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{SessionNotification, SessionUpdate, ToolCallStatus, ToolKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::git;
use crate::session::store;

/// Per-worktree snapshot state plus the in-flight tool calls that may write.
#[derive(Default)]
pub struct AttributionRegistry {
    trackers: Mutex<HashMap<PathBuf, Arc<WorktreeTracker>>>,
    /// Tool calls that may change files, keyed by session and tool call id; completion updates carry no kind.
    writing_calls: Mutex<HashSet<(Uuid, String)>>,
}

/// Snapshots of one worktree run one after the other; the lock holds the tree of the last snapshot.
#[derive(Default)]
struct WorktreeTracker {
    last_tree: tokio::sync::Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttributionEvent {
    worktree_path: PathBuf,
}

fn may_write(kind: ToolKind) -> bool {
    matches!(kind, ToolKind::Edit | ToolKind::Delete | ToolKind::Move | ToolKind::Execute | ToolKind::Other)
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

/// Snapshots `worktree` in the background. With `attribute_to`, every path that changed since the
/// previous snapshot is recorded as touched by that session and `attribution:changed` is emitted.
fn schedule(app: &AppHandle, worktree: &Path, attribute_to: Option<Uuid>) {
    let tracker = {
        let registry = app.state::<AttributionRegistry>();
        let mut trackers = registry.trackers.lock().unwrap();
        trackers.entry(worktree.to_path_buf()).or_default().clone()
    };
    let app = app.clone();
    let worktree = worktree.to_path_buf();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = snapshot(&app, &tracker, &worktree, attribute_to).await {
            eprintln!("change attribution in {} failed: {error}", worktree.display());
        }
    });
}

async fn snapshot(app: &AppHandle, tracker: &WorktreeTracker, worktree: &Path, attribute_to: Option<Uuid>) -> Result<(), String> {
    let mut last_tree = tracker.last_tree.lock().await;
    let tree = git::snapshot_tree(worktree).await?;

    if let (Some(previous), Some(session_id)) = (last_tree.as_deref(), attribute_to) {
        if previous != tree {
            let paths = git::changed_paths_between(worktree, previous, &tree).await?;
            store::add_touched_files(app, session_id, &paths)?;
            store::note_worktree_changed(app, session_id)?;
            let _ = app.emit("attribution:changed", AttributionEvent { worktree_path: worktree.to_path_buf() });
        }
    }

    *last_tree = Some(tree);
    Ok(())
}
