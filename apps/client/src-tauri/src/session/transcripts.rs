//! Keeps the Claude Code transcripts and the terminal logs of a connected remote session in step with its VM, live and
//! both ways, as two streams (`remote::transcript_sync`, `StreamKind`). A transcript helper on the VM
//! (`remote::transcript_channel`) reports the files of its folder there as they grow: the agent's project folder, whose
//! files land in the local project folder of the worktree with their paths moved here, and `~/logs`, whose files land in
//! `.hunt/logs` of the worktree as they are. The watcher of the local side reports the files this Mac owns, which go to
//! the VM the same way: the transcripts of the session's sub chats (which run here), and the logs of this Mac's tmux in
//! `.hunt/logs/desktop/`. So a sub chat can read the running turn of its session, the agent on the VM what its sub chats
//! did, and every agent of the session family the terminals of both machines. The streams start and stop with the file
//! sync of the session (`session::sync`); while a channel is down, nothing moves, and the file sync's per-turn backup
//! covers the VM's transcript as before. When a channel (re)opens, the helper is told what this Mac holds and every
//! owned file is pushed, so only what is missing moves.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::AppHandle;
use uuid::Uuid;

use crate::remote::claude_dir;
use crate::remote::handoff::REMOTE_LOGS_DIR;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::transcript::{local_project, remote_project, Replacements};
use crate::remote::transcript_channel::{Event, Refused, TranscriptChannel};
use crate::remote::transcript_sync::{Applied, Ownership, StreamKind, TranscriptSync};
use crate::session::store;
use crate::session::sync::{manifest_path, CHANNEL_RETRY};
use crate::tmux::{DESKTOP_LOGS, LOGS_DIR};

/// How long the watcher gathers local changes before they are pushed.
const LOCAL_DEBOUNCE: Duration = Duration::from_millis(50);
/// One stream of one connected remote session.
pub struct TranscriptLink {
    kind: StreamKind,
    /// The channel to the transcript helper on the VM while it is open, and the task that opens it again.
    channel: Mutex<Option<Arc<TranscriptChannel>>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    /// Reports of the helper and local paths the watcher saw, not applied yet.
    events: Mutex<Vec<Event>>,
    local_paths: Mutex<BTreeSet<String>>,
    /// The channel opened: the helper is to be told what this Mac holds, and every owned file pushed.
    wants_sync: AtomicBool,
    /// Whether a task applies what waits.
    is_driven: AtomicBool,
    is_stopped: AtomicBool,
    stream: tokio::sync::Mutex<Option<TranscriptSync>>,
}

impl TranscriptLink {
    pub fn new(kind: StreamKind) -> Self {
        TranscriptLink {
            kind,
            channel: Mutex::default(),
            task: Mutex::default(),
            watcher: Mutex::default(),
            events: Mutex::default(),
            local_paths: Mutex::default(),
            wants_sync: AtomicBool::default(),
            is_driven: AtomicBool::default(),
            is_stopped: AtomicBool::default(),
            stream: tokio::sync::Mutex::default(),
        }
    }

    pub fn kind(&self) -> StreamKind {
        self.kind
    }

    /// Whether the channel to the helper on the VM is open.
    pub fn has_channel(&self) -> bool {
        self.channel.lock().unwrap().is_some()
    }

    pub fn stop(&self) {
        self.is_stopped.store(true, Ordering::SeqCst);
        self.watcher.lock().unwrap().take();
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        self.channel.lock().unwrap().take();
    }
}

/// Starts the stream `link` of the remote session `id`: watches its local folder and keeps the channel to the helper on
/// its VM open. Does nothing while the session's worktree on the VM is not known yet (an adopted session before its
/// first sync), or when the stream runs already.
pub fn start(app: &AppHandle, id: Uuid, link: &Arc<TranscriptLink>) -> Result<(), String> {
    if link.task.lock().unwrap().is_some() || link.is_stopped.load(Ordering::SeqCst) {
        return Ok(());
    }
    let record = store::find_session(app, id)?;
    let target = record.remote.ok_or("the session runs locally")?;
    if target.worktree_path.as_os_str().is_empty() {
        return Ok(());
    }
    let folders = Folders::of(link.kind, &record.worktree_path, &target.worktree_path.display().to_string())?;
    std::fs::create_dir_all(&folders.watched).map_err(|error| format!("failed to create {}: {error}", folders.watched.display()))?;
    let stream = TranscriptSync::load(link.kind, state_path(app, id, link.kind)?, folders.local.clone(), folders.replacements);
    *link.stream.try_lock().map_err(|_| "the stream is busy".to_string())? = Some(stream);
    watch(app, id, link, &folders.local, &folders.watched);
    open_channel(app, id, link, folders.remote);
    Ok(())
}

