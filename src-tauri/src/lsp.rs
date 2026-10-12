//! One TypeScript language server (`tsgo --lsp --stdio`) per worktree. A server starts on first use, is shared by
//! every session of its worktree and is bridged to the webview through generic JSON-RPC commands (`lsp_request`,
//! `lsp_notify`, `lsp_cancel`) plus the `lsp:diagnostics` and `lsp:exited` events.
//!
//! `LspServer` is the Tauri-free core (spawn, handshake, request, notify); `LspRegistry` and the commands add the
//! per-worktree sharing and the event emission.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, watch, OnceCell};
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::session::store;

/// Client settings: pushed with `workspace/didChangeConfiguration` after the handshake and returned for every
/// `workspace/configuration` item of section `typescript`.
const SETTINGS_JSON: &str = r#"{
  "typescript": {
    "inlayHints": {
      "parameterNames": { "enabled": "literals", "suppressWhenArgumentMatchesName": true },
      "parameterTypes": { "enabled": true },
      "variableTypes": { "enabled": true },
      "propertyDeclarationTypes": { "enabled": true },
      "functionLikeReturnTypes": { "enabled": true },
      "enumMemberValues": { "enabled": true }
    }
  }
}"#;

static SETTINGS: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(SETTINGS_JSON).expect("SETTINGS_JSON is valid JSON"));

const EXITED: &str = "language server exited";
const NOT_FOUND: &str = "tsgo not found (install @typescript/native-preview)";
const READ_CHUNK: usize = 64 * 1024;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Receives what a server reports on its own: diagnostics pushes and the end of its process.
pub trait LspEvents: Send + Sync + 'static {
    fn diagnostics(&self, worktree: &Path, uri: String, diagnostics: Value);
    fn exited(&self, server: &Arc<LspServer>);
}

type Pending = HashMap<i64, oneshot::Sender<Result<Value, String>>>;

/// A running `tsgo --lsp --stdio` process speaking JSON-RPC 2.0 over its stdio.
pub struct LspServer {
    worktree: PathBuf,
    pid: Option<u32>,
    /// Owned until the reader task reaps the process; everyone else only signals it.
    child: Mutex<Option<Child>>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicI64,
    /// Requests awaiting their response; `None` once the process ended, so late requests fail at once.
    pending: Mutex<Option<Pending>>,
    /// Cancellation tokens of in-flight requests mapped to their JSON-RPC id.
    tokens: Mutex<HashMap<String, i64>>,
    /// Set once the `initialize` handshake finished; requests and notifications wait for it.
    ready: OnceCell<()>,
    /// Flips to `true` after the process was reaped.
    exited: watch::Sender<bool>,
}

impl LspServer {
    /// Spawns `tsgo --lsp --stdio` in `worktree` and begins the handshake; requests wait until it is done.
    pub fn start(worktree: PathBuf, events: Arc<dyn LspEvents>) -> Result<Arc<Self>, String> {
        let binary = resolve_tsgo(&worktree).ok_or(NOT_FOUND)?;
        let mut child = Command::new(binary)
            .args(["--lsp", "--stdio"])
            .current_dir(&worktree)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Its own process group: `tsgo` on PATH is usually a shim that spawns node, which spawns the native binary.
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to start tsgo: {error}"))?;
        let stdin = child.stdin.take().ok_or("tsgo stdin is not available")?;
        let stdout = child.stdout.take().ok_or("tsgo stdout is not available")?;

        let server = Arc::new(Self {
            worktree,
            pid: child.id(),
            child: Mutex::new(Some(child)),
            stdin: tokio::sync::Mutex::new(stdin),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(Some(HashMap::new())),
            tokens: Mutex::default(),
            ready: OnceCell::new(),
            exited: watch::channel(false).0,
        });
        tokio::spawn(read_loop(server.clone(), stdout, events));
        let handshake = server.clone();
        tokio::spawn(async move {
            let _ = handshake.ensure_ready().await;
        });
        Ok(server)
    }

