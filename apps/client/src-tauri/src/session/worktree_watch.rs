//! Watches the worktree of every live session for changes made outside Hunt — an editor, a terminal, another agent —
//! and tells the UI (`worktree:changed`), so the changelist follows the disk without a reload or a session switch.
//! One subscription per worktree (to `git/worktree_watcher.rs`, whose watch the language servers share), since sub
//! sessions and sessions on a checkout share one. Hunt's own folders and paths git ignores stay silent (a build writing
//! `dist/` would reload the changelist every `SETTLE` otherwise); a moved `HEAD` (a commit, reset or checkout from a
//! terminal) counts, since it changes the changelist without touching a file. The event names the changed paths, so
//! the project tree and the documents refresh only what they hold of them; it names none when the watcher lost track,
//! `HEAD` moved or more than `MAX_REPORTED_PATHS` changed, and everything counts as changed then.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::notify::event::ModifyKind;
use notify_debouncer_full::notify::EventKind;
use notify_debouncer_full::DebounceEventResult;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::git;
use crate::git::worktree_watcher::{self, WatchSubscription};

/// How long the batches of a burst of changes (a `git apply`, a checkout, a build) are gathered after the first one
/// before the UI hears of them once; with the watch's own `DEBOUNCE`, about 400 ms after the first change.
const SETTLE: Duration = Duration::from_millis(300);

/// The most paths an event names; above it everything counts as changed, which is cheaper than refreshing path by path.
const MAX_REPORTED_PATHS: usize = 1000;

/// The running watches by worktree, each with the sessions that need it; dropping a subscription stops watching.
#[derive(Default)]
pub struct WorktreeWatchers(Mutex<HashMap<PathBuf, WorktreeWatch>>);

struct WorktreeWatch {
    sessions: HashSet<Uuid>,
    _subscription: WatchSubscription,
}

/// Payload of `worktree:changed` (mirror of `WorktreeChangedEvent` in src/sessions/session.types.ts); `changes` is
/// `None` when anything may have changed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeChangedEvent {
    worktree_path: PathBuf,
    changes: Option<PathChanges>,
}

/// The paths a `worktree:changed` names (mirror of `WorktreePathChanges` in src/sessions/session.types.ts): every
/// changed worktree-relative path outside `.git`, and those among them that were created, removed or renamed, which
/// changes the listing of their folder.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PathChanges {
    paths: Vec<String>,
    entry_paths: Vec<String>,
}

/// Has session `id` share the watch of `worktree`, which starts with its first session.
pub fn watch(app: &AppHandle, registry: &WorktreeWatchers, id: Uuid, worktree: &Path) -> Result<(), String> {
    let mut watches = registry.0.lock().unwrap();
    if let Some(watch) = watches.get_mut(worktree) {
        watch.sessions.insert(id);
        return Ok(());
    }
    let subscription = start(app.clone(), worktree)?;
    watches.insert(worktree.to_path_buf(), WorktreeWatch { sessions: HashSet::from([id]), _subscription: subscription });
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

/// What the batches gathered within one `SETTLE` changed in a worktree.
#[derive(Debug, Default, PartialEq)]
struct Changes {
    /// Anything may have changed: the watcher lost track or must rescan, or `HEAD` moved.
    is_everything: bool,
    /// The changed worktree-relative paths outside `.git`, each with whether it was created, removed or renamed.
    paths: BTreeMap<String, bool>,
}

impl Changes {
    /// The changes of one batch of the watch of `root`, whose `HEAD` keeps its reflog at `head_reflog`.
    fn of(root: &Path, head_reflog: Option<&Path>, result: &DebounceEventResult) -> Changes {
        let mut changes = Changes::default();
        let Ok(events) = result else {
            changes.is_everything = true;
            return changes;
        };
        for event in events {
            if event.need_rescan() || event.paths.iter().any(|path| Some(path.as_path()) == head_reflog) {
                changes.is_everything = true;
                continue;
            }
            if matches!(event.kind, EventKind::Access(_)) {
                continue;
            }
            let is_entry = !matches!(event.kind, EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)));
            for path in event.paths.iter().filter_map(|path| relative_path(root, path)) {
                *changes.paths.entry(path).or_default() |= is_entry;
            }
        }
        changes
    }

    fn is_empty(&self) -> bool {
        !self.is_everything && self.paths.is_empty()
    }

    fn merge(&mut self, other: Changes) {
        self.is_everything |= other.is_everything;
        for (path, is_entry) in other.paths {
            *self.paths.entry(path).or_default() |= is_entry;
        }
    }

    /// The paths that may show in the changelist: those outside Hunt's own and the dependency folders.
    fn changelist_paths(&self, root: &Path) -> BTreeSet<String> {
        self.paths.keys().filter(|path| git::worktree_change_path(root, &root.join(path)).is_some()).cloned().collect()
    }

    /// What the event names: None when anything may have changed or the paths are too many to name.
    fn reported(&self) -> Option<PathChanges> {
        if self.is_everything || self.paths.len() > MAX_REPORTED_PATHS {
            return None;
        }
        let entry_paths = self.paths.iter().filter(|(_, is_entry)| **is_entry).map(|(path, _)| path.clone()).collect();
        Some(PathChanges { paths: self.paths.keys().cloned().collect(), entry_paths })
    }
}

/// The worktree-relative form of `path`; None outside the worktree, for the worktree itself and inside `.git`.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.components().any(|component| component == Component::Normal(".git".as_ref())) {
        return None;
    }
    relative.to_str().filter(|relative| !relative.is_empty()).map(str::to_string)
}