/// Where the stream `kind` of `id` keeps its state: next to the file sync's manifest, as `<id>.<name>.json`.
pub fn state_path(app: &AppHandle, id: Uuid, kind: StreamKind) -> Result<PathBuf, String> {
    Ok(manifest_path(app, id)?.with_extension(format!("{}.json", kind.name())))
}

/// Where a stream runs: its local folder, the folder in it that holds the files this Mac owns (which the watcher
/// watches), its folder on the VM, and the replacements that move text between the two.
struct Folders {
    local: PathBuf,
    watched: PathBuf,
    remote: String,
    replacements: Replacements,
}

impl Folders {
    /// The folders of the stream `kind` of a session that works in `worktree` here and in `remote_worktree` on its VM.
    fn of(kind: StreamKind, worktree: &Path, remote_worktree: &str) -> Result<Self, String> {
        match kind {
            StreamKind::Transcripts => {
                let claude = claude_dir()?;
                let local = local_project(worktree, &claude);
                let replacements = Replacements::new(worktree, &claude, remote_worktree);
                Ok(Folders { watched: local.clone(), local, remote: remote_project(remote_worktree), replacements })
            }
            StreamKind::Logs => {
                let local = worktree.join(LOGS_DIR);
                let watched = local.join(DESKTOP_LOGS);
                Ok(Folders { local, watched, remote: REMOTE_LOGS_DIR.to_string(), replacements: Replacements::default() })
            }
        }
    }
}

/// The files of the stream `kind` of `id` this Mac owns: the transcripts of the session's sub chats, the logs of its tmux.
fn ownership(app: &AppHandle, id: Uuid, kind: StreamKind) -> Result<Ownership, String> {
    Ok(match kind {
        StreamKind::Transcripts => Ownership::Sessions(store::sub_chat_acp_ids(app, id)?.into_iter().collect()),
        StreamKind::Logs => Ownership::Folder(DESKTOP_LOGS),
    })
}

/// Deletes what the log stream brought from the VM into the local `worktree`: everything in `.hunt/logs` but the logs
/// of this Mac's tmux. A `worktree` that is not an absolute path (a session that has none yet) has none.
pub fn forget_pulled_logs(worktree: &Path) -> Result<(), String> {
    if !worktree.is_absolute() {
        return Ok(());
    }
    let logs = worktree.join(LOGS_DIR);
    let entries = match std::fs::read_dir(&logs) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read {}: {error}", logs.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read {}: {error}", logs.display()))?;
        if entry.file_name() == DESKTOP_LOGS {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        let removed = if file_type.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        removed.map_err(|error| format!("failed to delete the pulled log {}: {error}", path.display()))?;
    }
    Ok(())
}

/// Watches the folder `watched` in the local folder `local` of the stream `link` of `id` and has the files that change
/// there pushed; a failure is only logged, the push after the channel opened still covers them.
fn watch(app: &AppHandle, id: Uuid, link: &Arc<TranscriptLink>, local: &Path, watched: &Path) {
    let handle = app.clone();
    let root = local.to_path_buf();
    let skipped = link.kind.skipped_folder();
    let reports = Arc::downgrade(link);
    let debouncer = new_debouncer(LOCAL_DEBOUNCE, None, move |result: DebounceEventResult| {
        let Some(link) = reports.upgrade() else { return };
        let Ok(events) = result else { return };
        let paths: BTreeSet<String> =
            events.iter().flat_map(|event| &event.paths).filter_map(|path| relative_path(&root, path, skipped)).collect();
        if paths.is_empty() {
            return;
        }
        link.local_paths.lock().unwrap().extend(paths);
        drive(&handle, id, link);
    });
    let watching = debouncer.map_err(|error| error.to_string()).and_then(|mut debouncer| {
        debouncer.watch(watched, RecursiveMode::Recursive).map_err(|error| error.to_string())?;
        Ok(debouncer)
    });
    match watching {
        Ok(debouncer) => {
            *link.watcher.lock().unwrap() = Some(debouncer);
        }
        Err(error) => eprintln!("watching the {} of session {id} failed: {error}", link.kind.name()),
    }
}

/// The `root`-relative path of a change at `path` inside `root`, outside its top-level folder `skipped`.
fn relative_path(root: &Path, path: &Path, skipped: Option<&str>) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if skipped.is_some_and(|folder| relative.starts_with(folder)) {
        return None;
    }
    relative.to_str().filter(|relative| !relative.is_empty()).map(str::to_string)
}

