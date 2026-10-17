//! Keeps the local worktree of every connected remote session in sync with its worktree on the VM (`remote::sync`). A
//! sync runs when an agent of the VM connects (the session's own or a sub chat's), after an agent finished a tool call
//! or a turn, every `TURN_POLL` while a turn runs (the agent's shell commands change files too), after the watcher saw
//! a local change and after Hunt itself changed a file (`note_local_change`); a prompt waits until the local changes
//! reached the VM (`flush`), and a commit on the VM runs while no sync does (`exclusive`). The sync after a turn ended
//! also backs the VM's transcripts up into the local project folder (`remote::retrieve::back_up_transcripts`), so a VM
//! that gets lost costs at most the running turn. Syncs of one session run one after the other, and requests that
//! arrive meanwhile run one more afterwards; the sync stops when the last agent of the VM disconnected. An adopted
//! session gets a local worktree first, once the local checkout of its repository is known; until then it is skipped
//! quietly. Every sync that talks to the VM reports to the UI as `remote:sync` with the remote session's id, its failure
//! and the files it could not sync; only the sync before a commit fails its command.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{Meta, SessionNotification, SessionUpdate, ToolCallStatus};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::git;
use crate::private_files;
use crate::graph::{self, WatcherRegistry};
use crate::remote::commit::follow_vm_head;
use crate::remote::retrieve;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::sync::{self as file_sync, Direction, Outcome, SyncTarget};
use crate::remote::{claude_dir, RemoteTarget};
use crate::session::dependencies::{self, Install};
use crate::session::store::{self, announce_sessions_changed, SessionRecord};

/// How often a sync runs while the agent's turn runs.
const TURN_POLL: Duration = Duration::from_secs(10);
/// How long the watcher gathers local changes before it asks for a sync.
const LOCAL_DEBOUNCE: Duration = Duration::from_millis(500);

/// The sync state of the connected remote sessions, and per session the lock that runs its syncs one at a time, which
/// outlives a reconnect.
#[derive(Default)]
pub struct SyncRegistry {
    active: Mutex<HashMap<Uuid, Arc<SessionSync>>>,
    locks: Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
}

/// The sync of one connected remote session.
struct SessionSync {
    /// Held while a sync of the session runs.
    lock: Arc<tokio::sync::Mutex<()>>,
    /// The Hunt sessions whose agents on the VM are connected: the remote session's own and those of its sub chats.
    agents: Mutex<HashSet<Uuid>>,
    /// The agents among them whose turn runs.
    turns: Mutex<HashSet<Uuid>>,
    /// The VM may have changed files since the last sync.
    wants_remote: AtomicBool,
    /// The local worktree may have changed files since the last sync.
    wants_local: AtomicBool,
    /// A turn ended since the last sync, so the transcripts on the VM are to be backed up here.
    wants_transcript: AtomicBool,
    /// Whether a task runs the syncs the session asked for.
    is_driven: AtomicBool,
    /// Set once the session disconnected; no sync starts after that.
    is_stopped: AtomicBool,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    /// Asks for a sync every `TURN_POLL` while a turn runs.
    poller: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl SessionSync {
    fn new(lock: Arc<tokio::sync::Mutex<()>>, agent: Uuid) -> Self {
        SessionSync {
            lock,
            agents: Mutex::new(HashSet::from([agent])),
            turns: Mutex::default(),
            wants_remote: AtomicBool::new(true),
            wants_local: AtomicBool::new(true),
            wants_transcript: AtomicBool::new(false),
            is_driven: AtomicBool::new(false),
            is_stopped: AtomicBool::new(false),
            watcher: Mutex::new(None),
            poller: Mutex::new(None),
        }
    }

    /// Records that the turn of `agent` ended, and stops the poller once no agent of the VM runs one; returns whether
    /// it did.
    fn end_turn(&self, agent: Uuid) -> bool {
        let mut turns = self.turns.lock().unwrap();
        turns.remove(&agent);
        if !turns.is_empty() {
            return false;
        }
        if let Some(poller) = self.poller.lock().unwrap().take() {
            poller.abort();
        }
        true
    }

    fn stop(&self) {
        self.is_stopped.store(true, Ordering::SeqCst);
        self.watcher.lock().unwrap().take();
        if let Some(poller) = self.poller.lock().unwrap().take() {
            poller.abort();
        }
    }
}

/// Which side may have changed files.
#[derive(Clone, Copy)]
enum Side {
    Local,
    Remote,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncEvent {
    hunt_session_id: Uuid,
    /// Whether a sync runs now; false once it ended.
    is_running: bool,
    /// When the sync that ended succeeded; `None` while one runs and after a failure.
    synced_at: Option<chrono::DateTime<chrono::Utc>>,
    error: Option<String>,
    /// One line per file the sync that ended could not sync, with the reason.
    conflicts: Vec<String>,
    /// Whether the sync that ended changed files of the local worktree, which the views then reload.
    changed_local: bool,
}

impl SyncEvent {
    fn running(id: Uuid) -> Self {
        SyncEvent { hunt_session_id: id, is_running: true, synced_at: None, error: None, conflicts: Vec::new(), changed_local: false }
    }

