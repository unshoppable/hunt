//! The live channel of a remote session's transcript stream: the transcript helper on its VM
//! (`apps/session/src/sync/transcripts.ts`, run over the shared SSH connection as the agent's user) reports the files of
//! the agent's Claude Code project folder as they grow, from the offsets this side holds, and appends what this side
//! sends to the files this side owns, answering with the size they have afterwards. Messages are JSON lines both ways
//! (`apps/session/src/sync/transcriptProtocol.ts`). Knows nothing about Tauri.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use super::shell_command;
use super::ssh::Ssh;

/// The transcript helper of the installed session release and the Node that runs it.
const HELPER: &str = "/srv/hunt/current/session/transcriptHelper.mjs";
const NODE: &str = "/opt/hunt/node/bin/node";

/// How long the helper may take to watch the folder, and to apply one write.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// What the helper reports besides the answers to writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The bytes from `offset` of the file at `path`, whose size is `size` now.
    File { path: String, offset: u64, data: Vec<u8>, size: u64 },
    /// The file shrank or was replaced; its content follows from the start.
    Reset(String),
    /// The file was deleted.
    Gone(String),
    /// The channel ended, with what the helper or ssh said last.
    Closed(String),
}

/// Why the helper refused a write: the file on the VM is not as long as the write expected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

/// The open channel to the transcript helper of one VM; dropping it ends the helper.
pub struct TranscriptChannel {
    stdin: tokio::sync::Mutex<ChildStdin>,
    acks: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<u64, Refused>>>>>,
    next_id: AtomicU64,
    _child: Child,
}

impl TranscriptChannel {
    /// Starts the helper for the project folder `project` on the VM behind `ssh` and returns once it watches the folder;
    /// every later report goes to `on_event`, the last being `Event::Closed`.
    pub async fn open(ssh: &Ssh, project: &str, on_event: impl Fn(Event) + Send + 'static) -> Result<TranscriptChannel, String> {
        let command = shell_command("sudo", &["-n", "-u", "agent", NODE, HELPER, project]);
        let mut child = ssh.spawn(&command)?;
        let stdin = child.stdin.take().ok_or("failed to open the stdin of the transcript helper")?;
        let stdout = child.stdout.take().ok_or("failed to open the output of the transcript helper")?;
        let mut stderr = child.stderr.take().ok_or("failed to open the errors of the transcript helper")?;
        let acks: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<u64, Refused>>>>> = Arc::default();
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
                    Ok(Message::Ack(id, result)) => {
                        if let Some(sender) = reader_acks.lock().unwrap().remove(&id) {
                            let _ = sender.send(result);
                        }
                    }
                    Ok(Message::Event(event)) => on_event(event),
                    Ok(Message::Error(message)) => eprintln!("the transcript helper on the VM refused a request: {message}"),
                    Err(error) => eprintln!("the transcript helper on the VM sent a message Hunt cannot read: {error}"),
                }
            }
            reader_acks.lock().unwrap().clear();
            let said = errors.await.unwrap_or_default();
            on_event(Event::Closed(if said.is_empty() { "the transcript helper on the VM ended".into() } else { said }));
        });
        match tokio::time::timeout(READY_TIMEOUT, is_ready).await {
            Ok(Ok(())) => Ok(TranscriptChannel { stdin: tokio::sync::Mutex::new(stdin), acks, next_id: AtomicU64::new(1), _child: child }),
            Ok(Err(_)) => Err("failed to start the transcript helper on the VM: it ended before it watched the folder".into()),
            Err(_) => Err(format!("failed to start the transcript helper on the VM: it did not watch the folder within {} s", READY_TIMEOUT.as_secs())),
        }
    }

    /// Tells the helper what this side holds: per file the bytes of it, and the paths this side owns; the helper then
    /// reports what this side lacks.
    pub async fn sync(&self, files: &BTreeMap<String, u64>, owned: &[String]) -> Result<(), String> {
        self.send(&Outgoing::Sync { files, owned }).await
    }

    /// Asks for the file at `path` from `offset` again.
    pub async fn read(&self, path: &str, offset: u64) -> Result<(), String> {
        self.send(&Outgoing::Read { path, offset }).await
    }

    /// Appends `data` to the file at `path` on the VM, which must be `offset` bytes long, or with `truncate` replaces
    /// its content; returns the file's size afterwards, or why the helper refused the write. The outer error means the
    /// helper could not be reached.
    pub async fn write(&self, path: &str, offset: u64, data: &[u8], truncate: bool) -> Result<Result<u64, Refused>, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, answer) = oneshot::channel();
        self.acks.lock().unwrap().insert(id, sender);
        let data = base64::engine::general_purpose::STANDARD.encode(data);
        if let Err(error) = self.send(&Outgoing::Write { id, path, offset, data: &data, truncate }).await {
            self.acks.lock().unwrap().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(WRITE_TIMEOUT, answer).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err("failed to write the transcript on the VM: the transcript helper ended".into()),
            Err(_) => {
                self.acks.lock().unwrap().remove(&id);
                Err(format!("failed to write the transcript on the VM: the transcript helper did not answer within {} s", WRITE_TIMEOUT.as_secs()))
            }
        }
    }

    async fn send(&self, message: &Outgoing<'_>) -> Result<(), String> {
        let mut line = serde_json::to_vec(message).map_err(|error| format!("failed to talk to the transcript helper: {error}"))?;
        line.push(b'\n');
        let written = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(&line).await?;
            stdin.flush().await
        };
        written.await.map_err(|error| format!("failed to talk to the transcript helper: it is gone: {error}"))
    }
}