/// Keeps the channel to the transcript helper for the folder `remote` on the VM of `id` open while the session syncs,
/// as `session::sync::open_channel` does for the file sync. A VM whose release lacks the helper keeps failing quietly.
fn open_channel(app: &AppHandle, id: Uuid, link: &Arc<TranscriptLink>, remote: String) {
    let app = app.clone();
    let task_link = link.clone();
    let task = tauri::async_runtime::spawn(async move {
        let link = task_link;
        let mut failures = 0;
        while !link.is_stopped.load(Ordering::SeqCst) {
            let (closed, is_closed) = tokio::sync::oneshot::channel::<String>();
            match connect(&app, id, &link, &remote, closed).await {
                Ok(channel) => {
                    failures = 0;
                    *link.channel.lock().unwrap() = Some(Arc::new(channel));
                    link.wants_sync.store(true, Ordering::SeqCst);
                    drive(&app, id, link.clone());
                    let reason = is_closed.await.unwrap_or_default();
                    link.channel.lock().unwrap().take();
                    if link.is_stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    eprintln!("the {} channel of session {id} ended: {reason}", link.kind.name());
                }
                Err(error) => {
                    if failures == 0 {
                        eprintln!("opening the {} channel of session {id} failed: {error}", link.kind.name());
                    }
                    failures += 1;
                }
            }
            tokio::time::sleep(CHANNEL_RETRY[failures.min(CHANNEL_RETRY.len() - 1)]).await;
        }
    });
    *link.task.lock().unwrap() = Some(task);
}

/// Opens the channel to the transcript helper for the folder `remote` on the VM of `id`; its reports land in `link`, and
/// `closed` gets why it ended.
async fn connect(app: &AppHandle, id: Uuid, link: &Arc<TranscriptLink>, remote: &str, closed: tokio::sync::oneshot::Sender<String>) -> Result<TranscriptChannel, String> {
    let record = store::find_session(app, id)?;
    let target = record.remote.ok_or("the session runs locally")?;
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let handle = app.clone();
    let reports = Arc::downgrade(link);
    let closed = Mutex::new(Some(closed));
    TranscriptChannel::open(&ssh, remote, move |event| {
        let Some(link) = reports.upgrade() else { return };
        if let Event::Closed(reason) = event {
            if let Some(closed) = closed.lock().unwrap().take() {
                let _ = closed.send(reason);
            }
            return;
        }
        link.events.lock().unwrap().push(event);
        drive(&handle, id, link);
    })
    .await
}

/// Applies what waits in `link` in the background until nothing does; a task that runs already picks new work up.
fn drive(app: &AppHandle, id: Uuid, link: Arc<TranscriptLink>) {
    if link.is_driven.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let wants_sync = link.wants_sync.swap(false, Ordering::SeqCst);
            let events = std::mem::take(&mut *link.events.lock().unwrap());
            let paths = std::mem::take(&mut *link.local_paths.lock().unwrap());
            let is_stopped = link.is_stopped.load(Ordering::SeqCst);
            if is_stopped || (!wants_sync && events.is_empty() && paths.is_empty()) {
                link.is_driven.store(false, Ordering::SeqCst);
                // Work that came in after the takes above found this task still running.
                let is_waiting = link.wants_sync.load(Ordering::SeqCst) || !link.events.lock().unwrap().is_empty() || !link.local_paths.lock().unwrap().is_empty();
                if is_stopped || !is_waiting || link.is_driven.swap(true, Ordering::SeqCst) {
                    break;
                }
                continue;
            }
            // Without a channel the reports are stale and the local changes wait for the push after the next one opened.
            let Some(channel) = link.channel.lock().unwrap().clone() else { continue };
            let mut stream = link.stream.lock().await;
            let Some(stream) = stream.as_mut() else { continue };
            if let Err(error) = run(&app, id, stream, &channel, wants_sync, events, paths).await {
                eprintln!("streaming the {} of session {id} failed: {error}", link.kind.name());
            }
        }
    });
}