    /// The end of a sync the disconnect of its session cut short: nothing to report.
    fn interrupted(id: Uuid) -> Self {
        SyncEvent { is_running: false, ..Self::running(id) }
    }

    fn ended(id: Uuid, result: Result<Outcome, String>) -> Self {
        match result {
            Ok(outcome) => SyncEvent {
                hunt_session_id: id,
                is_running: false,
                synced_at: Some(chrono::Utc::now()),
                error: None,
                changed_local: outcome.changed_local(),
                conflicts: outcome.conflicts,
            },
            Err(error) => SyncEvent { is_running: false, error: Some(error), ..Self::running(id) },
        }
    }
}

/// Syncs the remote session `id` while the agent of the Hunt session `agent` is connected to its VM: the session's own
/// or a sub chat's. The first agent starts the sync: it watches the local worktree and syncs right away, which also
/// sends what changed here while nobody was connected; a later one syncs once more.
pub fn attach(app: &AppHandle, id: Uuid, agent: Uuid) {
    let registry = app.state::<SyncRegistry>();
    let lock = registry.locks.lock().unwrap().entry(id).or_default().clone();
    let mut active = registry.active.lock().unwrap();
    if let Some(state) = active.get(&id).cloned() {
        drop(active);
        state.agents.lock().unwrap().insert(agent);
        request(app, id, Side::Remote);
        return;
    }
    let state = Arc::new(SessionSync::new(lock, agent));
    active.insert(id, state.clone());
    drop(active);
    if let Ok(record) = store::find_session(app, id) {
        if record.worktree_path.is_dir() {
            watch(app, id, &state, &record.worktree_path);
        }
    }
    drive(app, id, state);
}

/// Ends the part of the agent of `agent` in the sync of its VM, whose connection ended; the sync stops with the last
/// agent of the VM, and a sync that runs finishes. Does nothing for an agent that does not sync.
pub fn detach(app: &AppHandle, agent: Uuid) {
    let registry = app.state::<SyncRegistry>();
    let mut active = registry.active.lock().unwrap();
    let mut ended = Vec::new();
    for (id, state) in active.iter() {
        let mut agents = state.agents.lock().unwrap();
        if !agents.remove(&agent) {
            continue;
        }
        let is_last = agents.is_empty();
        drop(agents);
        state.end_turn(agent);
        if is_last {
            ended.push(*id);
        }
    }
    for id in ended {
        if let Some(state) = active.remove(&id) {
            state.stop();
        }
    }
}

/// Stops syncing `id` whatever agents are connected, and waits until a running sync ended, so that a retrieval has the
/// files to itself.
pub async fn stop_and_wait(app: &AppHandle, id: Uuid) {
    let registry = app.state::<SyncRegistry>();
    if let Some(state) = registry.active.lock().unwrap().remove(&id) {
        state.stop();
    }
    let lock = registry.locks.lock().unwrap().get(&id).cloned();
    if let Some(lock) = lock {
        let _ = lock.lock().await;
    }
}

/// Waits until the local changes of the connected remote session `id`, or of the remote session whose sub chat `id` is,
/// reached its VM: until a running sync ended, then through one more that sends what changed here (it talks to the VM
/// only when something did). Does nothing for a session that does not sync.
pub async fn flush(app: &AppHandle, id: Uuid) {
    let id = owner_of(app, id);
    let Some(state) = active(app, id) else { return };
    let _guard = state.lock.lock().await;
    if state.is_stopped.load(Ordering::SeqCst) {
        return;
    }
    state.wants_local.store(false, Ordering::SeqCst);
    let _ = run_locked(app, id, &state, Wanted::default()).await;
}

/// Runs `work` on the VM of the connected remote session `id` while no sync of it runs, after a sync that sent the local
/// changes there, and returns the outcome of that sync (`None` when nothing changed here) with `work`'s result; a sync
/// afterwards brings what `work` changed on the VM. Fails without running `work` when the session does not sync or that
/// sync failed.
pub async fn exclusive<T, W, F>(app: &AppHandle, id: Uuid, work: W) -> Result<T, String>
where
    W: FnOnce(Option<Outcome>) -> F,
    F: Future<Output = Result<T, String>>,
{
    let not_connected = || "the session is not connected to its VM; open it and try again".to_string();
    let state = active(app, id).ok_or_else(not_connected)?;
    let result = {
        let _guard = state.lock.lock().await;
        if state.is_stopped.load(Ordering::SeqCst) {
            return Err(not_connected());
        }
        state.wants_local.store(false, Ordering::SeqCst);
        let outcome = run_locked(app, id, &state, Wanted::default())
            .await
            .map_err(|error| format!("failed to bring the local changes to the VM: {error}"))?;
        work(outcome).await
    };
    request(app, id, Side::Remote);
    result
}

/// Asks for a sync of the remote session `id`, or of the remote session whose sub chat `id` is, after Hunt changed a
/// file of its local worktree; the watcher would see it too, later.
pub fn note_local_change(app: &AppHandle, id: Uuid) {
    request(app, owner_of(app, id), Side::Local);
}

/// Asks for a sync of the remote session `id` after what `notification` of the agent of `agent` on its VM tells: a
/// finished tool call, or the relay's turn state, whose end syncs and while which the poller runs. Notifications of
/// sessions that do not sync are ignored.
pub fn observe(app: &AppHandle, id: Uuid, agent: Uuid, notification: &SessionNotification) {
    let Some(state) = active(app, id) else { return };
    match &notification.update {
        SessionUpdate::ToolCallUpdate(update) => {
            if matches!(update.fields.status, Some(ToolCallStatus::Completed | ToolCallStatus::Failed)) {
                request(app, id, Side::Remote);
            }
        }
        SessionUpdate::SessionInfoUpdate(update) => match relay_turn(update.meta.as_ref()) {
            Some("running") => {
                state.turns.lock().unwrap().insert(agent);
                poll(app, id, &state);
            }
            Some("idle") => {
                state.end_turn(agent);
                state.wants_transcript.store(true, Ordering::SeqCst);
                request(app, id, Side::Remote);
            }
            _ => {}
        },
        _ => {}
    }
}

/// Copies the worktree-relative `paths` of the remote session `id` between its VM and its local worktree, outside the
/// synced files (the diagram in `.hunt/`).
pub async fn copy_files(app: &AppHandle, id: Uuid, direction: Direction, paths: &[String]) -> Result<(), String> {
    let record = store::find_session(app, id)?;
    let target = record.remote.ok_or("failed to copy files of the session: it runs locally")?;
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    file_sync::copy_files(&ssh, direction, &record.worktree_path, &target.worktree_path.display().to_string(), paths).await
}

/// Deletes the sync state of `id`, whose local worktree no longer follows a VM.
pub fn forget(app: &AppHandle, id: Uuid) {
    let result = manifest_path(app, id).and_then(|path| file_sync::forget(&path));
    if let Err(error) = result {
        eprintln!("deleting the sync state of session {id} failed: {error}");
    }
    app.state::<SyncRegistry>().locks.lock().unwrap().remove(&id);
}

/// Where the sync state of the session `id` lives.
pub fn manifest_path(app: &AppHandle, id: Uuid) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join("remote-sync").join(format!("{id}.json")))
}