/// A message of the helper, read.
#[derive(Debug, PartialEq, Eq)]
enum Message {
    Ready,
    Ack(u64, Result<u64, Refused>),
    Event(Event),
    Error(String),
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Incoming {
    Ready,
    File { path: String, offset: u64, data: String, size: u64 },
    Reset { path: String },
    Gone { path: String },
    Ack { id: u64, size: Option<u64>, error: Option<String> },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Outgoing<'a> {
    Sync { files: &'a BTreeMap<String, u64>, owned: &'a [String] },
    Read { path: &'a str, offset: u64 },
    Write { id: u64, path: &'a str, offset: u64, data: &'a str, truncate: bool },
}

/// Reads one line of the helper.
fn parse_message(line: &str) -> Result<Message, String> {
    let incoming: Incoming = serde_json::from_str(line).map_err(|error| error.to_string())?;
    Ok(match incoming {
        Incoming::Ready => Message::Ready,
        Incoming::Reset { path } => Message::Event(Event::Reset(path)),
        Incoming::Gone { path } => Message::Event(Event::Gone(path)),
        Incoming::Error { message } => Message::Error(message),
        Incoming::Ack { id, size, error } => match (size, error) {
            (_, Some(error)) => Message::Ack(id, Err(Refused(error))),
            (Some(size), None) => Message::Ack(id, Ok(size)),
            (None, None) => return Err(format!("the ack of write {id} carries neither a size nor an error")),
        },
        Incoming::File { path, offset, data, size } => {
            let data = base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| format!("{path}: {error}"))?;
            Message::Event(Event::File { path, offset, data, size })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_file_chunks_resets_gone_files_and_acks() {
        let file = r#"{"t":"file","path":"abc.jsonl","offset":40,"data":"aGk=","size":42}"#;
        assert_eq!(parse_message(file), Ok(Message::Event(Event::File { path: "abc.jsonl".into(), offset: 40, data: b"hi".to_vec(), size: 42 })));
        assert_eq!(parse_message(r#"{"t":"reset","path":"abc.jsonl"}"#), Ok(Message::Event(Event::Reset("abc.jsonl".into()))));
        assert_eq!(parse_message(r#"{"t":"gone","path":"abc.jsonl"}"#), Ok(Message::Event(Event::Gone("abc.jsonl".into()))));
        assert_eq!(parse_message(r#"{"t":"ack","id":3,"size":42}"#), Ok(Message::Ack(3, Ok(42))));
        assert_eq!(parse_message(r#"{"t":"ack","id":4,"error":"sub.jsonl is 42 bytes long, not 5"}"#), Ok(Message::Ack(4, Err(Refused("sub.jsonl is 42 bytes long, not 5".into())))));
        assert_eq!(parse_message(r#"{"t":"ready"}"#), Ok(Message::Ready));
        assert_eq!(parse_message(r#"{"t":"error","message":"malformed request: not JSON"}"#), Ok(Message::Error("malformed request: not JSON".into())));
        assert!(parse_message(r#"{"t":"ack","id":5}"#).is_err());
        assert!(parse_message(r#"{"t":"file","path":"a","offset":0,"data":"*","size":1}"#).is_err());
        assert!(parse_message("not json").is_err());
    }

    #[test]
    fn requests_carry_offsets_as_numbers_and_content_as_base64() {
        let files = BTreeMap::from([("abc.jsonl".to_string(), 40u64)]);
        let owned = ["sub.jsonl".to_string()];
        let sync = serde_json::to_value(Outgoing::Sync { files: &files, owned: &owned }).unwrap();
        assert_eq!(sync, serde_json::json!({ "t": "sync", "files": { "abc.jsonl": 40 }, "owned": ["sub.jsonl"] }));
        let read = serde_json::to_value(Outgoing::Read { path: "abc.jsonl", offset: 7 }).unwrap();
        assert_eq!(read, serde_json::json!({ "t": "read", "path": "abc.jsonl", "offset": 7 }));
        let write = serde_json::to_value(Outgoing::Write { id: 2, path: "sub.jsonl", offset: 0, data: "aGk=", truncate: true }).unwrap();
        assert_eq!(write, serde_json::json!({ "t": "write", "id": 2, "path": "sub.jsonl", "offset": 0, "data": "aGk=", "truncate": true }));
    }
}