    /// Sends a request once the handshake is done and resolves with its `result` (`Null` when the server returns
    /// null) or the error as `"<code>: <message>"`. `token` lets `cancel` abort the request while it is pending.
    pub async fn request(&self, method: &str, params: Value, token: Option<String>) -> Result<Value, String> {
        self.ensure_ready().await?;
        self.send_request(method, params, token).await
    }

    /// Sends a notification once the handshake is done.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.ensure_ready().await?;
        self.write(&message(None, method, params)).await
    }

    /// Sends `$/cancelRequest` for the request registered under `token`; a no-op for unknown or answered requests.
    pub async fn cancel(&self, token: &str) -> Result<(), String> {
        let Some(id) = self.tokens.lock().unwrap().remove(token) else {
            return Ok(());
        };
        let is_pending = self.pending.lock().unwrap().as_ref().is_some_and(|pending| pending.contains_key(&id));
        if !is_pending {
            return Ok(());
        }
        self.write(&message(None, "$/cancelRequest", json!({ "id": id }))).await
    }

    /// Kills the process and waits (bounded) until it was reaped.
    pub async fn stop(&self) {
        self.kill();
        let _ = tokio::time::timeout(EXIT_TIMEOUT, self.wait_exited()).await;
    }

    /// Asks the server to end with `shutdown` and `exit`, each bounded, then kills whatever is still running.
    pub async fn shutdown(&self) {
        let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, self.send_request("shutdown", Value::Null, None)).await;
        let _ = self.write(&message(None, "exit", Value::Null)).await;
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, self.wait_exited()).await.is_err() {
            self.stop().await;
        }
    }

    async fn ensure_ready(&self) -> Result<(), String> {
        match self.ready.get_or_try_init(|| self.handshake()).await {
            Ok(_) => Ok(()),
            Err(error) => {
                self.kill();
                Err(error)
            }
        }
    }

    /// `initialize` → `initialized` → `workspace/didChangeConfiguration`.
    async fn handshake(&self) -> Result<(), String> {
        let root_uri = file_uri(&self.worktree);
        let name = self.worktree.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let params = json!({
            "processId": self.pid,
            "rootUri": root_uri,
            "workspaceFolders": [{ "uri": root_uri, "name": name }],
            "capabilities": {
                "workspace": { "configuration": true, "didChangeConfiguration": {} },
                "textDocument": {
                    "completion": {
                        "completionItem": {
                            "snippetSupport": true,
                            "commitCharactersSupport": true,
                            "documentationFormat": ["markdown", "plaintext"],
                            "deprecatedSupport": true,
                            "preselectSupport": true,
                            "tagSupport": { "valueSet": [1] },
                            "insertReplaceSupport": true,
                            "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] },
                            "labelDetailsSupport": true
                        },
                        "contextSupport": true,
                        "completionList": { "itemDefaults": ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode", "data"] }
                    },
                    "signatureHelp": {
                        "signatureInformation": {
                            "documentationFormat": ["markdown", "plaintext"],
                            "parameterInformation": { "labelOffsetSupport": true },
                            "activeParameterSupport": true
                        },
                        "contextSupport": true
                    },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "definition": { "linkSupport": true },
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "inlayHint": {},
                    "publishDiagnostics": {},
                    "diagnostic": {}
                }
            }
        });
        self.send_request("initialize", params, None).await?;
        self.write(&message(None, "initialized", json!({}))).await?;
        let settings = json!({ "settings": *SETTINGS });
        self.write(&message(None, "workspace/didChangeConfiguration", settings)).await
    }

    async fn send_request(&self, method: &str, params: Value, token: Option<String>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            let Some(pending) = pending.as_mut() else {
                return Err(EXITED.into());
            };
            pending.insert(id, sender);
        }
        if let Some(token) = &token {
            self.tokens.lock().unwrap().insert(token.clone(), id);
        }

        let outcome = match self.write(&message(Some(id), method, params)).await {
            Ok(()) => receiver.await.unwrap_or_else(|_| Err(EXITED.into())),
            Err(error) => {
                if let Some(pending) = self.pending.lock().unwrap().as_mut() {
                    pending.remove(&id);
                }
                Err(error)
            }
        };
        if let Some(token) = token {
            let mut tokens = self.tokens.lock().unwrap();
            if tokens.get(&token) == Some(&id) {
                tokens.remove(&token);
            }
        }
        outcome
    }

    /// Writes one framed message; the lock keeps frames of concurrent senders apart.
    async fn write(&self, message: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut stdin = self.stdin.lock().await;
        let written = async {
            stdin.write_all(header.as_bytes()).await?;
            stdin.write_all(&body).await?;
            stdin.flush().await
        };
        written.await.map_err(|error| format!("language server write failed: {error}"))
    }

    /// Routes one incoming message: answers server requests, forwards notifications, completes responses.
    async fn dispatch(&self, message: Value, events: &dyn LspEvents) {
        let Value::Object(mut message) = message else {
            return;
        };
        let method = message.remove("method");
        let id = message.remove("id");
        let params = message.remove("params").unwrap_or(Value::Null);
        match (method, id) {
            (Some(Value::String(method)), Some(id)) => {
                let result = answer_server_request(&method, &params);
                let _ = self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).await;
            }
            (Some(Value::String(method)), None) => {
                if method != "textDocument/publishDiagnostics" {
                    return;
                }
                let Value::Object(mut params) = params else {
                    return;
                };
                let Some(Value::String(uri)) = params.remove("uri") else {
                    return;
                };
                let diagnostics = params.remove("diagnostics").unwrap_or_else(|| Value::Array(Vec::new()));
                events.diagnostics(&self.worktree, uri, diagnostics);
            }
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else {
                    return;
                };
                let sender = self.pending.lock().unwrap().as_mut().and_then(|pending| pending.remove(&id));
                let Some(sender) = sender else {
                    return;
                };
                let outcome = match message.remove("error") {
                    Some(error) => Err(format!("{}: {}", error["code"], text_of(&error["message"]))),
                    None => Ok(message.remove("result").unwrap_or(Value::Null)),
                };
                let _ = sender.send(outcome);
            }
            _ => {}
        }
    }

    /// Fails every pending request, reaps the process and announces the end.
    async fn finish(self: &Arc<Self>, events: &dyn LspEvents) {
        let pending = self.pending.lock().unwrap().take();
        for (_, sender) in pending.into_iter().flatten() {
            let _ = sender.send(Err(EXITED.into()));
        }
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            kill_group(&mut child);
            let _ = child.wait().await;
        }
        self.exited.send_replace(true);
        events.exited(self);
    }

    fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            kill_group(child);
        }
    }

    async fn wait_exited(&self) {
        let _ = self.exited.subscribe().wait_for(|exited| *exited).await;
    }
}

