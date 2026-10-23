//! One TypeScript language server (`tsgo --lsp --stdio`) per worktree, plus in Angular projects the Angular language
//! server (`ngserver`), which finds the usages and renames that reach into component templates. A server starts on
//! first use, is shared by every session of its worktree and is bridged to the webview through generic JSON-RPC
//! commands (`lsp_request`, `lsp_cancel`) plus the `lsp:diagnostics` and `lsp:exited` events of the TypeScript server.
//! The open documents reach the servers only through `documents.rs`, which holds the one text of each file that every
//! window edits.
//!
//! `LspServer` is the Tauri-free core (spawn, handshake, request, notify, file watching); `LspRegistry` and the commands
//! add the per-worktree sharing and the event emission.
//!
//! The server watches files through the client (`workspace/didChangeWatchedFiles` with dynamic registration): it
//! registers globs, and one recursive watcher on the worktree reports the changes that match them, so the server sees
//! files the agent creates, edits or deletes without an open document.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use glob::{MatchOptions, Pattern};
use notify_debouncer_full::notify::event::ModifyKind;
use notify_debouncer_full::notify::{self, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::{oneshot, watch, OnceCell};
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::acp::bundled_script_path;
use crate::documents;
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
/// The Angular language server Hunt ships, relative to the workspace root (see `bundled_script_path`).
const ANGULAR_SERVER_SCRIPT: &str = "node_modules/@angular/language-server/index.js";
/// File endings of the documents the TypeScript server receives; the Angular server receives templates too.
const SCRIPT_ENDINGS: [&str; 8] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const READ_CHUNK: usize = 64 * 1024;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const WATCH_DEBOUNCE: Duration = Duration::from_millis(100);
/// Watcher globs match like VS Code's on macOS: case-insensitive, `*` stays inside one path component.
const GLOB_OPTIONS: MatchOptions =
    MatchOptions { case_sensitive: false, require_literal_separator: true, require_literal_leading_dot: false };

/// Receives what a server reports on its own: diagnostics pushes and the end of its process.
pub trait LspEvents: Send + Sync + 'static {
    fn diagnostics(&self, worktree: &Path, uri: String, diagnostics: Value);
    fn exited(&self, server: &Arc<LspServer>);
}

/// Which language server of a worktree a request or document goes to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerKind {
    #[default]
    Typescript,
    Angular,
}

impl ServerKind {
    pub const ALL: [ServerKind; 2] = [ServerKind::Typescript, ServerKind::Angular];

    /// Whether the server receives the document at `path` (a path or a `file://` URI): TypeScript and JavaScript
    /// files, and for the Angular server also the HTML templates.
    pub fn receives(self, path: &str) -> bool {
        let path = path.to_ascii_lowercase();
        SCRIPT_ENDINGS.iter().any(|ending| path.ends_with(ending)) || (self == ServerKind::Angular && path.ends_with(".html"))
    }
}

/// The program and arguments that start a language server.
pub struct Launch {
    program: PathBuf,
    args: Vec<OsString>,
}

impl Launch {
    /// `tsgo --lsp --stdio`, from the worktree's `node_modules` or the `PATH`.
    pub fn typescript(worktree: &Path) -> Result<Self, String> {
        let program = resolve_tsgo(worktree).ok_or(NOT_FOUND)?;
        Ok(Self { program, args: vec!["--lsp".into(), "--stdio".into()] })
    }

    /// The Angular language server `script` on the `node` of `PATH`, with the TypeScript and the
    /// `@angular/language-service` of the worktree; fails for a worktree that does not install the language service.
    pub fn angular(script: &Path, worktree: &Path) -> Result<Self, String> {
        if !worktree.join("node_modules/@angular/language-service/package.json").is_file() {
            return Err(format!("failed to start the Angular language server: {} has no @angular/language-service", worktree.display()));
        }
        let mut args: Vec<OsString> = vec![script.into(), "--stdio".into()];
        for probe in ["--tsProbeLocations", "--ngProbeLocations"] {
            args.push(probe.into());
            args.push(worktree.into());
        }
        Ok(Self { program: "node".into(), args })
    }
}