fn active(app: &AppHandle, id: Uuid) -> Option<Arc<SessionSync>> {
    app.state::<SyncRegistry>().active.lock().unwrap().get(&id).cloned()
}

/// The session whose sync covers the worktree of `id`: its parent for a sub chat, which works in the parent's worktree,
/// else `id` itself.
fn owner_of(app: &AppHandle, id: Uuid) -> Uuid {
    store::find_session(app, id).ok().and_then(|record| record.parent_id).unwrap_or(id)
}

/// The turn state the relay reports in `_meta.hunt.turn` of a `session_info_update`.
fn relay_turn(meta: Option<&Meta>) -> Option<&str> {
    meta?.get("hunt")?.get("turn")?.as_str()
}

/// Asks for a sync of `id` after `side` may have changed files.
fn request(app: &AppHandle, id: Uuid, side: Side) {
    let Some(state) = active(app, id) else { return };
    match side {
        Side::Local => state.wants_local.store(true, Ordering::SeqCst),
        Side::Remote => state.wants_remote.store(true, Ordering::SeqCst),
    }
    drive(app, id, state);
}

/// Runs the syncs `state` asks for in the background until none waits; a task that runs already picks new requests up.
fn drive(app: &AppHandle, id: Uuid, state: Arc<SessionSync>) {
    if state.is_driven.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let wants_remote = state.wants_remote.swap(false, Ordering::SeqCst);
            let wants_local = state.wants_local.swap(false, Ordering::SeqCst);
            let wants_transcript = state.wants_transcript.swap(false, Ordering::SeqCst);
            let is_stopped = state.is_stopped.load(Ordering::SeqCst);
            if is_stopped || (!wants_remote && !wants_local && !wants_transcript) {
                state.is_driven.store(false, Ordering::SeqCst);
                // A request that came in after the swaps above found this task still running.
                let is_waiting = state.wants_remote.load(Ordering::SeqCst)
                    || state.wants_local.load(Ordering::SeqCst)
                    || state.wants_transcript.load(Ordering::SeqCst);
                if is_stopped || !is_waiting || state.is_driven.swap(true, Ordering::SeqCst) {
                    break;
                }
                continue;
            }
            let _guard = state.lock.lock().await;
            if state.is_stopped.load(Ordering::SeqCst) {
                continue;
            }
            let _ = run_locked(&app, id, &state, Wanted { remote: wants_remote, transcript: wants_transcript }).await;
        }
    });
}