/// Reads stdout until EOF, dispatching every complete frame, then finishes the server.
async fn read_loop(server: Arc<LspServer>, mut stdout: ChildStdout, events: Arc<dyn LspEvents>) {
    let mut decoder = FrameDecoder::default();
    'read: loop {
        decoder.buffer.reserve(READ_CHUNK);
        match stdout.read_buf(&mut decoder.buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        loop {
            match decoder.next_message() {
                Ok(Some(message)) => server.dispatch(message, events.as_ref()).await,
                Ok(None) => break,
                Err(_) => break 'read,
            }
        }
    }
    server.finish(events.as_ref()).await;
}

/// Sends SIGKILL to the process group led by `child` (every shim layer plus the native server). `child` is not
/// reaped yet, so its id still names that group.
pub fn kill_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SAFETY: plain syscall without pointers; a negative pid addresses the whole group.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

/// Splits a byte stream into `Content-Length`-framed JSON-RPC messages, parsing each body in place.
#[derive(Default)]
struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    /// Parses and removes the first complete message; `Ok(None)` while the buffer holds only part of a frame.
    fn next_message(&mut self) -> Result<Option<Value>, String> {
        let Some(header_end) = find(&self.buffer, b"\r\n\r\n") else {
            return Ok(None);
        };
        let header = std::str::from_utf8(&self.buffer[..header_end]).map_err(|_| "malformed frame header")?;
        let length = header
            .split("\r\n")
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if !name.trim().eq_ignore_ascii_case("content-length") {
                    return None;
                }
                value.trim().parse::<usize>().ok()
            })
            .ok_or("frame without Content-Length")?;
        let body_start = header_end + 4;
        let body_end = body_start + length;
        if self.buffer.len() < body_end {
            return Ok(None);
        }
        let message = serde_json::from_slice(&self.buffer[body_start..body_end])
            .map_err(|error| format!("malformed frame body: {error}"));
        self.buffer.drain(..body_end);
        message.map(Some)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// A JSON-RPC request (`id` given) or notification; `Null` params are left out.