type Pending = HashMap<i64, oneshot::Sender<Result<Value, String>>>;

/// A running language server process speaking JSON-RPC 2.0 over its stdio.
pub struct LspServer {
    worktree: PathBuf,
    kind: ServerKind,
    pid: Option<u32>,
    /// Owned until the reader task reaps the process; everyone else only signals it.
    child: Mutex<Option<Child>>,
    /// Frames for `write_loop`, which writes them to stdin in order; queueing never waits for the server to read.
    outbox: UnboundedSender<Vec<u8>>,
    next_id: AtomicI64,
    /// Requests awaiting their response; `None` once the process ended, so late requests fail at once.
    pending: Mutex<Option<Pending>>,
    /// Cancellation tokens of in-flight requests mapped to their JSON-RPC id.
    tokens: Mutex<HashMap<String, i64>>,
    /// Set once the `initialize` handshake finished; requests and notifications wait for it.
    ready: OnceCell<()>,
    /// Flips to `true` after the process was reaped.
    exited: watch::Sender<bool>,
    /// The worktree watcher; dropped when the process ends, which stops the forwarding of changes.
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, NoCache>>>,
    /// The file watchers the server registered, keyed by registration id.
    file_watchers: Mutex<HashMap<String, Vec<FileWatcher>>>,
}

impl LspServer {
    /// Spawns the `kind` server with `launch` in `worktree` and begins the handshake; requests wait until it is done.
    pub fn start(worktree: PathBuf, kind: ServerKind, launch: Launch, events: Arc<dyn LspEvents>) -> Result<Arc<Self>, String> {
        let mut child = Command::new(&launch.program)
            .args(&launch.args)
            .current_dir(&worktree)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Its own process group: `tsgo` on PATH is usually a shim that spawns node, which spawns the native binary.
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to start {}: {error}", launch.program.display()))?;
        let stdin = child.stdin.take().ok_or("language server stdin is not available")?;
        let stdout = child.stdout.take().ok_or("language server stdout is not available")?;
        let (outbox, frames) = unbounded_channel();
        tokio::spawn(write_loop(stdin, frames));

        let server = Arc::new(Self {
            worktree,
            kind,
            pid: child.id(),
            child: Mutex::new(Some(child)),
            outbox,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(Some(HashMap::new())),
            tokens: Mutex::default(),
            ready: OnceCell::new(),
            exited: watch::channel(false).0,
            watcher: Mutex::default(),
            file_watchers: Mutex::default(),
        });
        let (sender, receiver) = unbounded_channel();
        match watch_worktree(&server.worktree, sender) {
            Ok(debouncer) => {
                *server.watcher.lock().unwrap() = Some(debouncer);
            }
            Err(error) => eprintln!("{error}"),
        }
        tokio::spawn(forward_file_changes(Arc::downgrade(&server), receiver));
        tokio::spawn(read_loop(server.clone(), stdout, events));
        let handshake = server.clone();
        tokio::spawn(async move {
            let _ = handshake.ensure_ready().await;
        });
        Ok(server)
    }

    pub fn kind(&self) -> ServerKind {
        self.kind
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
        self.write(&message(None, method, params))
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
        self.write(&message(None, "$/cancelRequest", json!({ "id": id })))
    }

    /// Kills the process and waits (bounded) until it was reaped.
    pub async fn stop(&self) {
        self.kill();
        let _ = tokio::time::timeout(EXIT_TIMEOUT, self.wait_exited()).await;
    }