/// Subscribes to the watch of `worktree` and reports the batches gathered within each `SETTLE` that show in the
/// changelist.
fn start(app: AppHandle, worktree: &Path) -> Result<WatchSubscription, String> {
    let root = worktree.to_path_buf();
    let head_reflog = git::git_dir_of(worktree).map(|git_dir| git_dir.join("logs").join("HEAD"));
    let gathered: Arc<Mutex<Option<Changes>>> = Arc::default();
    worktree_watcher::subscribe(worktree, move |result| {
        let changes = Changes::of(&root, head_reflog.as_deref(), result);
        if changes.is_empty() {
            return;
        }
        {
            let mut gathered = gathered.lock().unwrap();
            if let Some(earlier) = gathered.as_mut() {
                earlier.merge(changes);
                return;
            }
            *gathered = Some(changes);
        }
        let (app, root, gathered) = (app.clone(), root.clone(), gathered.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SETTLE).await;
            let Some(changes) = gathered.lock().unwrap().take() else { return };
            report(&app, &root, changes).await;
        });
    })
}

/// Tells every window about `changes` unless none of them shows in the changelist; the store reloads the changes of
/// the worktree's sessions.
async fn report(app: &AppHandle, root: &Path, changes: Changes) {
    if !changes.is_everything {
        let paths = changes.changelist_paths(root);
        if paths.is_empty() || !shows_in_changelist(root, paths).await {
            return;
        }
    }
    let _ = app.emit("worktree:changed", WorktreeChangedEvent { worktree_path: root.to_path_buf(), changes: changes.reported() });
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_full::notify::event::{CreateKind, DataChange, Flag, MetadataKind, RemoveKind, RenameMode};
    use notify_debouncer_full::notify::{self, Event};
    use notify_debouncer_full::DebouncedEvent;
    use std::time::Instant;

    const ROOT: &str = "/worktrees/x";

    fn event(kind: EventKind, paths: &[&str]) -> DebouncedEvent {
        let event = paths.iter().fold(Event::new(kind), |event, path| event.add_path(PathBuf::from(path)));
        DebouncedEvent::new(event, Instant::now())
    }

    fn changes_of(events: Vec<DebouncedEvent>) -> Changes {
        Changes::of(Path::new(ROOT), Some(Path::new("/repo/.git/worktrees/x/logs/HEAD")), &Ok(events))
    }

    fn strings(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn a_batch_names_its_paths_and_which_of_them_appeared_vanished_or_moved() {
        let changes = changes_of(vec![
            event(EventKind::Modify(ModifyKind::Data(DataChange::Content)), &["/worktrees/x/src/a.ts"]),
            event(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)), &["/worktrees/x/src/a.ts"]),
            event(EventKind::Create(CreateKind::File), &["/worktrees/x/src/b.ts"]),
            event(EventKind::Remove(RemoveKind::Folder), &["/worktrees/x/old"]),
            event(EventKind::Modify(ModifyKind::Name(RenameMode::Any)), &["/worktrees/x/c.ts", "/worktrees/x/d.ts"]),
            event(EventKind::Modify(ModifyKind::Data(DataChange::Any)), &["/worktrees/x/src/b.ts"]),
            event(EventKind::Modify(ModifyKind::Data(DataChange::Any)), &["/worktrees/x/.git/index", "/elsewhere/e.ts"]),
        ]);
        assert!(!changes.is_everything);
        assert_eq!(
            changes.reported(),
            Some(PathChanges {
                paths: strings(&["c.ts", "d.ts", "old", "src/a.ts", "src/b.ts"]),
                entry_paths: strings(&["c.ts", "d.ts", "old", "src/b.ts"]),
            }),
        );
    }

    #[test]
    fn a_lost_track_a_rescan_or_a_moved_head_changes_everything() {
        let lost = Changes::of(Path::new(ROOT), None, &Err(vec![notify::Error::generic("overflow")]));
        assert!(lost.is_everything);
        assert_eq!(lost.reported(), None);

        let rescan = DebouncedEvent::new(Event::new(EventKind::Other).set_flag(Flag::Rescan), Instant::now());
        assert!(changes_of(vec![rescan]).is_everything);

        let moved_head = event(EventKind::Modify(ModifyKind::Data(DataChange::Any)), &["/repo/.git/worktrees/x/logs/HEAD"]);
        assert!(changes_of(vec![moved_head]).is_everything);
    }

    #[test]
    fn gathered_batches_merge_and_too_many_paths_name_none() {
        let mut changes = changes_of(vec![event(EventKind::Modify(ModifyKind::Data(DataChange::Any)), &["/worktrees/x/a.ts"])]);
        changes.merge(changes_of(vec![event(EventKind::Create(CreateKind::File), &["/worktrees/x/a.ts"])]));
        assert_eq!(changes.reported(), Some(PathChanges { paths: strings(&["a.ts"]), entry_paths: strings(&["a.ts"]) }));

        let many: Vec<String> = (0..=MAX_REPORTED_PATHS).map(|index| format!("/worktrees/x/gen/{index}.ts")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        let many = changes_of(vec![event(EventKind::Create(CreateKind::File), &many)]);
        assert!(!many.is_everything);
        assert_eq!(many.reported(), None);
    }

    #[test]
    fn only_paths_outside_hunts_own_and_dependency_folders_may_show_in_the_changelist() {
        let changes = changes_of(vec![event(
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            &["/worktrees/x/src/a.ts", "/worktrees/x/.hunt/logs/desktop/1.log", "/worktrees/x/node_modules/react/index.js"],
        )]);
        assert_eq!(changes.changelist_paths(Path::new(ROOT)), BTreeSet::from(["src/a.ts".to_string()]));
        assert_eq!(changes.reported().map(|reported| reported.paths.len()), Some(3));
    }
}
