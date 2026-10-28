//! The live channel of a remote session's file sync: the sync helper on its VM (`apps/session/src/sync/sync-helper.main.ts`, run
//! over the shared SSH connection as the agent's user) reports each change in the VM's worktree as it happens, with the
//! content of small files, and applies the writes, links and deletions this side sends, answering with the states they
//! left. Messages are JSON lines both ways; modification times travel as decimal strings of nanoseconds, which exceed
//! what a JSON number holds exactly. Knows nothing about Tauri.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use super::ssh::Ssh;
use super::sync::{FileState, Listing};
use crate::platform::shell::shell_command;

/// The sync helper of the installed session release and the Node that runs it.
const HELPER: &str = "/srv/hunt/current/session/syncHelper.mjs";
const NODE: &str = "/opt/hunt/node/bin/node";

/// The largest file whose content goes through the channel; larger ones move with rsync.
pub const INLINE_LIMIT: u64 = 1 << 20;

/// How long the helper may take to list and watch the worktree, and to apply one request.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const APPLY_TIMEOUT: Duration = Duration::from_secs(60);

/// A path that changed on the VM: its state there now (`None` once gone), whether Git lists it there (an ignored file is
/// never synced) and, for a listed file small enough, its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteChange {
    pub path: String,
    pub state: Option<FileState>,
    pub listed: bool,
    pub content: Option<Content>,
}

/// The content of a changed file on the VM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    File(Vec<u8>),
    /// A link, by its target.
    Link(String),
}

/// What the helper reports besides the answers to requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Changes(Vec<RemoteChange>),
    /// The VM's `HEAD` may have moved.
    Head,
    /// The helper cannot tell the changes file by file (ignore rules changed, a watch failed); a full sync is due.
    Resync(String),
    /// The channel ended, with what the helper or ssh said last.
    Closed(String),
}

/// A file to write on the VM with its content, execute bit and modification time.
pub struct FileWrite {
    pub path: String,
    pub data: Vec<u8>,
    pub state: FileState,
}

/// A link to make on the VM.
pub struct LinkWrite {
    pub path: String,
    pub target: String,
    pub modified_ns: i64,
}

/// The open channel to the helper of one VM; dropping it ends the helper.
pub struct Channel {
    stdin: tokio::sync::Mutex<ChildStdin>,
    acks: Arc<Mutex<HashMap<u64, oneshot::Sender<Listing>>>>,
    next_id: AtomicU64,
    _child: Child,
}

impl Channel {
    /// Starts the helper for the `worktree` on the VM behind `ssh` and returns once it watches the worktree; every later
    /// report goes to `on_event`, the last being `Event::Closed`.
    pub async fn open(ssh: &Ssh, worktree: &str, on_event: impl Fn(Event) + Send + 'static) -> Result<Channel, String> {
        let command = shell_command("sudo", &["-n", "-u", "agent", NODE, HELPER, worktree]);
        let mut child = ssh.spawn(&command)?;
        let stdin = child.stdin.take().ok_or("failed to open the stdin of the sync helper")?;
        let stdout = child.stdout.take().ok_or("failed to open the output of the sync helper")?;
        let mut stderr = child.stderr.take().ok_or("failed to open the errors of the sync helper")?;
        let acks: Arc<Mutex<HashMap<u64, oneshot::Sender<Listing>>>> = Arc::default();
        let (ready, is_ready) = oneshot::channel();
        let reader_acks = acks.clone();
        tokio::spawn(async move {
            let errors = tokio::spawn(async move {
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes).await;
                String::from_utf8_lossy(&bytes).trim().to_string()
            });
            let mut ready = Some(ready);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match parse_message(&line) {
                    Ok(Message::Ready) => {
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(());
                        }
                    }
                    Ok(Message::Ack(id, states)) => {
                        if let Some(sender) = reader_acks.lock().unwrap().remove(&id) {
                            let _ = sender.send(states);
                        }
                    }
                    Ok(Message::Event(event)) => on_event(event),
                    Ok(Message::Error(message)) => eprintln!("the sync helper on the VM refused a request: {message}"),
                    Err(error) => eprintln!("the sync helper on the VM sent a message Hunt cannot read: {error}"),
                }
            }
            reader_acks.lock().unwrap().clear();
            let said = errors.await.unwrap_or_default();
            on_event(Event::Closed(if said.is_empty() { "the sync helper on the VM ended".into() } else { said }));
        });
        match tokio::time::timeout(READY_TIMEOUT, is_ready).await {
            Ok(Ok(())) => Ok(Channel { stdin: tokio::sync::Mutex::new(stdin), acks, next_id: AtomicU64::new(1), _child: child }),
            Ok(Err(_)) => Err("failed to start the sync helper on the VM: it ended before it watched the worktree".into()),
            Err(_) => Err(format!("failed to start the sync helper on the VM: it did not watch the worktree within {} s", READY_TIMEOUT.as_secs())),
        }
    }

    /// Writes `files`, makes `links` and deletes `deletes` in the VM's worktree, and returns the state each of these
    /// paths has afterwards; a path missing from the result is gone there.
    pub async fn apply(&self, files: &[FileWrite], links: &[LinkWrite], deletes: &[String]) -> Result<Listing, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, answer) = oneshot::channel();
        self.acks.lock().unwrap().insert(id, sender);
        let mut line = serde_json::to_vec(&apply_request(id, files, links, deletes)).map_err(|error| format!("failed to update the files on the VM: {error}"))?;
        line.push(b'\n');
        let written = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(&line).await?;
            stdin.flush().await
        };
        if let Err(error) = written.await {
            self.acks.lock().unwrap().remove(&id);
            return Err(format!("failed to update the files on the VM: the sync helper is gone: {error}"));
        }
        match tokio::time::timeout(APPLY_TIMEOUT, answer).await {
            Ok(Ok(states)) => Ok(states),
            Ok(Err(_)) => Err("failed to update the files on the VM: the sync helper ended".into()),
            Err(_) => {
                self.acks.lock().unwrap().remove(&id);
                Err(format!("failed to update the files on the VM: the sync helper did not answer within {} s", APPLY_TIMEOUT.as_secs()))
            }
        }
    }
}