fn message(id: Option<i64>, method: &str, params: Value) -> Value {
    let mut message = Map::with_capacity(4);
    message.insert("jsonrpc".into(), "2.0".into());
    if let Some(id) = id {
        message.insert("id".into(), id.into());
    }
    message.insert("method".into(), method.into());
    if !params.is_null() {
        message.insert("params".into(), params);
    }
    Value::Object(message)
}

/// The result for a server→client request: the `typescript` settings per matching `workspace/configuration` item,
/// `null` for everything else.
fn answer_server_request(method: &str, params: &Value) -> Value {
    if method != "workspace/configuration" {
        return Value::Null;
    }
    let items = params.get("items").and_then(Value::as_array);
    let answers = items.into_iter().flatten().map(|item| {
        if item.get("section").and_then(Value::as_str) == Some("typescript") {
            SETTINGS["typescript"].clone()
        } else {
            Value::Null
        }
    });
    Value::Array(answers.collect())
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `<worktree>/node_modules/.bin/tsgo` when present, else the first `tsgo` in a `PATH` directory.
fn resolve_tsgo(worktree: &Path) -> Option<PathBuf> {
    let local = worktree.join("node_modules/.bin/tsgo");
    if local.is_file() {
        return Some(local);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join("tsgo")).find(|candidate| candidate.is_file())
}

/// `file://` URI of `path` as Monaco's `Uri.file(path).toString()` produces it: only `/` and unreserved characters
/// stay literal, everything else is percent-encoded.
pub fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
            uri.push(byte as char);
        } else {
            let _ = write!(uri, "%{byte:02X}");
        }
    }
    uri
}

/// Running servers keyed by worktree, plus the worktree of every session that used the LSP so a request needs no
/// session store read.
#[derive(Default)]
pub struct LspRegistry {
    servers: Mutex<HashMap<PathBuf, Arc<LspServer>>>,
    worktrees: Mutex<HashMap<Uuid, PathBuf>>,
}

impl LspRegistry {
    /// The running server of `worktree`, started with `events` when there is none.
    pub fn get_or_start(&self, worktree: &Path, events: impl FnOnce() -> Arc<dyn LspEvents>) -> Result<Arc<LspServer>, String> {
        let mut servers = self.servers.lock().unwrap();
        if let Some(server) = servers.get(worktree) {
            return Ok(server.clone());
        }
        let server = LspServer::start(worktree.to_path_buf(), events())?;
        servers.insert(worktree.to_path_buf(), server.clone());
        Ok(server)
    }

    /// Drops `server` when it is still the registered server of its worktree.
    fn forget(&self, server: &Arc<LspServer>) {
        let mut servers = self.servers.lock().unwrap();
        if servers.get(&server.worktree).is_some_and(|current| Arc::ptr_eq(current, server)) {
            servers.remove(&server.worktree);
        }
    }
}

