//! Keeps the Claude Code transcripts of a connected remote session in step with its VM, live and both ways
//! (`remote::transcript_sync`): the transcript helper on the VM (`remote::transcript_channel`) reports the files of the
//! agent's project folder there as they grow, which land in the local project folder of the worktree with their paths
//! moved here, and the watcher of that local folder reports the files this Mac owns, the transcripts of the session's
//! sub chats (which run here), which go to the VM the same way. So a sub chat can read the running turn of its session
//! and the agent on the VM what its sub chats did. The stream starts and stops with the file sync of the session
//! (`session::sync`); while its channel is down, nothing moves, and the file sync's per-turn backup covers the VM's
//! transcript as before. When the channel (re)opens, the helper is told what this Mac holds and every owned file is
//! pushed, so only what is missing moves.

use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::AppHandle;
use uuid::Uuid;

use crate::remote::claude_dir;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::transcript::{local_project, remote_project, Replacements};
use crate::remote::transcript_channel::{Event, Refused, TranscriptChannel};
use crate::remote::transcript_sync::{is_owned, Applied, TranscriptSync};
use crate::session::store;
use crate::session::sync::CHANNEL_RETRY;

/// How long the watcher gathers local changes before they are pushed.
const LOCAL_DEBOUNCE: Duration = Duration::from_millis(50);
/// The folder of the repository memory in a project folder, which the retrieval merges rather than the stream moves.
const MEMORY_FOLDER: &str = "memory";

/// The transcript stream of one connected remote session.
#[derive(Default)]
pub struct TranscriptLink {
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

/// Starts the stream of the remote session `id` into `link`: watches the local project folder of its worktree and keeps
/// the channel to the helper on its VM open. Does nothing while the session's worktree on the VM is not known yet (an
/// adopted session before its first sync), or when the stream runs already.
pub fn start(app: &AppHandle, id: Uuid, link: &Arc<TranscriptLink>) -> Result<(), String> {
    if link.task.lock().unwrap().is_some() || link.is_stopped.load(Ordering::SeqCst) {
        return Ok(());
    }
    let record = store::find_session(app, id)?;
    let target = record.remote.ok_or("the session runs locally")?;
    if target.worktree_path.as_os_str().is_empty() {
        return Ok(());
    }
    let remote_worktree = target.worktree_path.display().to_string();
    let claude = claude_dir()?;
    let local = local_project(&record.worktree_path, &claude);
    std::fs::create_dir_all(&local).map_err(|error| format!("failed to create {}: {error}", local.display()))?;
    let state_path = store::app_data_dir(app)?.join("remote-sync").join(format!("{id}.transcripts.json"));
    let stream = TranscriptSync::load(state_path, local.clone(), Replacements::new(&record.worktree_path, &claude, &remote_worktree));
    *link.stream.try_lock().map_err(|_| "the stream is busy".to_string())? = Some(stream);
    watch(app, id, link, &local);
    open_channel(app, id, link, remote_project(&remote_worktree));
    Ok(())
}

/// Watches the local project folder `project` of `id` and has the files that change there pushed; a failure is only
/// logged, the push after the channel opened still covers them.
fn watch(app: &AppHandle, id: Uuid, link: &Arc<TranscriptLink>, project: &Path) {
    let handle = app.clone();
    let root = project.to_path_buf();
    let reports = Arc::downgrade(link);
    let debouncer = new_debouncer(LOCAL_DEBOUNCE, None, move |result: DebounceEventResult| {
        let Some(link) = reports.upgrade() else { return };
        let Ok(events) = result else { return };
        let paths: BTreeSet<String> = events.iter().flat_map(|event| &event.paths).filter_map(|path| project_path(&root, path)).collect();
        if paths.is_empty() {
            return;
        }
        link.local_paths.lock().unwrap().extend(paths);
        drive(&handle, id, link);
    });
    let watched = debouncer.map_err(|error| error.to_string()).and_then(|mut debouncer| {
        debouncer.watch(project, RecursiveMode::Recursive).map_err(|error| error.to_string())?;
        Ok(debouncer)
    });
    match watched {
        Ok(debouncer) => {
            *link.watcher.lock().unwrap() = Some(debouncer);
        }
        Err(error) => eprintln!("watching the transcripts of session {id} failed: {error}"),
    }
}

/// The project-relative path of a change at `path` inside `project`, outside the memory folder.
fn project_path(project: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(project).ok()?;
    if relative.components().next().is_some_and(|first| first.as_os_str() == MEMORY_FOLDER) {
        return None;
    }
    relative.to_str().filter(|relative| !relative.is_empty()).map(str::to_string)
}

/// Keeps the channel to the transcript helper for the project folder `remote` on the VM of `id` open while the session
/// syncs, as `session::sync::open_channel` does for the file sync. A VM whose release lacks the helper keeps failing
/// quietly.
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
                    eprintln!("the transcript channel of session {id} ended: {reason}");
                }
                Err(error) => {
                    if failures == 0 {
                        eprintln!("opening the transcript channel of session {id} failed: {error}");
                    }
                    failures += 1;
                }
            }
            tokio::time::sleep(CHANNEL_RETRY[failures.min(CHANNEL_RETRY.len() - 1)]).await;
        }
    });
    *link.task.lock().unwrap() = Some(task);
}

/// Opens the channel to the transcript helper for `remote` on the VM of `id`; its reports land in `link`, and `closed`
/// gets why it ended.
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
                eprintln!("streaming the transcripts of session {id} failed: {error}");
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
    let owned_ids: HashSet<String> = store::sub_chat_acp_ids(app, id)?.into_iter().collect();
    let mut to_push = paths;
    if wants_sync {
        let (files, owned) = stream.sync_request();
        channel.sync(&files, &owned).await?;
        to_push.extend(stream.owned_paths(&owned_ids)?);
    }
    for event in events {
        match stream.apply(event, &owned_ids) {
            Ok(Applied::Read { path, offset }) => channel.read(&path, offset).await?,
            Ok(Applied::Done) => {}
            Err(error) => eprintln!("applying a transcript report of session {id} failed: {error}"),
        }
    }
    for path in to_push {
        if !is_owned(&path, &owned_ids) {
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
                if has_started_over {
                    return Err(format!("the VM refused the transcript {path} twice: {reason}"));
                }
                eprintln!("the VM refused the transcript {path}, which is sent from the start again: {reason}");
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
        assert_eq!(project_path(project, &project.join("abc.jsonl")).as_deref(), Some("abc.jsonl"));
        assert_eq!(project_path(project, &project.join("abc/tool-results/1.txt")).as_deref(), Some("abc/tool-results/1.txt"));
        assert_eq!(project_path(project, &project.join("memory/MEMORY.md")), None);
        assert_eq!(project_path(project, project), None);
        assert_eq!(project_path(project, Path::new("/tmp/elsewhere.jsonl")), None);
    }
}