    /// Asks the server to end with `shutdown` and `exit`, each bounded, then kills whatever is still running.
    pub async fn shutdown(&self) {
        let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, self.send_request("shutdown", Value::Null, None)).await;
        let _ = self.write(&message(None, "exit", Value::Null));
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
                "workspace": {
                    "configuration": true,
                    "didChangeConfiguration": {},
                    "didChangeWatchedFiles": { "dynamicRegistration": true, "relativePatternSupport": true }
                },
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
                    "codeAction": { "codeActionLiteralSupport": { "codeActionKind": { "valueSet": ["source.removeUnusedImports"] } } },
                    "inlayHint": {},
                    "publishDiagnostics": {},
                    "diagnostic": {}
                }
            }
        });
        self.send_request("initialize", params, None).await?;
        self.write(&message(None, "initialized", json!({})))?;
        let settings = json!({ "settings": *SETTINGS });
        self.write(&message(None, "workspace/didChangeConfiguration", settings))
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

        let outcome = match self.write(&message(Some(id), method, params)) {
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

    /// Queues one framed message for `write_loop`, so a server that is busy and not reading its stdin holds up neither
    /// the caller nor the document lock it may hold; fails once the process takes no more input.
    fn write(&self, message: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend_from_slice(&body);
        self.outbox.send(frame).map_err(|_| EXITED.to_string())
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
                self.update_file_watchers(&method, &params);
                let result = answer_server_request(&method, &params);
                let _ = self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
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

    /// Keeps the file watchers of a `client/registerCapability` request and drops those `client/unregisterCapability`
    /// names; other requests are ignored.
    fn update_file_watchers(&self, method: &str, params: &Value) {
        let mut file_watchers = self.file_watchers.lock().unwrap();
        if method == "client/registerCapability" {
            for registration in params["registrations"].as_array().into_iter().flatten() {
                if registration["method"] != "workspace/didChangeWatchedFiles" {
                    continue;
                }
                let Some(id) = registration["id"].as_str() else { continue };
                let watchers = registration["registerOptions"]["watchers"].as_array().into_iter().flatten().filter_map(FileWatcher::parse);
                file_watchers.insert(id.to_owned(), watchers.collect());
            }
        } else if method == "client/unregisterCapability" {
            // The LSP spec spells the field `unregisterations`.
            for registration in params["unregisterations"].as_array().into_iter().flatten() {
                if let Some(id) = registration["id"].as_str() {
                    file_watchers.remove(id);
                }
            }
        }
    }

    /// Fails every pending request, reaps the process and announces the end.
    async fn finish(self: &Arc<Self>, events: &dyn LspEvents) {
        self.watcher.lock().unwrap().take();
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

/// Writes the queued frames to stdin in order until the server is dropped or a write fails; `read_loop` reports the
/// end of the process.
async fn write_loop(mut stdin: ChildStdin, mut frames: UnboundedReceiver<Vec<u8>>) {
    while let Some(frame) = frames.recv().await {
        let written = async {
            stdin.write_all(&frame).await?;
            stdin.flush().await
        };
        if let Err(error) = written.await {
            eprintln!("failed to write to the language server: {error}");
            return;
        }
    }
}

/// A glob the server registered with `workspace/didChangeWatchedFiles`: the changes below `base` (lowercased) whose
/// relative path matches one of `patterns` (the glob with its `{a,b}` groups expanded), of the change types in `kind`
/// (bit 1 created, 2 changed, 4 deleted).
#[derive(Debug)]
struct FileWatcher {
    base: String,
    patterns: Vec<Pattern>,
    kind: u64,
}

impl FileWatcher {
    /// Reads a `FileSystemWatcher`: an absolute glob (`/repo/**/*`) or a relative pattern (`{ baseUri, pattern }`).
    fn parse(watcher: &Value) -> Option<Self> {
        let (base, pattern) = match &watcher["globPattern"] {
            Value::String(glob) => split_glob(glob),
            Value::Object(relative) => {
                let base_uri = &relative.get("baseUri")?;
                let base_uri = base_uri.as_str().or_else(|| base_uri["uri"].as_str())?;
                (path_of_file_uri(base_uri)?, relative.get("pattern")?.as_str()?.to_owned())
            }
            _ => return None,
        };
        let patterns: Vec<Pattern> = expand_braces(&pattern).iter().filter_map(|pattern| Pattern::new(pattern).ok()).collect();
        if patterns.is_empty() {
            return None;
        }
        let base = base.trim_end_matches('/').to_lowercase();
        Some(Self { base, patterns, kind: watcher["kind"].as_u64().unwrap_or(7) })
    }

    /// Whether a change of `change` type (1 created, 2 changed, 3 deleted) at the lowercased `path` concerns the watcher.
    fn matches(&self, path: &str, change: u8) -> bool {
        if self.kind & (1 << (change - 1)) == 0 {
            return false;
        }
        let Some(relative) = path.strip_prefix(self.base.as_str()).and_then(|rest| rest.strip_prefix('/')) else { return false };
        self.patterns.iter().any(|pattern| pattern.matches_with(relative, GLOB_OPTIONS))
    }
}

/// Splits an absolute glob into the literal directory before its first wildcard component and the pattern after it;
/// a glob without wildcards names one file, so its parent is the base and the escaped file name the pattern.
fn split_glob(glob: &str) -> (String, String) {
    let components: Vec<&str> = glob.split('/').collect();
    let wildcard = components.iter().position(|component| component.contains(['*', '?', '[', '{']));
    match wildcard {
        Some(index) => (components[..index].join("/"), components[index..].join("/")),
        None => {
            let last = components.len() - 1;
            (components[..last].join("/"), Pattern::escape(components[last]))
        }
    }
}

/// The patterns a glob's `{a,b}` groups stand for (`*.{ts,js}` → `*.ts`, `*.js`), nested groups included.
fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(open) = pattern.find('{') else { return vec![pattern.to_owned()] };
    let mut depth = 0;
    let mut bounds = vec![open];
    let mut close = None;
    for (offset, char) in pattern[open..].char_indices() {
        match char {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + offset);
                    break;
                }
            }
            ',' if depth == 1 => bounds.push(open + offset),
            _ => {}
        }
    }
    let Some(close) = close else { return vec![pattern.to_owned()] };
    bounds.push(close);
    let (prefix, suffix) = (&pattern[..open], &pattern[close + 1..]);
    bounds.windows(2).flat_map(|bound| expand_braces(&format!("{prefix}{}{suffix}", &pattern[bound[0] + 1..bound[1]]))).collect()
}

