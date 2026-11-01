//! One recursive file watch per worktree, plus the reflogs of its `HEAD`, shared by everything that follows the files
//! of a worktree: the changelist (`session/worktree_watch.rs`) and the language servers (`ide/lsp.rs`). Each FSEvents
//! stream reports every change below its root, `node_modules` and build output included, so a worktree with a session
//! and two language servers would otherwise run three of them. Every subscriber gets every debounced batch and filters
//! it itself; the watch starts with the first subscription of its worktree and stops with the last.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};

use crate::git::git_dir_of;

/// How long a burst of changes settles before the subscribers hear of it; one that wants calmer batches gathers them
/// itself, as the changelist does.
pub const DEBOUNCE: Duration = Duration::from_millis(100);

type OnBatch = Arc<dyn Fn(&DebounceEventResult) + Send + Sync>;

/// The subscribers of one watch, keyed by subscription id.
type Subscribers = Arc<Mutex<Vec<(u64, OnBatch)>>>;

struct SharedWatch {
    subscribers: Subscribers,
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

/// The running watches by worktree.
static WATCHES: LazyLock<Mutex<HashMap<PathBuf, SharedWatch>>> = LazyLock::new(Mutex::default);
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// A subscriber's share of the watch of a worktree; dropping it unsubscribes, and the last one stops the watch. A batch
/// being delivered while it drops may still reach the subscriber once.
pub struct WatchSubscription {
    worktree: PathBuf,
    id: u64,
}

/// Has `on_batch` hear every debounced batch of changes below `worktree` and in the reflogs of its `HEAD`, starting the
/// watch when it is the worktree's first subscriber.
pub fn subscribe(worktree: &Path, on_batch: impl Fn(&DebounceEventResult) + Send + Sync + 'static) -> Result<WatchSubscription, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut watches = WATCHES.lock().unwrap();
    let watch = match watches.entry(worktree.to_path_buf()) {
        Entry::Occupied(entry) => entry.into_mut(),
        Entry::Vacant(entry) => entry.insert(start(worktree)?),
    };
    watch.subscribers.lock().unwrap().push((id, Arc::new(on_batch)));
    Ok(WatchSubscription { worktree: worktree.to_path_buf(), id })
}

impl Drop for WatchSubscription {
    fn drop(&mut self) {
        let mut watches = WATCHES.lock().unwrap();
        let Some(watch) = watches.get(&self.worktree) else { return };
        let is_unused = {
            let mut subscribers = watch.subscribers.lock().unwrap();
            subscribers.retain(|(id, _)| *id != self.id);
            subscribers.is_empty()
        };
        let stopped = if is_unused { watches.remove(&self.worktree) } else { None };
        drop(watches);
        drop(stopped);
    }
}

/// Watches `worktree` recursively, plus the reflogs of its `HEAD` (outside the worktree for a linked one), and hands
/// every batch to the subscribers of the moment. Without a file ID cache: filling it reads every file of the worktree,
/// `node_modules` included.
fn start(worktree: &Path) -> Result<SharedWatch, String> {
    let subscribers = Subscribers::default();
    let on_events = {
        let subscribers = subscribers.clone();
        move |result: DebounceEventResult| {
            let current: Vec<OnBatch> = subscribers.lock().unwrap().iter().map(|(_, on_batch)| on_batch.clone()).collect();
            for on_batch in current {
                on_batch(&result);
            }
        }
    };
    let failed = |error: notify::Error| format!("failed to watch the worktree {}: {error}", worktree.display());
    let mut debouncer =
        new_debouncer_opt::<_, RecommendedWatcher, _>(DEBOUNCE, None, on_events, NoCache, notify::Config::default()).map_err(failed)?;
    debouncer.watch(worktree, RecursiveMode::Recursive).map_err(failed)?;
    if let Some(reflogs) = git_dir_of(worktree).map(|git_dir| git_dir.join("logs")).filter(|reflogs| reflogs.is_dir()) {
        if let Err(error) = debouncer.watch(&reflogs, RecursiveMode::NonRecursive) {
            eprintln!("failed to watch the reflogs {}: {error}", reflogs.display());
        }
    }
    Ok(SharedWatch { subscribers, _debouncer: debouncer })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn is_watched(worktree: &Path) -> bool {
        WATCHES.lock().unwrap().contains_key(worktree)
    }

    #[test]
    fn subscribers_of_a_worktree_share_one_watch_that_ends_with_the_last() {
        let worktree = tempfile::tempdir().unwrap();
        let root = worktree.path().canonicalize().unwrap();
        let (first_sender, first) = mpsc::channel();
        let (second_sender, second) = mpsc::channel();
        let first_sender = Mutex::new(first_sender);
        let second_sender = Mutex::new(second_sender);
        let first_subscription = subscribe(&root, move |_| {
            let _ = first_sender.lock().unwrap().send(());
        })
        .unwrap();
        let second_subscription = subscribe(&root, move |_| {
            let _ = second_sender.lock().unwrap().send(());
        })
        .unwrap();
        assert_eq!(WATCHES.lock().unwrap().get(&root).map(|watch| watch.subscribers.lock().unwrap().len()), Some(2));

        std::fs::write(root.join("a.ts"), "").unwrap();
        assert!(first.recv_timeout(Duration::from_secs(5)).is_ok(), "the first subscriber hears the change");
        assert!(second.recv_timeout(Duration::from_secs(5)).is_ok(), "the second subscriber hears the change");

        drop(first_subscription);
        assert!(is_watched(&root), "the watch stays while a subscriber is left");
        drop(second_subscription);
        assert!(!is_watched(&root), "the last subscription stops the watch");
    }
}