/// A message of the helper, read.
#[derive(Debug, PartialEq, Eq)]
enum Message {
    Ready,
    Ack(u64, Listing),
    Event(Event),
    Error(String),
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Incoming {
    Ready,
    Changes { files: Vec<WireChange> },
    Ack { id: u64, files: Vec<WireAcked> },
    Head,
    Resync { reason: String },
    Error { message: String },
}

#[derive(Deserialize)]
struct WireChange {
    path: String,
    state: Option<WireState>,
    listed: bool,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    target: Option<String>,
}

#[derive(Deserialize)]
struct WireAcked {
    path: String,
    state: Option<WireState>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireState {
    size: u64,
    modified_ns: String,
    executable: bool,
    link: bool,
}

impl WireState {
    fn read(&self) -> Result<FileState, String> {
        let modified_ns = self.modified_ns.parse().map_err(|_| format!("the modification time {} is no number", self.modified_ns))?;
        // A link's mode carries no execute bit worth syncing (Linux reports 0777), as in the listings.
        Ok(FileState { size: self.size, modified_ns, executable: self.executable && !self.link, link: self.link })
    }
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Outgoing<'a> {
    Apply { id: u64, writes: Vec<WireWrite>, links: Vec<WireLink<'a>>, deletes: &'a [String] },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireWrite {
    path: String,
    data: String,
    executable: bool,
    modified_ns: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireLink<'a> {
    path: &'a str,
    target: &'a str,
    modified_ns: String,
}

fn apply_request<'a>(id: u64, files: &[FileWrite], links: &'a [LinkWrite], deletes: &'a [String]) -> Outgoing<'a> {
    let engine = base64::engine::general_purpose::STANDARD;
    let writes = files
        .iter()
        .map(|file| WireWrite {
            path: file.path.clone(),
            data: engine.encode(&file.data),
            executable: file.state.executable,
            modified_ns: file.state.modified_ns.to_string(),
        })
        .collect();
    let links = links.iter().map(|link| WireLink { path: &link.path, target: &link.target, modified_ns: link.modified_ns.to_string() }).collect();
    Outgoing::Apply { id, writes, links, deletes }
}

/// Reads one line of the helper.
fn parse_message(line: &str) -> Result<Message, String> {
    let incoming: Incoming = serde_json::from_str(line).map_err(|error| error.to_string())?;
    Ok(match incoming {
        Incoming::Ready => Message::Ready,
        Incoming::Head => Message::Event(Event::Head),
        Incoming::Resync { reason } => Message::Event(Event::Resync(reason)),
        Incoming::Error { message } => Message::Error(message),
        Incoming::Ack { id, files } => {
            let mut states = Listing::new();
            for file in files {
                if let Some(state) = file.state {
                    states.insert(file.path, state.read()?);
                }
            }
            Message::Ack(id, states)
        }
        Incoming::Changes { files } => {
            let engine = base64::engine::general_purpose::STANDARD;
            let mut changes = Vec::with_capacity(files.len());
            for file in files {
                let state = file.state.as_ref().map(WireState::read).transpose()?;
                let content = match (file.data, file.target) {
                    (_, Some(target)) => Some(Content::Link(target)),
                    (Some(data), None) => Some(Content::File(engine.decode(data).map_err(|error| format!("{}: {error}", file.path))?)),
                    (None, None) => None,
                };
                changes.push(RemoteChange { path: file.path, state, listed: file.listed, content });
            }
            Message::Event(Event::Changes(changes))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_changes_with_content_links_and_gone_files() {
        let line = r#"{"t":"changes","files":[
            {"path":"src/a.ts","state":{"size":2,"modifiedNs":"1792345678123456789","executable":false,"link":false},"listed":true,"data":"aGk="},
            {"path":"bin/run","state":{"size":7,"modifiedNs":"1792345678000000000","executable":false,"link":true},"listed":true,"target":"../run.sh"},
            {"path":"big.bin","state":{"size":5000000,"modifiedNs":"1","executable":true,"link":false},"listed":true},
            {"path":"dist/out.js","state":{"size":1,"modifiedNs":"1","executable":false,"link":false},"listed":false},
            {"path":"old.ts","state":null,"listed":true}]}"#
            .replace('\n', "");
        let Ok(Message::Event(Event::Changes(changes))) = parse_message(&line) else { panic!("no changes") };
        assert_eq!(changes[0].state.unwrap().modified_ns, 1_792_345_678_123_456_789);
        assert_eq!(changes[0].content, Some(Content::File(b"hi".to_vec())));
        assert_eq!(changes[1].content, Some(Content::Link("../run.sh".into())));
        assert!(changes[2].content.is_none() && changes[2].state.unwrap().executable);
        assert!(!changes[3].listed);
        assert_eq!(changes[4], RemoteChange { path: "old.ts".into(), state: None, listed: true, content: None });
    }

    #[test]
    fn reads_acks_and_the_other_reports() {
        let ack = r#"{"t":"ack","id":3,"files":[{"path":"a","state":{"size":1,"modifiedNs":"5","executable":false,"link":false}},{"path":"b","state":null}]}"#;
        let state = FileState { size: 1, modified_ns: 5, executable: false, link: false };
        assert_eq!(parse_message(ack), Ok(Message::Ack(3, Listing::from([("a".to_string(), state)]))));
        assert_eq!(parse_message(r#"{"t":"ready"}"#), Ok(Message::Ready));
        assert_eq!(parse_message(r#"{"t":"head"}"#), Ok(Message::Event(Event::Head)));
        assert_eq!(parse_message(r#"{"t":"resync","reason":".gitignore changed"}"#), Ok(Message::Event(Event::Resync(".gitignore changed".into()))));
        assert!(parse_message(r#"{"t":"ack","id":1,"files":[{"path":"a","state":{"size":1,"modifiedNs":"x","executable":false,"link":false}}]}"#).is_err());
        assert!(parse_message("not json").is_err());
    }

    #[test]
    fn an_apply_request_carries_content_as_base64_and_times_as_strings() {
        let state = FileState { size: 2, modified_ns: 1_792_345_678_123_456_789, executable: true, link: false };
        let files = [FileWrite { path: "run.sh".into(), data: b"hi".to_vec(), state }];
        let links = [LinkWrite { path: "l".into(), target: "run.sh".into(), modified_ns: 7 }];
        let request = serde_json::to_value(apply_request(4, &files, &links, &["gone.ts".to_string()])).unwrap();
        assert_eq!(
            request,
            serde_json::json!({
                "t": "apply", "id": 4,
                "writes": [{ "path": "run.sh", "data": "aGk=", "executable": true, "modifiedNs": "1792345678123456789" }],
                "links": [{ "path": "l", "target": "run.sh", "modifiedNs": "7" }],
                "deletes": ["gone.ts"]
            })
        );
    }
}