/// The LSP `FileChangeType` of a path the watcher reported: deleted when it is gone, created when the batch created
/// or renamed it into place, changed otherwise.
fn change_type(created: bool, exists: bool) -> u8 {
    if !exists {
        3
    } else if created {
        1
    } else {
        2
    }
}

/// The `FileEvent`s of `changes` (path and change type) that match one of the registered `file_watchers`.
fn watched_changes(file_watchers: &HashMap<String, Vec<FileWatcher>>, changes: impl IntoIterator<Item = (PathBuf, u8)>) -> Vec<Value> {
    let watchers: Vec<&FileWatcher> = file_watchers.values().flatten().collect();
    changes
        .into_iter()
        .filter(|(path, change)| {
            let path = path.to_string_lossy().to_lowercase();
            watchers.iter().any(|watcher| watcher.matches(&path, *change))
        })
        .map(|(path, change)| json!({ "uri": file_uri(&path), "type": change }))
        .collect()
}

/// Watches `worktree` recursively and sends each debounced batch of changed paths outside `.git`, each with whether
/// the batch created it. Without a file ID cache, so the watch starts without reading the worktree.
fn watch_worktree(
    worktree: &Path,
    sender: UnboundedSender<Vec<(PathBuf, bool)>>,
) -> Result<Debouncer<RecommendedWatcher, NoCache>, String> {
    let root = worktree.to_path_buf();
    let on_events = move |result: DebounceEventResult| {
        let events = match result {
            Ok(events) => events,
            Err(errors) => {
                eprintln!("failed to watch {} for the language server: {errors:?}", root.display());
                return;
            }
        };
        let mut paths = BTreeMap::<PathBuf, bool>::new();
        for event in &events {
            if matches!(event.kind, EventKind::Access(_)) {
                continue;
            }
            let created = matches!(event.kind, EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)));
            for path in &event.paths {
                let relative = path.strip_prefix(&root).unwrap_or(path);
                if relative.components().any(|component| component.as_os_str() == ".git") {
                    continue;
                }
                *paths.entry(path.clone()).or_default() |= created;
            }
        }
        if !paths.is_empty() {
            let _ = sender.send(paths.into_iter().collect());
        }
    };
    let watch = || {
        let config = notify::Config::default();
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, _>(WATCH_DEBOUNCE, None, on_events, NoCache, config)?;
        debouncer.watch(worktree, RecursiveMode::Recursive)?;
        Ok::<_, notify::Error>(debouncer)
    };
    watch().map_err(|error| format!("failed to watch {} for the language server: {error}", worktree.display()))
}

