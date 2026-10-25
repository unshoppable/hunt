//! Watches the worktree of every live session for changes made outside Hunt — an editor, a terminal, another agent —
//! and tells the UI (`worktree:changed`), so the changelist follows the disk without a reload or a session switch.
//! One watch per worktree, since sub sessions and sessions on a checkout share one. Hunt's own folders and paths git
//! ignores stay silent (a build writing `dist/` would reload the changelist every `DEBOUNCE` otherwise); a moved
//! `HEAD` (a commit, reset or checkout from a terminal) counts, since it changes the changelist without touching a file.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::git;

/// How long a burst of changes (a `git apply`, a checkout, a build) settles before the UI hears of it once.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// The running watches by worktree, each with the sessions that need it; dropping a debouncer stops watching.
#[derive(Default)]
pub struct WorktreeWatchers(Mutex<HashMap<PathBuf, WorktreeWatch>>);

struct WorktreeWatch {
    sessions: HashSet<Uuid>,
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

/// Payload of `worktree:changed` (mirror of `WorktreeChangedEvent` in src/ipc/types.ts).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeChangedEvent {
    worktree_path: PathBuf,
}

/// Has session `id` share the watch of `worktree`, which starts with its first session.
pub fn watch(app: &AppHandle, registry: &WorktreeWatchers, id: Uuid, worktree: &Path) -> Result<(), String> {
    let mut watches = registry.0.lock().unwrap();
    if let Some(watch) = watches.get_mut(worktree) {
        watch.sessions.insert(id);
        return Ok(());
    }
    let debouncer = start(app.clone(), worktree)?;
    watches.insert(worktree.to_path_buf(), WorktreeWatch { sessions: HashSet::from([id]), _debouncer: debouncer });
    Ok(())
}

/// Takes session `id` off its watch, which ends with its last session.
pub fn unwatch(registry: &WorktreeWatchers, id: Uuid) {
    let mut watches = registry.0.lock().unwrap();
    for watch in watches.values_mut() {
        watch.sessions.remove(&id);
    }
    watches.retain(|_, watch| !watch.sessions.is_empty());
}

/// Watches `worktree` recursively, plus the reflog of its `HEAD`, and reports every settled batch that shows in the
/// changelist. Without a file ID cache: filling it reads every file of the worktree, `node_modules` included.
fn start(app: AppHandle, worktree: &Path) -> Result<Debouncer<RecommendedWatcher, NoCache>, String> {
    let root = worktree.to_path_buf();
    let reflogs = git::git_dir_of(worktree).map(|git_dir| git_dir.join("logs"));
    let head_reflog = reflogs.as_ref().map(|reflogs| reflogs.join("HEAD"));
    let on_events = move |result: DebounceEventResult| {
        let Ok(events) = result else {
            // The watcher lost track of what changed, so the changelist rather reloads once too often.
            emit(&app, &root);
            return;
        };
        let moved_head = events.iter().flat_map(|event| &event.paths).any(|path| head_reflog.as_ref() == Some(path));
        if moved_head {
            emit(&app, &root);
            return;
        }
        let paths: BTreeSet<String> =
            events.iter().flat_map(|event| &event.paths).filter_map(|path| git::worktree_change_path(&root, path)).collect();
        if paths.is_empty() {
            return;
        }
        let app = app.clone();
        let root = root.clone();
        tauri::async_runtime::spawn(async move {
            if shows_in_changelist(&root, paths).await {
                emit(&app, &root);
            }
        });
    };
    let failed = |error: notify::Error| format!("failed to watch the worktree {}: {error}", worktree.display());
    let mut debouncer =
        new_debouncer_opt::<_, RecommendedWatcher, _>(DEBOUNCE, None, on_events, NoCache, notify::Config::default()).map_err(failed)?;
    debouncer.watch(worktree, RecursiveMode::Recursive).map_err(failed)?;
    if let Some(reflogs) = reflogs.filter(|reflogs| reflogs.is_dir()) {
        debouncer.watch(&reflogs, RecursiveMode::NonRecursive).map_err(failed)?;
    }
    Ok(debouncer)
}

/// Whether a change at one of `paths` (worktree-relative) shows in the changelist of `worktree`: at least one of them
/// matches no ignore rule. A tracked file an ignore rule matches (a force-added one) is missed; a failed lookup counts
/// as a change, so the changelist rather reloads once too often.
async fn shows_in_changelist(worktree: &Path, paths: BTreeSet<String>) -> bool {
    let paths: Vec<String> = paths.into_iter().collect();
    match git::ignore_rules(worktree, &paths).await {
        Ok(ignored) => paths.iter().any(|path| !ignored.contains_key(path)),
        Err(error) => {
            eprintln!("checking which changed paths of {} git ignores failed: {error}", worktree.display());
            true
        }
    }
}

/// Tells every window that `worktree` changed; the store reloads the changes of its sessions.
fn emit(app: &AppHandle, worktree: &Path) {
    let _ = app.emit("worktree:changed", WorktreeChangedEvent { worktree_path: worktree.to_path_buf() });
}