/// What a sync is asked to do besides sending the local changes: bring the VM's changes, back up its transcripts.
#[derive(Clone, Copy, Default)]
struct Wanted {
    remote: bool,
    transcript: bool,
}

/// Runs one sync of `id` while its lock is held, reports it and returns its outcome, `None` when there was nothing to do;
/// without `wanted.remote` it talks to the VM only when the local worktree changed or a transcript backup is wanted. A
/// sync that fails because the session disconnected meanwhile (its VM shut down) reports no error.
async fn run_locked(app: &AppHandle, id: Uuid, state: &SessionSync, wanted: Wanted) -> Result<Option<Outcome>, String> {
    let result = match sync_once(app, id, wanted).await {
        Ok(None) => return Ok(None),
        Ok(Some(outcome)) => Ok(outcome),
        Err(error) if state.is_stopped.load(Ordering::SeqCst) => {
            let _ = app.emit("remote:sync", SyncEvent::interrupted(id));
            return Err(error);
        }
        Err(error) => {
            eprintln!("syncing the files of session {id} failed: {error}");
            Err(error)
        }
    };
    if result.as_ref().is_ok_and(Outcome::changed_local) {
        if let Err(error) = store::note_worktree_changed(app, id) {
            eprintln!("recording the synced changes of session {id} failed: {error}");
        }
    }
    let _ = app.emit("remote:sync", SyncEvent::ended(id, result.clone()));
    result.map(Some)
}