/// Kills the server of `worktree` (if any) and waits until its process is gone.
pub async fn stop_for_worktree(registry: &LspRegistry, worktree: &Path) {
    let server = registry.servers.lock().unwrap().remove(worktree);
    registry.worktrees.lock().unwrap().retain(|_, path| path != worktree);
    if let Some(server) = server {
        server.stop().await;
    }
}

/// Shuts every server down concurrently (graceful first, kill after a short timeout).
pub async fn shutdown_all(registry: &LspRegistry) {
    let servers: Vec<Arc<LspServer>> = registry.servers.lock().unwrap().drain().map(|(_, server)| server).collect();
    let mut tasks = JoinSet::new();
    for server in servers {
        tasks.spawn(async move { server.shutdown().await });
    }
    while tasks.join_next().await.is_some() {}
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsEvent {
    worktree_path: String,
    uri: String,
    diagnostics: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitedEvent {
    worktree_path: String,
}

/// Forwards server events to every window and unregisters ended servers.
struct TauriEvents(AppHandle);

impl LspEvents for TauriEvents {
    fn diagnostics(&self, worktree: &Path, uri: String, diagnostics: Value) {
        let worktree_path = worktree.to_string_lossy().into_owned();
        let _ = self.0.emit("lsp:diagnostics", DiagnosticsEvent { worktree_path, uri, diagnostics });
    }

    fn exited(&self, server: &Arc<LspServer>) {
        self.0.state::<LspRegistry>().forget(server);
        let worktree_path = server.worktree.to_string_lossy().into_owned();
        let _ = self.0.emit("lsp:exited", ExitedEvent { worktree_path });
    }
}

/// The server of the worktree of session `id`, started on demand; the worktree is remembered after the first lookup.
fn server_for(app: &AppHandle, registry: &LspRegistry, id: Uuid) -> Result<Arc<LspServer>, String> {
    let cached = registry.worktrees.lock().unwrap().get(&id).cloned();
    let worktree = match cached {
        Some(worktree) => worktree,
        None => {
            let worktree = store::find_session(app, id)?.worktree_path;
            registry.worktrees.lock().unwrap().insert(id, worktree.clone());
            worktree
        }
    };
    registry.get_or_start(&worktree, || Arc::new(TauriEvents(app.clone())))
}

#[tauri::command]
pub async fn lsp_request(
    app: AppHandle,
    registry: State<'_, LspRegistry>,
    id: Uuid,
    method: String,
    params: Value,
    token: Option<String>,
) -> Result<Value, String> {
    server_for(&app, &registry, id)?.request(&method, params, token).await
}

#[tauri::command]
pub async fn lsp_notify(
    app: AppHandle,
    registry: State<'_, LspRegistry>,
    id: Uuid,
    method: String,
    params: Value,
) -> Result<(), String> {
    server_for(&app, &registry, id)?.notify(&method, params).await
}

#[tauri::command]
pub async fn lsp_cancel(app: AppHandle, registry: State<'_, LspRegistry>, id: Uuid, token: String) -> Result<(), String> {
    server_for(&app, &registry, id)?.cancel(&token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(value: &Value, content_type: bool) -> Vec<u8> {
        let body = serde_json::to_vec(value).unwrap();
        let mut frame = format!("Content-Length: {}\r\n", body.len()).into_bytes();
        if content_type {
            frame.extend_from_slice(b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n");
        }
        frame.extend_from_slice(b"\r\n");
        frame.extend_from_slice(&body);
        frame
    }

    #[test]
    fn decodes_two_frames_from_one_buffer_and_a_frame_split_across_reads() {
        let mut decoder = FrameDecoder::default();
        decoder.buffer.extend_from_slice(&frame(&json!({ "id": 1, "result": null }), false));
        decoder.buffer.extend_from_slice(&frame(&json!({ "id": 2, "result": { "ok": true } }), true));
        assert_eq!(decoder.next_message().unwrap(), Some(json!({ "id": 1, "result": null })));
        assert_eq!(decoder.next_message().unwrap(), Some(json!({ "id": 2, "result": { "ok": true } })));
        assert_eq!(decoder.next_message().unwrap(), None);

        let third = frame(&json!({ "method": "window/logMessage", "params": { "message": "hello world" } }), false);
        let (head, tail) = third.split_at(third.len() / 2);
        decoder.buffer.extend_from_slice(head);
        assert_eq!(decoder.next_message().unwrap(), None);
        decoder.buffer.extend_from_slice(tail);
        let message = decoder.next_message().unwrap().expect("complete frame");
        assert_eq!(message["params"]["message"], "hello world");
        assert!(decoder.buffer.is_empty());
    }

    #[test]
    fn file_uri_encodes_like_monaco() {
        assert_eq!(file_uri(Path::new("/Users/me/my project/a.ts")), "file:///Users/me/my%20project/a.ts");
        assert_eq!(file_uri(Path::new("/tmp/x-y_z.~/ü")), "file:///tmp/x-y_z.~/%C3%BC");
    }

    struct Silent;

    impl LspEvents for Silent {
        fn diagnostics(&self, _worktree: &Path, _uri: String, _diagnostics: Value) {}
        fn exited(&self, _server: &Arc<LspServer>) {}
    }

    fn process_exists(pid: u32) -> bool {
        let status = std::process::Command::new("kill").args(["-0", &pid.to_string()]).status();
        status.is_ok_and(|status| status.success())
    }

    #[tokio::test]
    async fn hover_over_a_typed_const_and_stop() {
        let dir = tempfile::tempdir().unwrap();
        if resolve_tsgo(dir.path()).is_none() {
            println!("tsgo not installed, skipping");
            return;
        }
        std::fs::write(dir.path().join("a.ts"), "export const answer: number = 42;\n").unwrap();
        std::fs::write(dir.path().join("tsconfig.json"), r#"{ "compilerOptions": { "strict": true } }"#).unwrap();

        let server = LspServer::start(dir.path().to_path_buf(), Arc::new(Silent)).unwrap();
        let pid = server.pid.expect("spawned process has a pid");
        let uri = file_uri(&dir.path().join("a.ts"));
        let open = json!({
            "textDocument": { "uri": uri, "languageId": "typescript", "version": 1, "text": "export const answer: number = 42;\n" }
        });
        let hover = json!({ "textDocument": { "uri": uri }, "position": { "line": 0, "character": 14 } });
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            server.notify("textDocument/didOpen", open).await.unwrap();
            server.request("textDocument/hover", hover, Some("hover-1".into())).await
        })
        .await
        .expect("tsgo answers within 30s")
        .unwrap();

        let contents = result["contents"]["value"].as_str().expect("markdown hover contents");
        assert!(contents.contains("answer") && contents.contains("number"), "unexpected hover: {contents}");
        assert!(server.tokens.lock().unwrap().is_empty());

        server.stop().await;
        assert!(!process_exists(pid), "tsgo {pid} is still running");
        assert!(server.pending.lock().unwrap().is_none());
        assert_eq!(server.request("textDocument/hover", Value::Null, None).await, Err(EXITED.to_string()));
    }

    #[tokio::test]
    async fn shutdown_ends_the_process_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        if resolve_tsgo(dir.path()).is_none() {
            println!("tsgo not installed, skipping");
            return;
        }
        let server = LspServer::start(dir.path().to_path_buf(), Arc::new(Silent)).unwrap();
        let pid = server.pid.expect("spawned process has a pid");
        server.ensure_ready().await.unwrap();

        let started = std::time::Instant::now();
        server.shutdown().await;
        assert!(*server.exited.borrow(), "exit flag is set");
        assert!(!process_exists(pid), "tsgo {pid} is still running");
        assert!(started.elapsed() < EXIT_TIMEOUT, "shutdown fell back to the kill timeout");
    }
}