/// One round of the stream: tells the helper what this Mac holds after the channel opened, applies its reports and
/// pushes the local files this Mac owns among `paths` (every one after the channel opened).
async fn run(
    app: &AppHandle,
    id: Uuid,
    stream: &mut TranscriptSync,
    channel: &TranscriptChannel,
    wants_sync: bool,
    events: Vec<Event>,
    paths: BTreeSet<String>,
) -> Result<(), String> {
    let ownership = ownership(app, id, stream.kind())?;
    let mut to_push = paths;
    if wants_sync {
        let (files, owned) = stream.sync_request();
        channel.sync(&files, &owned).await?;
        to_push.extend(stream.owned_paths(&ownership)?);
    }
    for event in events {
        match stream.apply(event, &ownership) {
            Ok(Applied::Read { path, offset }) => channel.read(&path, offset).await?,
            Ok(Applied::Done) => {}
            Err(error) => eprintln!("applying a {} report of session {id} failed: {error}", stream.kind().name()),
        }
    }
    for path in to_push {
        if !ownership.owns(&path) {
            continue;
        }
        push(stream, channel, &path).await?;
    }
    Ok(())
}

/// Brings the VM's copy of the local file at `path` up to date; a write the helper refuses (the copy is not as long as
/// expected) has the file sent from the start once.
async fn push(stream: &mut TranscriptSync, channel: &TranscriptChannel, path: &str) -> Result<(), String> {
    let mut has_started_over = false;
    loop {
        let Some(write) = stream.next_write(path)? else { return Ok(()) };
        match channel.write(&write.path, write.offset, &write.data, write.truncate).await? {
            Ok(remote_size) => stream.record_write(&write, remote_size)?,
            Err(Refused(reason)) => {
                let name = stream.kind().name();
                if has_started_over {
                    return Err(format!("the VM refused {path} of the {name} stream twice: {reason}"));
                }
                eprintln!("the VM refused {path} of the {name} stream, which is sent from the start again: {reason}");
                stream.reset_push(path)?;
                has_started_over = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_paths_skip_the_memory_and_the_folder_itself() {
        let project = Path::new("/Users/jane/.claude/projects/-Users-jane-wt");
        let skipped = StreamKind::Transcripts.skipped_folder();
        assert_eq!(relative_path(project, &project.join("abc.jsonl"), skipped).as_deref(), Some("abc.jsonl"));
        assert_eq!(relative_path(project, &project.join("abc/tool-results/1.txt"), skipped).as_deref(), Some("abc/tool-results/1.txt"));
        assert_eq!(relative_path(project, &project.join("memory/MEMORY.md"), skipped), None);
        assert_eq!(relative_path(project, &project.join("memoryless.jsonl"), skipped).as_deref(), Some("memoryless.jsonl"));
        assert_eq!(relative_path(project, project, skipped), None);
        assert_eq!(relative_path(project, Path::new("/tmp/elsewhere.jsonl"), skipped), None);
    }

    #[test]
    fn log_paths_skip_nothing_and_the_desktop_logs_belong_to_this_mac() {
        let logs = Path::new("/Users/jane/wt").join(LOGS_DIR);
        assert_eq!(logs, Path::new("/Users/jane/wt/.hunt/logs"));
        let skipped = StreamKind::Logs.skipped_folder();
        assert_eq!(relative_path(&logs, &logs.join("desktop/start-web.log"), skipped).as_deref(), Some("desktop/start-web.log"));
        assert_eq!(relative_path(&logs, &logs.join("memory/x.log"), skipped).as_deref(), Some("memory/x.log"));
        let folders = Folders::of(StreamKind::Logs, Path::new("/Users/jane/wt"), "/home/agent/app").unwrap();
        assert_eq!((folders.local, folders.watched, folders.remote.as_str()), (logs.clone(), logs.join("desktop"), "/home/agent/logs"));
        assert!(folders.replacements.to_local.is_empty() && folders.replacements.to_remote.is_empty());
    }

    #[test]
    fn forgetting_the_pulled_logs_keeps_the_desktop_ones() {
        let worktree = tempfile::tempdir().unwrap();
        assert_eq!(forget_pulled_logs(worktree.path()), Ok(()));
        assert_eq!(forget_pulled_logs(Path::new("")), Ok(()));
        let logs = worktree.path().join(LOGS_DIR);
        std::fs::create_dir_all(logs.join("desktop")).unwrap();
        std::fs::create_dir_all(logs.join("tmux")).unwrap();
        std::fs::write(logs.join("desktop/start-web.log"), "mine\n").unwrap();
        std::fs::write(logs.join("tmux/app.log"), "theirs\n").unwrap();
        std::fs::write(logs.join("hunt-service.log"), "theirs\n").unwrap();
        std::fs::write(logs.join("hunt-service.log.1"), "theirs\n").unwrap();

        forget_pulled_logs(worktree.path()).unwrap();
        let left: Vec<String> = std::fs::read_dir(&logs).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(left, ["desktop"]);
        assert_eq!(std::fs::read_to_string(logs.join("desktop/start-web.log")).unwrap(), "mine\n");
    }
}