/// One sync of `id`; `None` when there was nothing to do: a local change was asked for and the local worktree turned out
/// unchanged, or an adopted session has no local checkout of its repository yet. A transcript backup that fails is
/// reported with the files the sync could not sync and fails nothing else.
async fn sync_once(app: &AppHandle, id: Uuid, wanted: Wanted) -> Result<Option<Outcome>, String> {
    let record = store::find_session(app, id)?;
    let target = record.remote.clone().ok_or("failed to sync the session's files: it runs locally")?;
    if target.worktree_path.as_os_str().is_empty() {
        return Err("failed to sync the session's files: its worktree on the VM is not known yet".into());
    }
    let has_worktree = record.worktree_path.is_dir();
    if !has_worktree && target.is_adopted() && record.repo_path.as_os_str().is_empty() {
        return Ok(None);
    }
    let manifest = manifest_path(app, id)?;
    if !wanted.remote && !wanted.transcript && has_worktree && !file_sync::has_local_changes(&record.worktree_path, &manifest).await? {
        return Ok(None);
    }
    let _ = app.emit("remote:sync", SyncEvent::running(id));
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let record = ensure_local_worktree(app, record, &target, &ssh).await?;
    let target = record.remote.clone().ok_or("failed to sync the session's files: it runs locally now")?;
    let remote = target.worktree_path.display().to_string();
    let base_ref = target.start_ref(id);
    let sync_target = SyncTarget { local: &record.worktree_path, remote: &remote, manifest: &manifest, base_ref: &base_ref };
    let mut outcome = file_sync::sync(&sync_target, &ssh).await?;
    match follow_head(app, id, &ssh, &target, &record.worktree_path).await {
        Ok(moved) => outcome.moved_head = moved,
        Err(error) => outcome.conflicts.push(format!("branch {}: {error}", target.branch)),
    }
    if wanted.transcript {
        let backup = async { retrieve::back_up_transcripts(&ssh, id, &record.worktree_path, &claude_dir()?, &remote).await };
        if let Err(error) = backup.await {
            outcome.conflicts.push(format!("transcript backup: {error}"));
        }
    }
    Ok(Some(outcome))
}

/// Points the local branch of the remote session `id` at the commit its VM's worktree has checked out when that moved
/// (`remote::commit::follow_vm_head`), and records that commit as the one the branch follows; returns whether it moved.
pub async fn follow_head(app: &AppHandle, id: Uuid, ssh: &Ssh, target: &RemoteTarget, worktree: &Path) -> Result<bool, String> {
    let Some(head) = follow_vm_head(ssh, id, target, worktree).await? else {
        return Ok(false);
    };
    store::update_session(app, id, |stored| {
        if let Some(remote) = stored.remote.as_mut() {
            remote.handoff_head = head;
        }
    })?;
    Ok(true)
}

/// The record of the remote session `record` with a local worktree: an adopted session that has none yet gets one from
/// a snapshot of its VM in the local checkout of its repository, prepared like a new session's.
async fn ensure_local_worktree(app: &AppHandle, record: SessionRecord, target: &RemoteTarget, ssh: &Ssh) -> Result<SessionRecord, String> {
    if record.worktree_path.is_dir() {
        return Ok(record);
    }
    if !target.is_adopted() {
        return Err(format!("failed to sync the session's files: its local worktree {} is missing", record.worktree_path.display()));
    }
    let id = record.id;
    let remote = target.worktree_path.display().to_string();
    let checked_out = retrieve::check_out_adopted(ssh, id, &remote, &target.branch, &record.repo_path, &record.worktree_path, &private_files::file_patterns()).await?;
    let record = store::update_session(app, id, |stored| {
        stored.branch = checked_out.branch.clone();
        if let Some(remote) = stored.remote.as_mut() {
            remote.handoff_head = checked_out.head.clone();
        }
    })?
    .ok_or_else(|| "failed to sync the session's files: the session was closed meanwhile".to_string())?;
    announce_sessions_changed(app);
    dependencies::ensure(app, record.repo_path.clone(), record.worktree_path.clone(), Install::Frozen);
    if let Err(error) = git::exclude_hunt_dir(&record.worktree_path).await {
        eprintln!("excluding the diagram folder in the worktree of session {id} failed: {error}");
    }
    if let Err(error) = graph::watch(app, &app.state::<WatcherRegistry>(), id, &record.worktree_path) {
        eprintln!("watching the graph of session {id} failed: {error}");
    }
    if let Some(state) = active(app, id) {
        watch(app, id, &state, &record.worktree_path);
    }
    Ok(record)
}