/// Reports the batches of `watch_worktree` that match a registered watcher with `workspace/didChangeWatchedFiles`;
/// ends when the watcher is dropped or the server is gone.
async fn forward_file_changes(server: Weak<LspServer>, mut receiver: UnboundedReceiver<Vec<(PathBuf, bool)>>) {
    while let Some(paths) = receiver.recv().await {
        let Some(server) = server.upgrade() else { return };
        let changes: Vec<(PathBuf, u8)> = paths
            .into_iter()
            .map(|(path, created)| {
                let change = change_type(created, path.exists());
                (path, change)
            })
            .collect();
        let changes = watched_changes(&server.file_watchers.lock().unwrap(), changes);
        if changes.is_empty() {
            continue;
        }
        if let Err(error) = server.notify("workspace/didChangeWatchedFiles", json!({ "changes": changes })).await {
            eprintln!("failed to report file changes to the language server: {error}");
        }
    }
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

/// The path of a `file://` URI, percent-decoded; None for other schemes and malformed escapes.
fn path_of_file_uri(uri: &str) -> Option<String> {
    let encoded = uri.strip_prefix("file://")?.as_bytes();
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' {
            let hex = std::str::from_utf8(encoded.get(index + 1..index + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            bytes.push(encoded[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

/// Running servers keyed by worktree and kind, plus the worktree of every session that used the LSP so a request
/// needs no session store read.
#[derive(Default)]
pub struct LspRegistry {
    servers: Mutex<HashMap<(PathBuf, ServerKind), Arc<LspServer>>>,
    worktrees: Mutex<HashMap<Uuid, PathBuf>>,
}

impl LspRegistry {
    /// The running `kind` server of `worktree`, started with `launch` and `events` when there is none.
    pub fn get_or_start(
        &self,
        worktree: &Path,
        kind: ServerKind,
        launch: impl FnOnce() -> Result<Launch, String>,
        events: impl FnOnce() -> Arc<dyn LspEvents>,
    ) -> Result<Arc<LspServer>, String> {
        let mut servers = self.servers.lock().unwrap();
        let key = (worktree.to_path_buf(), kind);
        if let Some(server) = servers.get(&key) {
            return Ok(server.clone());
        }
        let server = LspServer::start(worktree.to_path_buf(), kind, launch()?, events())?;
        servers.insert(key, server.clone());
        Ok(server)
    }

    /// Drops `server` when it is still the registered server of its worktree and kind.
    fn forget(&self, server: &Arc<LspServer>) {
        let mut servers = self.servers.lock().unwrap();
        let key = (server.worktree.clone(), server.kind);
        if servers.get(&key).is_some_and(|current| Arc::ptr_eq(current, server)) {
            servers.remove(&key);
        }
    }
}

/// Kills the servers of `worktree` (if any) and waits until their processes are gone.
pub async fn stop_for_worktree(registry: &LspRegistry, worktree: &Path) {
    let servers: Vec<Arc<LspServer>> = {
        let mut servers = registry.servers.lock().unwrap();
        ServerKind::ALL.iter().filter_map(|kind| servers.remove(&(worktree.to_path_buf(), *kind))).collect()
    };
    registry.worktrees.lock().unwrap().retain(|_, path| path != worktree);
    for server in servers {
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

/// Forwards the events of the TypeScript server to every window and unregisters ended servers. The windows know only
/// the TypeScript server: Angular diagnostics would replace its markers of the same file.
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

/// Unregisters an ended Angular server; its diagnostics stay unused.
struct AngularEvents(AppHandle);

impl LspEvents for AngularEvents {
    fn diagnostics(&self, _worktree: &Path, _uri: String, _diagnostics: Value) {}

    fn exited(&self, server: &Arc<LspServer>) {
        self.0.state::<LspRegistry>().forget(server);
    }
}

/// The `kind` server of the worktree of session `id`, started on demand; the open documents reach a server started now
/// before any request does, also when several requests start it at once. The worktree is remembered after the first
/// lookup.
async fn server_for(app: &AppHandle, registry: &LspRegistry, id: Uuid, kind: ServerKind) -> Result<Arc<LspServer>, String> {
    let cached = registry.worktrees.lock().unwrap().get(&id).cloned();
    let worktree = match cached {
        Some(worktree) => worktree,
        None => {
            let record = store::find_session(app, id)?;
            if record.remote.is_some() && !record.worktree_path.is_dir() {
                return Err(format!("failed to start the language server: session {id} has no local worktree yet"));
            }
            registry.worktrees.lock().unwrap().insert(id, record.worktree_path.clone());
            record.worktree_path
        }
    };
    let server = server_for_worktree(app, &worktree, kind)?;
    documents::open_in(app.clone(), worktree, server.clone()).await;
    Ok(server)
}

/// The `kind` server of `worktree`, started on demand; a server started now has no documents yet.
pub fn server_for_worktree(app: &AppHandle, worktree: &Path, kind: ServerKind) -> Result<Arc<LspServer>, String> {
    let launch = || match kind {
        ServerKind::Typescript => Launch::typescript(worktree),
        ServerKind::Angular => Launch::angular(&bundled_script_path(app, ANGULAR_SERVER_SCRIPT)?, worktree),
    };
    let events = || -> Arc<dyn LspEvents> {
        match kind {
            ServerKind::Typescript => Arc::new(TauriEvents(app.clone())),
            ServerKind::Angular => Arc::new(AngularEvents(app.clone())),
        }
    };
    app.state::<LspRegistry>().get_or_start(worktree, kind, launch, events)
}

/// The running `kind` server of `worktree`, if any.
pub fn running_server(app: &AppHandle, worktree: &Path, kind: ServerKind) -> Option<Arc<LspServer>> {
    app.state::<LspRegistry>().servers.lock().unwrap().get(&(worktree.to_path_buf(), kind)).cloned()
}

/// Sends `method` to the `server` (default: TypeScript) of session `id`'s worktree.
#[tauri::command]
pub async fn lsp_request(
    app: AppHandle,
    registry: State<'_, LspRegistry>,
    id: Uuid,
    method: String,
    params: Value,
    token: Option<String>,
    server: Option<ServerKind>,
) -> Result<Value, String> {
    server_for(&app, &registry, id, server.unwrap_or_default()).await?.request(&method, params, token).await
}

#[tauri::command]
pub async fn lsp_cancel(
    app: AppHandle,
    registry: State<'_, LspRegistry>,
    id: Uuid,
    token: String,
    server: Option<ServerKind>,
) -> Result<(), String> {
    server_for(&app, &registry, id, server.unwrap_or_default()).await?.cancel(&token).await
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

    #[test]
    fn file_watchers_match_absolute_globs_relative_patterns_and_kinds() {
        let watchers = [
            json!({ "globPattern": "/Repo/My Project/**/*", "kind": 7 }),
            json!({ "globPattern": "/repo/my project/tsconfig.base.json" }),
            json!({ "globPattern": { "baseUri": "file:///Repo/My%20Project/node_modules", "pattern": "**/*.{ts,json}" }, "kind": 4 }),
        ];
        let [all, config, deleted] = watchers.map(|watcher| FileWatcher::parse(&watcher).expect("valid watcher"));
        assert!(all.matches("/repo/my project/src/a.ts", 1));
        assert!(all.matches("/repo/my project/a.ts", 2));
        assert!(!all.matches("/repo/other/a.ts", 1));
        assert!(config.matches("/repo/my project/tsconfig.base.json", 2));
        assert!(!config.matches("/repo/my project/tsconfig.json", 2));
        assert!(deleted.matches("/repo/my project/node_modules/x/index.json", 3));
        assert!(!deleted.matches("/repo/my project/node_modules/x/index.json", 2));
        assert!(!deleted.matches("/repo/my project/node_modules/x/index.js", 3));
    }

    #[test]
    fn braces_expand_into_every_alternative() {
        assert_eq!(expand_braces("**/*.{ts,tsx}"), ["**/*.ts", "**/*.tsx"]);
        assert_eq!(expand_braces("{a,b{c,d}}/x"), ["a/x", "bc/x", "bd/x"]);
        assert_eq!(expand_braces("plain/*"), ["plain/*"]);
        assert_eq!(expand_braces("open{a,b"), ["open{a,b"]);
    }

    #[test]
    fn watched_changes_keep_matching_paths_and_report_their_type() {
        let mut file_watchers = HashMap::new();
        file_watchers.insert("root".to_owned(), vec![FileWatcher::parse(&json!({ "globPattern": "/repo/src/**/*" })).unwrap()]);
        let changes = [
            (PathBuf::from("/repo/src/a.ts"), change_type(true, true)),
            (PathBuf::from("/repo/b.ts"), change_type(false, false)),
        ];
        assert_eq!(watched_changes(&file_watchers, changes), [json!({ "uri": "file:///repo/src/a.ts", "type": 1 })]);
        assert_eq!((change_type(false, true), change_type(true, false)), (2, 3));
        assert_eq!(path_of_file_uri("file:///a%20b/%C3%BC").as_deref(), Some("/a b/ü"));
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

    fn start_typescript(worktree: &Path) -> Arc<LspServer> {
        let launch = Launch::typescript(worktree).unwrap();
        LspServer::start(worktree.to_path_buf(), ServerKind::Typescript, launch, Arc::new(Silent)).unwrap()
    }

    #[tokio::test]
    async fn writes_never_wait_for_a_server_that_does_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let launch = Launch { program: "sleep".into(), args: vec!["30".into()] };
        let server = LspServer::start(dir.path().to_path_buf(), ServerKind::Typescript, launch, Arc::new(Silent)).unwrap();
        // Far more than the 64 KB a pipe holds, so a write that waits for the reader would never return.
        let open = json!({ "textDocument": { "uri": "file:///a.ts", "languageId": "typescript", "version": 1, "text": "x".repeat(1 << 20) } });

        let started = std::time::Instant::now();
        for _ in 0..4 {
            server.write(&message(None, "textDocument/didOpen", open.clone())).unwrap();
        }
        assert!(started.elapsed() < Duration::from_secs(1), "writes took {:?}", started.elapsed());
        server.stop().await;
    }

    #[test]
    fn each_server_receives_its_documents() {
        assert!(ServerKind::Typescript.receives("src/a.ts"));
        assert!(ServerKind::Typescript.receives("file:///repo/b.MJS"));
        assert!(!ServerKind::Typescript.receives("src/a.html"));
        assert!(ServerKind::Angular.receives("src/a.html"));
        assert!(ServerKind::Angular.receives("src/a.tsx"));
        assert!(!ServerKind::Angular.receives("src/a.css"));
    }

    #[tokio::test]
    async fn references_reach_an_angular_template() {
        let node_modules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../node_modules");
        let script = node_modules.join("@angular/language-server/index.js");
        if !script.is_file() {
            println!("@angular/language-server not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let worktree_modules = root.join("node_modules/@angular");
        std::fs::create_dir_all(worktree_modules.join("core")).unwrap();
        std::os::unix::fs::symlink(node_modules.join("typescript"), root.join("node_modules/typescript")).unwrap();
        std::os::unix::fs::symlink(node_modules.join("@angular/language-service"), worktree_modules.join("language-service")).unwrap();
        // The compiler only needs to recognise `@Component` from `@angular/core`.
        std::fs::write(worktree_modules.join("core/package.json"), r#"{ "name": "@angular/core", "version": "22.0.0", "types": "index.d.ts" }"#).unwrap();
        let core = "export interface ComponentDecorator {\n  (obj: { selector?: string; templateUrl?: string }): ClassDecorator;\n}\n\
                    export declare const Component: ComponentDecorator;\n";
        std::fs::write(worktree_modules.join("core/index.d.ts"), core).unwrap();
        std::fs::write(root.join("tsconfig.json"), r#"{ "compilerOptions": { "strict": true }, "files": ["app.ts"] }"#).unwrap();
        let source = "import { Component } from \"@angular/core\";\n\n@Component({ selector: \"app-root\", templateUrl: \"./app.html\" })\n\
                      export class App {\n  isReady(): boolean {\n    return true;\n  }\n}\n";
        std::fs::write(root.join("app.ts"), source).unwrap();
        std::fs::write(root.join("app.html"), "@if (isReady()) {\n  <p>ready</p>\n}\n").unwrap();

        let launch = Launch::angular(&script, &root).unwrap();
        let server = LspServer::start(root.clone(), ServerKind::Angular, launch, Arc::new(Silent)).unwrap();
        let uri = file_uri(&root.join("app.ts"));
        let open = json!({ "textDocument": { "uri": uri, "languageId": "typescript", "version": 1, "text": source } });
        let references = json!({
            "textDocument": { "uri": uri },
            "position": { "line": 4, "character": 4 },
            "context": { "includeDeclaration": false }
        });
        let found = tokio::time::timeout(Duration::from_secs(60), async {
            server.notify("textDocument/didOpen", open).await.unwrap();
            server.request("textDocument/references", references, None).await.unwrap()
        })
        .await
        .expect("the Angular language server answers within 60s");

        let template = found.as_array().unwrap().iter().find(|location| location["uri"] == file_uri(&root.join("app.html")));
        let template = template.unwrap_or_else(|| panic!("no template reference in {found}"));
        assert_eq!(template["range"]["start"], json!({ "line": 0, "character": 5 }));
        server.stop().await;
    }

    #[test]
    fn the_angular_server_needs_the_projects_language_service() {
        let dir = tempfile::tempdir().unwrap();
        let error = Launch::angular(Path::new("/ngserver/index.js"), dir.path()).err().unwrap();
        assert!(error.contains("has no @angular/language-service"), "{error}");
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

        let server = start_typescript(dir.path());
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
    async fn references_include_a_file_created_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        if resolve_tsgo(dir.path()).is_none() {
            println!("tsgo not installed, skipping");
            return;
        }
        // FSEvents reports real paths, and the temporary directory sits behind the `/var` → `/private/var` link.
        let root = dir.path().canonicalize().unwrap();
        let source = "export function answer(): number {\n  return 42;\n}\n";
        std::fs::write(root.join("a.ts"), source).unwrap();
        std::fs::write(root.join("tsconfig.json"), r#"{ "compilerOptions": { "strict": true } }"#).unwrap();

        let server = start_typescript(&root);
        let uri = file_uri(&root.join("a.ts"));
        let open = json!({ "textDocument": { "uri": uri, "languageId": "typescript", "version": 1, "text": source } });
        let references = json!({
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 16 },
            "context": { "includeDeclaration": false }
        });
        let found = tokio::time::timeout(Duration::from_secs(30), async {
            server.notify("textDocument/didOpen", open).await.unwrap();
            assert_eq!(server.request("textDocument/references", references.clone(), None).await.unwrap(), json!([]));
            std::fs::write(root.join("b.ts"), "import { answer } from \"./a\";\nanswer();\n").unwrap();
            loop {
                let result = server.request("textDocument/references", references.clone(), None).await.unwrap();
                if result.to_string().contains("b.ts") {
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("tsgo sees the new file within 30s");

        assert_eq!(found[0]["range"]["start"]["line"], 1);
        server.stop().await;
        assert!(server.watcher.lock().unwrap().is_none(), "the watcher ends with the process");
    }

    #[tokio::test]
    async fn shutdown_ends_the_process_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        if resolve_tsgo(dir.path()).is_none() {
            println!("tsgo not installed, skipping");
            return;
        }
        let server = start_typescript(dir.path());
        let pid = server.pid.expect("spawned process has a pid");
        server.ensure_ready().await.unwrap();

        let started = std::time::Instant::now();
        server.shutdown().await;
        assert!(*server.exited.borrow(), "exit flag is set");
        assert!(!process_exists(pid), "tsgo {pid} is still running");
        assert!(started.elapsed() < EXIT_TIMEOUT, "shutdown fell back to the kill timeout");
    }
}