/// Watches the local `worktree` of `id` and asks for a sync when a file outside `.git`, `.hunt` and `node_modules`
/// changes; a failure is only logged, the other triggers still sync.
fn watch(app: &AppHandle, id: Uuid, state: &SessionSync, worktree: &Path) {
    let handle = app.clone();
    let root = worktree.to_path_buf();
    let debouncer = new_debouncer(LOCAL_DEBOUNCE, None, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        if events.iter().any(|event| event.paths.iter().any(|path| may_be_synced(&root, path))) {
            request(&handle, id, Side::Local);
        }
    });
    let watched = debouncer.map_err(|error| error.to_string()).and_then(|mut debouncer| {
        debouncer.watch(worktree, RecursiveMode::Recursive).map_err(|error| error.to_string())?;
        Ok(debouncer)
    });
    match watched {
        Ok(debouncer) => {
            *state.watcher.lock().unwrap() = Some(debouncer);
        }
        Err(error) => eprintln!("watching the worktree of session {id} for the sync failed: {error}"),
    }
}

/// Whether a change at `path` may concern a synced file of `worktree`: one inside it, outside `.git`, `.hunt` and
/// `node_modules` folders.
fn may_be_synced(worktree: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(worktree) else { return false };
    !relative.components().any(|component| matches!(component.as_os_str().to_str(), Some(".git" | ".hunt" | "node_modules")))
}

/// Asks for a sync of `id` every `TURN_POLL` until the turn ends or the session stops syncing.
fn poll(app: &AppHandle, id: Uuid, state: &SessionSync) {
    let mut poller = state.poller.lock().unwrap();
    if poller.is_some() || state.is_stopped.load(Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    *poller = Some(tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TURN_POLL).await;
            request(&app, id, Side::Remote);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn may_be_synced_skips_git_diagram_and_dependency_folders() {
        let worktree = Path::new("/Users/jane/Library/Application Support/hunt/worktrees/x");
        assert!(may_be_synced(worktree, &worktree.join("src/main.ts")));
        assert!(may_be_synced(worktree, &worktree.join(".gitignore")));
        assert!(!may_be_synced(worktree, &worktree.join(".git/index")));
        assert!(!may_be_synced(worktree, &worktree.join(".hunt/graph.json")));
        assert!(!may_be_synced(worktree, &worktree.join("apps/web/node_modules/react/index.js")));
        assert!(!may_be_synced(worktree, Path::new("/tmp/elsewhere.txt")));
    }

    #[test]
    fn relay_turn_reads_the_hunt_meta() {
        let meta = |value: serde_json::Value| value.as_object().cloned().unwrap();
        assert_eq!(relay_turn(Some(&meta(serde_json::json!({ "hunt": { "turn": "running" } })))), Some("running"));
        assert_eq!(relay_turn(Some(&meta(serde_json::json!({ "hunt": {} })))), None);
        assert_eq!(relay_turn(None), None);
    }

    #[test]
    fn the_turns_end_once_no_agent_of_the_vm_runs_one() {
        let (session, sub_chat) = (Uuid::new_v4(), Uuid::new_v4());
        let state = SessionSync::new(Arc::default(), session);
        state.turns.lock().unwrap().extend([session, sub_chat]);
        assert!(!state.end_turn(sub_chat));
        assert!(!state.end_turn(sub_chat));
        assert!(state.end_turn(session));
        assert!(state.end_turn(sub_chat));
    }

    #[test]
    fn an_ended_sync_reports_its_conflicts_or_its_failure() {
        let id = Uuid::nil();
        let outcome = Outcome { pulled: 1, conflicts: vec!["src: a folder here is where the VM has a file".into()], ..Outcome::default() };
        let ended = SyncEvent::ended(id, Ok(outcome));
        assert!(!ended.is_running && ended.synced_at.is_some() && ended.error.is_none() && ended.changed_local);
        assert_eq!(ended.conflicts, ["src: a folder here is where the VM has a file"]);
        let failed = SyncEvent::ended(id, Err("failed to list the files on the VM".into()));
        assert!(!failed.is_running && failed.synced_at.is_none() && failed.conflicts.is_empty());
        assert_eq!(failed.error.as_deref(), Some("failed to list the files on the VM"));
    }
}
