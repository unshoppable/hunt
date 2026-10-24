//! The Chrome of a local session: a Google Chrome of its own, in a window of its own, which the session's agent drives
//! through Playwright MCP (`apps/client/scripts/browserMcp.mjs`, `--cdp-endpoint` on the session's port) and on whose
//! pages Hunt shows the review widget. Its profile is a copy of the repository's profile (`<browser dir>/<repo hash>/
//! profile`) in `<browser dir>/sessions/<session id>`, so the repository's logins are there; when the Chrome ends, the
//! copy replaces the repository's profile, so the session closed last wins. Chrome starts on demand: when the agent calls
//! its first browser tool (the wrapper asks through the control socket) or the user clicks "Browser". Hunt attaches to
//! every page over CDP, adds the binding `__huntReview` and the widget, and hands each annotation the widget reports to
//! the caller's sink. Knows nothing about Tauri; `session/commands.rs` owns the command and the sink.

use std::collections::HashMap;
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::remote::status_channel::Annotation;

/// The Chrome Hunt starts; its absence is an error of `open`.
const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/// The name of the binding the review widget calls with an annotation as JSON (`apps/session/src/review/widget.ts`).
pub const BINDING: &str = "__huntReview";

/// The review widget, built by `client:review-widget` from `apps/session/src/review/widget.ts`.
const WIDGET: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/review.js"));

/// How long a starting Chrome may take until its DevTools endpoint answers.
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a closing Chrome may take to exit before it is killed.
const EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the DevTools endpoint of a starting Chrome is asked.
const START_POLL: Duration = Duration::from_millis(100);

/// The bytes of an answer of the DevTools endpoint that are read.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// The longest path of a Unix socket on macOS, whose `sun_path` holds 104 bytes with the closing NUL.
const MAX_SOCKET_PATH_BYTES: usize = 103;

/// The start of the file name of a control socket, which ends in the process ID of its Hunt and `.sock`.
const CONTROL_SOCKET_PREFIX: &str = "control-";

/// The longest request line of the control socket.
const MAX_CONTROL_LINE_BYTES: u64 = 4096;

/// What is called with every annotation the review widget of a session's Chrome reports.
pub type AnnotationSink = Arc<dyn Fn(Annotation) + Send + Sync>;

/// The Chrome of a session, behind a lock of its own, so that an open, a close and the end of the Chrome run one after
/// the other for a session while other sessions' go on.
type BrowserSlot = Arc<tokio::sync::Mutex<Option<RunningBrowser>>>;

/// The Chromes of the sessions, the CDP port each session's agent was given and the lock under which repository
/// profiles are copied and replaced.
#[derive(Default)]
pub struct BrowserRegistry {
    ports: Mutex<HashMap<Uuid, u16>>,
    slots: Mutex<HashMap<Uuid, BrowserSlot>>,
    profiles: Arc<tokio::sync::Mutex<()>>,
    generation: AtomicU64,
}

/// A running Chrome of a session.
struct RunningBrowser {
    /// Tells this Chrome from a later one in the same slot, so that the end of its CDP connection ends only itself.
    generation: u64,
    child: Child,
    profile: Profile,
    /// The CDP task of this Chrome; closed once the CDP connection ended.
    controls: UnboundedSender<Control>,
}

/// The profile folders of a session's Chrome.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Profile {
    /// The repository's profile, which the session's copy starts from and replaces at the end.
    repository: PathBuf,
    /// The session's copy, which its Chrome uses.
    session: PathBuf,
}

/// What the CDP task of a running Chrome is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Control {
    BringToFront,
}

impl BrowserRegistry {
    /// The CDP port of the session `id`'s Chrome: the one given before, or a port of the loopback address that is free
    /// now. The agent's Playwright MCP connects to it, so it stays the same for the session while Hunt runs.
    pub fn reserve_port(&self, id: Uuid) -> Result<u16, String> {
        let mut ports = self.ports.lock().unwrap();
        if let Some(port) = ports.get(&id) {
            return Ok(*port);
        }
        let port = free_local_port()?;
        ports.insert(id, port);
        Ok(port)
    }

    /// Opens the Chrome of the session `id` in the repository `repo_path` unless it runs; with `raises`, its window comes
    /// to the front of the screen. A new Chrome gets a copy of the repository's profile under `browser_dir`, listens for
    /// CDP on the session's port and shows the review widget on every page, whose annotations go to `on_annotation`.
    pub async fn open(&self, id: Uuid, repo_path: &Path, browser_dir: &Path, on_annotation: AnnotationSink, raises: bool) -> Result<(), String> {
        let slot = self.slots.lock().unwrap().entry(id).or_default().clone();
        let mut running = slot.lock().await;
        if let Some(browser) = running.as_mut() {
            if browser.is_running() {
                if raises {
                    let _ = browser.controls.send(Control::BringToFront);
                    activate_process(browser.child.id());
                }
                return Ok(());
            }
            if let Some(ended) = running.take() {
                ended.end(&self.profiles, false).await;
            }
        }
        if !Path::new(CHROME).is_file() {
            return Err("failed to open the browser: Google Chrome is not installed".into());
        }
        let port = self.reserve_port(id)?;
        let profile = Profile::of(browser_dir, repo_path, id);
        {
            let _profiles = self.profiles.lock().await;
            let copied = profile.clone();
            tokio::task::spawn_blocking(move || copied.prepare())
                .await
                .map_err(|error| format!("failed to copy the browser profile: {error}"))??;
        }
        let mut child = Command::new(CHROME)
            .args(chrome_args(&profile.session, port))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to open the browser: {error}"))?;
        let connected = async {
            let endpoint = wait_for_endpoint(port, &mut child).await?;
            let (stream, _) = tokio_tungstenite::connect_async(endpoint.as_str())
                .await
                .map_err(|error| format!("failed to connect to the browser: {error}"))?;
            Ok::<_, String>(stream)
        }
        .await;
        let stream = match connected {
            Ok(stream) => stream,
            Err(error) => {
                let _ = child.kill().await;
                if let Err(remove_error) = std::fs::remove_dir_all(&profile.session) {
                    eprintln!("removing the browser profile {} failed: {remove_error}", profile.session.display());
                }
                return Err(format!("failed to open the browser: {error}"));
            }
        };
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let (controls, control_receiver) = unbounded_channel();
        let watch = Watch { slot: slot.clone(), generation, profiles: self.profiles.clone() };
        tokio::spawn(run_cdp(stream, control_receiver, on_annotation, watch));
        if raises {
            activate_process(child.id());
        }
        *running = Some(RunningBrowser { generation, child, profile, controls });
        Ok(())
    }

    /// Closes the Chrome of the session `id`, if it runs, and lets its profile replace the repository's.
    pub async fn close(&self, id: Uuid) {
        let Some(slot) = self.slots.lock().unwrap().get(&id).cloned() else { return };
        // The guard is held until the profile is back, so an open of the session waits for it.
        let mut running = slot.lock().await;
        if let Some(browser) = running.take() {
            browser.end(&self.profiles, true).await;
        }
    }

    /// Closes the Chrome of every session.
    pub async fn close_all(&self) {
        let ids: Vec<Uuid> = self.slots.lock().unwrap().keys().copied().collect();
        futures_util::future::join_all(ids.into_iter().map(|id| self.close(id))).await;
    }
}

impl RunningBrowser {
    /// Whether the Chrome and its CDP connection still run.
    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None)) && !self.controls.is_closed()
    }

    /// Ends the Chrome: asks it to quit when `asks_to_quit`, kills it when it does not exit within `EXIT_TIMEOUT`, and
    /// lets the session's profile replace the repository's. It quits on SIGTERM, which writes its profile like ⌘Q; on
    /// macOS `Browser.close` only closes its windows and leaves it running.
    async fn end(mut self, profiles: &tokio::sync::Mutex<()>, asks_to_quit: bool) {
        if let Some(pid) = self.child.id().filter(|_| asks_to_quit) {
            // SAFETY: plain syscall without pointers; the child is not reaped yet, so its id still names it.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        if tokio::time::timeout(EXIT_TIMEOUT, self.child.wait()).await.is_err() {
            if let Err(error) = self.child.kill().await {
                eprintln!("killing the browser of {} failed: {error}", self.profile.session.display());
            }
        }
        let _profiles = profiles.lock().await;
        let profile = self.profile.clone();
        match tokio::task::spawn_blocking(move || profile.restore()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("{error}"),
            Err(error) => eprintln!("failed to restore the browser profile: {error}"),
        }
    }
}

impl Profile {
    /// The profile folders of the session `id` in the repository `repo_path`.
    fn of(browser_dir: &Path, repo_path: &Path, id: Uuid) -> Self {
        Profile {
            repository: browser_dir.join(repo_hash(repo_path)).join("profile"),
            session: browser_dir.join("sessions").join(id.to_string()),
        }
    }

    /// Replaces the session's folder, which a Chrome that did not end may have left, by a copy of the repository's
    /// profile without its locks and caches; an empty folder when the repository has none yet.
    fn prepare(&self) -> Result<(), String> {
        let failed = |error: std::io::Error| format!("failed to copy the browser profile: {error}");
        if self.session.exists() {
            std::fs::remove_dir_all(&self.session).map_err(failed)?;
        }
        if self.repository.is_dir() {
            copy_profile(&self.repository, &self.session).map_err(failed)?;
        } else {
            std::fs::create_dir_all(&self.session).map_err(failed)?;
        }
        Ok(())
    }

    /// Moves the session's folder, without its locks and caches, into the place of the repository's profile.
    fn restore(&self) -> Result<(), String> {
        let failed = |error: std::io::Error| format!("failed to restore the browser profile {}: {error}", self.repository.display());
        if !self.session.is_dir() {
            return Ok(());
        }
        prune_profile(&self.session).map_err(failed)?;
        let parent = self.repository.parent().ok_or("failed to restore the browser profile: it has no folder")?;
        std::fs::create_dir_all(parent).map_err(failed)?;
        let replaced = parent.join(format!("profile.replaced-{}", Uuid::new_v4()));
        let had_profile = self.repository.exists();
        if had_profile {
            std::fs::rename(&self.repository, &replaced).map_err(failed)?;
        }
        if let Err(error) = std::fs::rename(&self.session, &self.repository) {
            if had_profile {
                let _ = std::fs::rename(&replaced, &self.repository);
            }
            return Err(failed(error));
        }
        if had_profile {
            std::fs::remove_dir_all(&replaced).map_err(failed)?;
        }
        Ok(())
    }
}

/// The folder name of the profile of the repository `repo_path`: the start of the SHA-256 of its path.
fn repo_hash(repo_path: &Path) -> String {
    let digest = Sha256::digest(repo_path.to_string_lossy().as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// Whether a profile entry named `name` stays out of a copy: Chrome's locks of a running profile, its DevTools port file
/// and, for a folder, its caches.
fn is_left_out(name: &str, is_dir: bool) -> bool {
    name.starts_with("Singleton") || name == "DevToolsActivePort" || (is_dir && name.contains("Cache"))
}

/// Copies the profile folder `from` to `to`, leaving out what `is_left_out` names and every entry that is neither a
/// file nor a folder, such as a symbolic link.
fn copy_profile(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        if is_left_out(&name.to_string_lossy(), file_type.is_dir()) {
            continue;
        }
        if file_type.is_dir() {
            copy_profile(&entry.path(), &to.join(&name))?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// Removes from the profile folder `dir` what `is_left_out` names.
fn prune_profile(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if is_left_out(&entry.file_name().to_string_lossy(), file_type.is_dir()) {
            if file_type.is_dir() {
                std::fs::remove_dir_all(entry.path())?;
            } else {
                std::fs::remove_file(entry.path())?;
            }
        } else if file_type.is_dir() {
            prune_profile(&entry.path())?;
        }
    }
    Ok(())
}

/// Makes the app of the process `pid` the active one, with its windows in front, as long as Hunt is active itself
/// (macOS lets only the active app hand activation on).
fn activate_process(pid: Option<u32>) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let Some(pid) = pid else { return };
    let Some(application) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t) else { return };
    application.activateFromApplication_options(&NSRunningApplication::currentApplication(), NSApplicationActivationOptions::ActivateAllWindows);
}

/// The command line of a session's Chrome with the profile `profile_dir` and CDP on `port`.
fn chrome_args(profile_dir: &Path, port: u16) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile_dir.display()),
        format!("--remote-debugging-port={port}"),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "about:blank".into(),
    ]
}

/// A port of this Mac's loopback address that is free now.
fn free_local_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("failed to find a free local port: {error}"))?;
    let address = listener.local_addr().map_err(|error| format!("failed to find a free local port: {error}"))?;
    Ok(address.port())
}

/// Waits until the starting Chrome `child` answers on `port` and returns the WebSocket URL of its browser target.
async fn wait_for_endpoint(port: u16, child: &mut Child) -> Result<String, String> {
    let started = tokio::time::Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Google Chrome exited at its start ({status})"));
        }
        if let Ok(endpoint) = browser_endpoint(port).await {
            return Ok(endpoint);
        }
        if started.elapsed() > START_TIMEOUT {
            return Err(format!("Google Chrome did not answer on port {port} within {} s", START_TIMEOUT.as_secs()));
        }
        tokio::time::sleep(START_POLL).await;
    }
}

/// Asks `/json/version` on `port` for the WebSocket URL of the browser target.
async fn browser_endpoint(port: u16) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|error| format!("failed to reach the browser: {error}"))?;
    let request = format!("GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.map_err(|error| format!("failed to ask the browser: {error}"))?;
    let mut response = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(body) = http_body(&response) {
            return websocket_url(body);
        }
        let read = stream.read(&mut chunk).await.map_err(|error| format!("failed to read the answer of the browser: {error}"))?;
        if read == 0 || response.len() + read > MAX_RESPONSE_BYTES {
            return Err("the browser sent no complete answer".into());
        }
        response.extend_from_slice(&chunk[..read]);
    }
}

/// The body of the complete `200` HTTP response `response` with a `Content-Length`; `None` while it is incomplete or
/// for another status.
fn http_body(response: &[u8]) -> Option<&[u8]> {
    let header_end = response.windows(4).position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..header_end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut status_parts = lines.next()?.split_whitespace();
    if !status_parts.next()?.starts_with("HTTP/") || status_parts.next()? != "200" {
        return None;
    }
    let length: usize = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("content-length").then(|| value.trim().parse().ok()).flatten()
    })?;
    let body = &response[header_end + 4..];
    (body.len() >= length).then(|| &body[..length])
}

/// The `webSocketDebuggerUrl` of the `/json/version` answer `body`.
fn websocket_url(body: &[u8]) -> Result<String, String> {
    let version: Value = serde_json::from_slice(body).map_err(|error| format!("failed to read the browser's version: {error}"))?;
    version["webSocketDebuggerUrl"].as_str().map(str::to_string).ok_or_else(|| "the browser names no WebSocket URL".into())
}

/// What the CDP task of a Chrome needs to end it once its connection drops: its slot, its generation and the profile lock.
struct Watch {
    slot: BrowserSlot,
    generation: u64,
    profiles: Arc<tokio::sync::Mutex<()>>,
}

/// Runs the CDP connection of a Chrome: attaches to its pages, hands the annotations of their widget to `on_annotation`
/// and carries out `controls`. Once the connection drops (the Chrome closed or quit), the Chrome ends like a close, unless
/// a close or a newer Chrome took its slot meanwhile.
async fn run_cdp<Stream>(
    stream: tokio_tungstenite::WebSocketStream<Stream>,
    mut controls: UnboundedReceiver<Control>,
    on_annotation: AnnotationSink,
    watch: Watch,
) where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut source) = stream.split();
    let mut cdp = Cdp::default();
    let mut outgoing = vec![cdp.start()];
    'connection: loop {
        for text in outgoing.drain(..) {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break 'connection;
            }
        }
        tokio::select! {
            message = source.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let handled = cdp.handle(text.as_str());
                    outgoing = handled.outgoing;
                    match handled.annotation {
                        Some(Ok(annotation)) => on_annotation(annotation),
                        Some(Err(error)) => eprintln!("dropping an annotation of the browser: {error}"),
                        None => {}
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
            control = controls.recv() => match control {
                Some(control) => outgoing = vec![cdp.control(control)],
                None => break,
            },
        }
    }
    drop(controls);
    let mut running = watch.slot.lock().await;
    if let Some(browser) = running.take_if(|browser| browser.generation == watch.generation) {
        browser.end(&watch.profiles, false).await;
    }
}

/// The CDP state of a Chrome's connection: the message IDs and the attached pages. Turns what Chrome sends into what
/// Hunt answers, without doing I/O.
#[derive(Default)]
struct Cdp {
    next_id: u64,
    /// The CDP sessions of the attached pages, in the order they were attached.
    pages: Vec<String>,
}

/// What `Cdp::handle` makes of a message of Chrome.
#[derive(Debug, Default)]
struct Handled {
    /// The messages to send to Chrome, in order.
    outgoing: Vec<String>,
    /// The annotation the review widget reported, or why it is dropped.
    annotation: Option<Result<Annotation, String>>,
}

impl Cdp {
    /// A command to `method` with `params`, to the page of `session_id` or else to the browser.
    fn command(&mut self, method: &str, params: Value, session_id: Option<&str>) -> String {
        self.next_id += 1;
        let mut command = json!({ "id": self.next_id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            command["sessionId"] = json!(session_id);
        }
        command.to_string()
    }

    /// The first command: attach to every page, holding a new one until it got the binding and the widget.
    fn start(&mut self) -> String {
        self.command("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }), None)
    }

    /// The commands that carry out `control`.
    fn control(&mut self, control: Control) -> String {
        match control {
            Control::BringToFront => match self.pages.last().cloned() {
                Some(page) => self.command("Page.bringToFront", json!({}), Some(&page)),
                None => self.command("Target.createTarget", json!({ "url": "about:blank", "newWindow": true }), None),
            },
        }
    }

    /// What follows from the message `text` of Chrome: a page that was attached gets the binding and the widget, also
    /// when it already shows a document, and goes on (Chrome runs the scripts for new documents and installs the binding
    /// only while the page's Page and Runtime domains are enabled); another target goes on and is detached; a binding call of the
    /// widget is an annotation; a failed command is logged.
    fn handle(&mut self, text: &str) -> Handled {
        let mut handled = Handled::default();
        let Ok(message) = serde_json::from_str::<Value>(text) else { return handled };
        if let Some(error) = message.get("error") {
            eprintln!("a CDP command of the browser failed: {error}");
            return handled;
        }
        let params = &message["params"];
        match message["method"].as_str() {
            Some("Target.attachedToTarget") => {
                let Some(session_id) = params["sessionId"].as_str() else { return handled };
                let is_waiting = params["waitingForDebugger"].as_bool().unwrap_or(false);
                if params["targetInfo"]["type"].as_str() == Some("page") {
                    self.pages.push(session_id.to_string());
                    handled.outgoing.push(self.command("Page.enable", json!({}), Some(session_id)));
                    handled.outgoing.push(self.command("Runtime.enable", json!({}), Some(session_id)));
                    handled.outgoing.push(self.command("Runtime.addBinding", json!({ "name": BINDING }), Some(session_id)));
                    handled.outgoing.push(self.command("Page.addScriptToEvaluateOnNewDocument", json!({ "source": WIDGET }), Some(session_id)));
                    if !is_waiting {
                        handled.outgoing.push(self.command("Runtime.evaluate", json!({ "expression": WIDGET }), Some(session_id)));
                    }
                }
                if is_waiting {
                    handled.outgoing.push(self.command("Runtime.runIfWaitingForDebugger", json!({}), Some(session_id)));
                }
                if params["targetInfo"]["type"].as_str() != Some("page") {
                    handled.outgoing.push(self.command("Target.detachFromTarget", json!({ "sessionId": session_id }), None));
                }
            }
            Some("Target.detachedFromTarget") => {
                if let Some(session_id) = params["sessionId"].as_str() {
                    self.pages.retain(|page| page != session_id);
                }
            }
            Some("Runtime.bindingCalled") if params["name"].as_str() == Some(BINDING) => {
                let payload = params["payload"].as_str().unwrap_or_default();
                handled.annotation = Some(parse_annotation(payload, Uuid::new_v4(), chrono::Utc::now().timestamp_millis()));
            }
            _ => {}
        }
        handled
    }
}

/// The longest value of each text field of an annotation, in UTF-16 code units (mirror of `ANNOTATION_LIMITS` in
/// `libs/domain/src/browserAnnotation.ts`).
mod limits {
    pub const URL: usize = 2048;
    pub const TITLE: usize = 512;
    pub const SELECTOR: usize = 1024;
    pub const TEXT: usize = 1000;
    pub const OUTER_HTML: usize = 4000;
    pub const COMMENT: usize = 4000;
    pub const SOURCE_FILE: usize = 512;
    pub const STYLE_COUNT: usize = 32;
    pub const STYLE_NAME: usize = 64;
    pub const STYLE_VALUE: usize = 256;
    pub const LINE_NUMBER: u32 = 10_000_000;
}

/// The annotation the widget sent as `payload` (a `BrowserAnnotation` as JSON), with the ID `id` and the time
/// `created_at` (Unix ms), checked like `parseBrowserAnnotation` in `libs/domain/src/browserAnnotation.ts` does.
fn parse_annotation(payload: &str, id: Uuid, created_at: i64) -> Result<Annotation, String> {
    let mut value: Value = serde_json::from_str(payload).map_err(|error| format!("failed to read the annotation: {error}"))?;
    let fields = value.as_object_mut().ok_or("failed to read the annotation: it is no object")?;
    fields.insert("id".into(), json!(id.to_string()));
    fields.insert("createdAt".into(), json!(created_at));
    let annotation: Annotation = serde_json::from_value(value).map_err(|error| format!("failed to read the annotation: {error}"))?;
    check_annotation(&annotation).map_err(|problem| format!("failed to read the annotation: {problem}"))?;
    Ok(annotation)
}

/// The first problem of `annotation` that `parseBrowserAnnotation` would report.
fn check_annotation(annotation: &Annotation) -> Result<(), String> {
    let text_fields = [
        ("url", &annotation.url, limits::URL, true),
        ("title", &annotation.title, limits::TITLE, false),
        ("selector", &annotation.selector, limits::SELECTOR, true),
        ("text", &annotation.text, limits::TEXT, false),
        ("outerHtml", &annotation.outer_html, limits::OUTER_HTML, false),
        ("comment", &annotation.comment, limits::COMMENT, true),
    ];
    for (field, value, limit, is_required) in text_fields {
        if utf16_length(value) > limit || (is_required && value.trim().is_empty()) {
            let kind = if is_required { "non-empty " } else { "" };
            return Err(format!("{field} must be a {kind}string of at most {limit} characters"));
        }
    }
    let are_styles_valid = annotation.styles.len() <= limits::STYLE_COUNT
        && annotation.styles.iter().all(|(name, style)| is_style_name(name) && name.len() <= limits::STYLE_NAME && utf16_length(style) <= limits::STYLE_VALUE);
    if !are_styles_valid {
        return Err(format!("styles must map at most {} CSS properties to strings", limits::STYLE_COUNT));
    }
    if let Some(source) = &annotation.source {
        let is_column_valid = source.column.is_none_or(|column| column <= limits::LINE_NUMBER);
        if source.file.is_empty() || utf16_length(&source.file) > limits::SOURCE_FILE || source.line > limits::LINE_NUMBER || !is_column_valid {
            return Err("source must hold a file and a line, optionally a column".into());
        }
    }
    Ok(())
}

/// The length of `value` as JavaScript counts it.
fn utf16_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Whether `name` is a CSS property name as the widget sends it (`^-?[a-z][a-z-]*$`).
fn is_style_name(name: &str) -> bool {
    let unprefixed = name.strip_prefix('-').unwrap_or(name);
    let mut characters = unprefixed.chars();
    characters.next().is_some_and(|first| first.is_ascii_lowercase()) && characters.all(|character| character.is_ascii_lowercase() || character == '-')
}

/// The control socket of this Hunt process's browser wrappers in `browser_dir`. Each process has its own, since a
/// `tauri dev` beside the installed app shares its app data folder.
pub fn control_socket_path(browser_dir: &Path) -> PathBuf {
    browser_dir.join(format!("{CONTROL_SOCKET_PREFIX}{}.sock", std::process::id()))
}

/// Removes the control sockets in `dir` that no Hunt process listens on any more.
fn remove_stale_control_sockets(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let is_control_socket = path.file_name().is_some_and(|name| name.to_string_lossy().starts_with(CONTROL_SOCKET_PREFIX));
        if is_control_socket && std::os::unix::net::UnixStream::connect(&path).is_err() {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Serves the control socket at `socket_path`, which only this user may use: a wrapper sends one line
/// `{"open":"<session id>"}` before its agent's first browser tool and gets `{"ok":true}` once `open` opened the
/// session's Chrome, or `{"error":"…"}`. Sockets left by earlier runs are removed. Returns only when it cannot listen.
pub async fn serve_control<Open, OpenFuture>(socket_path: PathBuf, open: Open) -> Result<(), String>
where
    Open: Fn(Uuid) -> OpenFuture + Clone + Send + Sync + 'static,
    OpenFuture: Future<Output = Result<(), String>> + Send,
{
    let failed = |error: std::io::Error| format!("failed to listen on {}: {error}", socket_path.display());
    let path_length = socket_path.as_os_str().len();
    if path_length > MAX_SOCKET_PATH_BYTES {
        return Err(format!(
            "failed to listen on {}: the path has {path_length} bytes, more than the {MAX_SOCKET_PATH_BYTES} macOS allows for a socket",
            socket_path.display()
        ));
    }
    if let Some(dir) = socket_path.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(failed)?;
        remove_stale_control_sockets(dir).map_err(failed)?;
    }
    let listener = UnixListener::bind(&socket_path).map_err(failed)?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).map_err(failed)?;
    loop {
        let (stream, _) = listener.accept().await.map_err(failed)?;
        let open = open.clone();
        tokio::spawn(async move {
            if let Err(error) = answer_control(stream, open).await {
                eprintln!("{error}");
            }
        });
    }
}

/// Reads the one request of a wrapper on `stream`, carries it out with `open` and answers.
async fn answer_control<Open, OpenFuture>(stream: UnixStream, open: Open) -> Result<(), String>
where
    Open: Fn(Uuid) -> OpenFuture,
    OpenFuture: Future<Output = Result<(), String>>,
{
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    BufReader::new(reader.take(MAX_CONTROL_LINE_BYTES))
        .read_line(&mut line)
        .await
        .map_err(|error| format!("failed to read a request of the browser control socket: {error}"))?;
    let result = match parse_control_request(&line) {
        Ok(id) => open(id).await,
        Err(error) => Err(error),
    };
    writer
        .write_all(control_reply(&result).as_bytes())
        .await
        .map_err(|error| format!("failed to answer on the browser control socket: {error}"))
}

/// The session ID of the control request `line`.
fn parse_control_request(line: &str) -> Result<Uuid, String> {
    let request: Value = serde_json::from_str(line.trim()).map_err(|error| format!("failed to read the request: {error}"))?;
    let id = request["open"].as_str().ok_or("failed to read the request: it names no session to open")?;
    Uuid::parse_str(id).map_err(|error| format!("failed to read the request: {error}"))
}

/// The answer line to a control request that ended with `result`.
fn control_reply(result: &Result<(), String>) -> String {
    let reply = match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    };
    format!("{reply}\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const PAYLOAD: &str = concat!(
        r#"{"url":"https://app.example/cart","title":"Cart","selector":"main > button.buy","text":"Buy","#,
        r#""outerHtml":"<button class=\"buy\">Buy</button>","rect":{"x":10,"y":20.5,"width":80,"height":32},"#,
        r#""viewport":{"width":1280,"height":800},"styles":{"color":"rgb(0, 0, 0)","-webkit-appearance":"none"},"#,
        r#""source":{"file":"src/Cart.tsx","line":12,"column":5},"comment":"Make it blue"}"#,
    );

    #[test]
    fn reserve_port_keeps_the_port_of_a_session() {
        let registry = BrowserRegistry::default();
        let first = Uuid::new_v4();
        let port = registry.reserve_port(first).unwrap();
        assert_ne!(port, 0);
        assert_eq!(registry.reserve_port(first).unwrap(), port);
        assert_ne!(registry.reserve_port(Uuid::new_v4()).unwrap(), port);
    }

    #[test]
    fn repo_hash_is_stable_and_tells_repositories_apart() {
        let hash = repo_hash(Path::new("/Users/someone/Development/app"));
        assert_eq!(hash.len(), 16);
        assert!(hash.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(hash, repo_hash(Path::new("/Users/someone/Development/app")));
        assert_ne!(hash, repo_hash(Path::new("/Users/someone/Development/other")));
    }

    #[test]
    fn profile_paths_live_under_the_browser_folder() {
        let id = Uuid::new_v4();
        let profile = Profile::of(Path::new("/data/browser"), Path::new("/repo"), id);
        assert_eq!(profile.repository, Path::new("/data/browser").join(repo_hash(Path::new("/repo"))).join("profile"));
        assert_eq!(profile.session, Path::new("/data/browser/sessions").join(id.to_string()));
    }

    #[test]
    fn a_profile_copy_leaves_out_locks_ports_and_caches() {
        assert!(is_left_out("SingletonLock", false));
        assert!(is_left_out("SingletonSocket", false));
        assert!(is_left_out("DevToolsActivePort", false));
        assert!(is_left_out("Code Cache", true));
        assert!(is_left_out("GPUCache", true));
        assert!(!is_left_out("Cookies", false));
        assert!(!is_left_out("Local State", false));
        assert!(!is_left_out("CacheNamedFile", false));
        assert!(!is_left_out("Default", true));

        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("from");
        std::fs::create_dir_all(from.join("Default/Cache/Cache_Data")).unwrap();
        std::fs::create_dir_all(from.join("Default/Local Storage")).unwrap();
        std::fs::write(from.join("Local State"), "{}").unwrap();
        std::fs::write(from.join("DevToolsActivePort"), "9222").unwrap();
        std::fs::write(from.join("Default/Cookies"), "cookies").unwrap();
        std::fs::write(from.join("Default/Local Storage/leveldb"), "storage").unwrap();
        std::fs::write(from.join("Default/Cache/Cache_Data/data_0"), "cache").unwrap();
        std::os::unix::fs::symlink("host-123", from.join("SingletonLock")).unwrap();

        let to = root.path().join("to");
        copy_profile(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(to.join("Local State")).unwrap(), "{}");
        assert_eq!(std::fs::read_to_string(to.join("Default/Cookies")).unwrap(), "cookies");
        assert_eq!(std::fs::read_to_string(to.join("Default/Local Storage/leveldb")).unwrap(), "storage");
        assert!(!to.join("DevToolsActivePort").exists());
        assert!(!to.join("Default/Cache").exists());
        assert!(std::fs::symlink_metadata(to.join("SingletonLock")).is_err());

        prune_profile(&from).unwrap();
        assert!(!from.join("Default/Cache").exists());
        assert!(!from.join("DevToolsActivePort").exists());
        assert!(std::fs::symlink_metadata(from.join("SingletonLock")).is_err());
        assert!(from.join("Default/Cookies").exists());
    }

    #[test]
    fn a_session_profile_starts_from_the_repository_profile_and_replaces_it_at_the_end() {
        let root = tempfile::tempdir().unwrap();
        let profile = Profile::of(root.path(), Path::new("/repo"), Uuid::new_v4());
        profile.prepare().unwrap();
        assert!(profile.session.is_dir());
        std::fs::write(profile.session.join("Cookies"), "first").unwrap();
        std::fs::write(profile.session.join("SingletonLock"), "").unwrap();
        profile.restore().unwrap();
        assert!(!profile.session.exists());
        assert_eq!(std::fs::read_to_string(profile.repository.join("Cookies")).unwrap(), "first");
        assert!(!profile.repository.join("SingletonLock").exists());

        profile.prepare().unwrap();
        assert_eq!(std::fs::read_to_string(profile.session.join("Cookies")).unwrap(), "first");
        std::fs::write(profile.session.join("Cookies"), "second").unwrap();
        profile.restore().unwrap();
        assert_eq!(std::fs::read_to_string(profile.repository.join("Cookies")).unwrap(), "second");
        let leftovers: Vec<_> = std::fs::read_dir(profile.repository.parent().unwrap()).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn chrome_gets_its_own_profile_and_port() {
        let args = chrome_args(Path::new("/data/browser/sessions/abc"), 9333);
        assert_eq!(args[0], "--user-data-dir=/data/browser/sessions/abc");
        assert_eq!(args[1], "--remote-debugging-port=9333");
        assert!(args.contains(&"--no-first-run".to_string()));
        assert_eq!(args.last().unwrap(), "about:blank");
    }

    #[test]
    fn http_body_waits_for_the_whole_body_of_a_200() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"a\":\"b\"}";
        assert_eq!(http_body(response), None);
        let complete = b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\n{\"a\":\"b\"}";
        assert_eq!(http_body(complete), Some(&b"{\"a\":\"b\"}"[..]));
        assert_eq!(http_body(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"), None);
        assert_eq!(http_body(b"HTTP/1.1 200 OK\r\n"), None);
    }

    #[test]
    fn websocket_url_reads_the_browser_target() {
        let body = br#"{"Browser":"Chrome/141.0","webSocketDebuggerUrl":"ws://127.0.0.1:9333/devtools/browser/abc"}"#;
        assert_eq!(websocket_url(body).unwrap(), "ws://127.0.0.1:9333/devtools/browser/abc");
        assert!(websocket_url(b"{}").is_err());
    }

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn the_connection_starts_by_attaching_to_every_page() {
        let mut cdp = Cdp::default();
        let start = parsed(&cdp.start());
        assert_eq!(start["id"], 1);
        assert_eq!(start["method"], "Target.setAutoAttach");
        assert_eq!(start["params"], json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }));
        assert!(start.get("sessionId").is_none());
    }

    #[test]
    fn a_new_page_gets_the_binding_and_the_widget_before_it_goes_on() {
        let mut cdp = Cdp::default();
        let attached = json!({
            "method": "Target.attachedToTarget",
            "params": { "sessionId": "S1", "targetInfo": { "targetId": "T1", "type": "page" }, "waitingForDebugger": true },
        })
        .to_string();
        let outgoing: Vec<Value> = cdp.handle(&attached).outgoing.iter().map(|text| parsed(text)).collect();
        let methods: Vec<&str> = outgoing.iter().map(|command| command["method"].as_str().unwrap()).collect();
        let expected = ["Page.enable", "Runtime.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Runtime.runIfWaitingForDebugger"];
        assert_eq!(methods, expected);
        assert!(outgoing.iter().all(|command| command["sessionId"] == "S1"));
        assert_eq!(outgoing[2]["params"]["name"], BINDING);
        assert_eq!(outgoing[3]["params"]["source"], WIDGET);
        assert_eq!(cdp.pages, ["S1"]);
    }

    #[test]
    fn a_page_that_was_open_already_gets_the_widget_at_once() {
        let mut cdp = Cdp::default();
        let attached = r#"{"method":"Target.attachedToTarget","params":{"sessionId":"S1","targetInfo":{"type":"page"},"waitingForDebugger":false}}"#;
        let methods: Vec<String> = cdp.handle(attached).outgoing.iter().map(|text| parsed(text)["method"].as_str().unwrap().to_string()).collect();
        assert_eq!(methods, ["Page.enable", "Runtime.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
    }

    #[test]
    fn another_target_goes_on_and_is_detached() {
        let mut cdp = Cdp::default();
        let attached = r#"{"method":"Target.attachedToTarget","params":{"sessionId":"W1","targetInfo":{"type":"service_worker"},"waitingForDebugger":true}}"#;
        let outgoing: Vec<Value> = cdp.handle(attached).outgoing.iter().map(|text| parsed(text)).collect();
        assert_eq!(outgoing[0]["method"], "Runtime.runIfWaitingForDebugger");
        assert_eq!(outgoing[0]["sessionId"], "W1");
        assert_eq!(outgoing[1]["method"], "Target.detachFromTarget");
        assert_eq!(outgoing[1]["params"]["sessionId"], "W1");
        assert!(outgoing[1].get("sessionId").is_none());
        assert!(cdp.pages.is_empty());
    }

    #[test]
    fn bring_to_front_shows_the_last_page_or_opens_a_window() {
        let mut cdp = Cdp::default();
        assert_eq!(parsed(&cdp.control(Control::BringToFront))["method"], "Target.createTarget");
        for session in ["S1", "S2"] {
            let attached = json!({
                "method": "Target.attachedToTarget",
                "params": { "sessionId": session, "targetInfo": { "type": "page" }, "waitingForDebugger": true },
            });
            cdp.handle(&attached.to_string());
        }
        let front = parsed(&cdp.control(Control::BringToFront));
        assert_eq!(front["method"], "Page.bringToFront");
        assert_eq!(front["sessionId"], "S2");
        cdp.handle(r#"{"method":"Target.detachedFromTarget","params":{"sessionId":"S2"}}"#);
        assert_eq!(parsed(&cdp.control(Control::BringToFront))["sessionId"], "S1");
    }

    #[test]
    fn a_binding_call_of_the_widget_is_an_annotation() {
        let mut cdp = Cdp::default();
        let called = json!({ "method": "Runtime.bindingCalled", "sessionId": "S1", "params": { "name": BINDING, "payload": PAYLOAD, "executionContextId": 3 } });
        let handled = cdp.handle(&called.to_string());
        assert!(handled.outgoing.is_empty());
        let annotation = handled.annotation.unwrap().unwrap();
        assert_eq!(annotation.comment, "Make it blue");
        assert!(Uuid::parse_str(&annotation.id).is_ok());
        assert!(annotation.created_at > 0);

        let other = json!({ "method": "Runtime.bindingCalled", "params": { "name": "somethingElse", "payload": PAYLOAD } });
        assert!(cdp.handle(&other.to_string()).annotation.is_none());
        assert!(cdp.handle("not json").annotation.is_none());
        assert!(cdp.handle(r#"{"id":4,"error":{"code":-32000,"message":"No target"}}"#).outgoing.is_empty());
    }

    #[test]
    fn parse_annotation_adds_the_id_and_time() {
        let id = Uuid::new_v4();
        let annotation = parse_annotation(PAYLOAD, id, 1_760_000_000_000).unwrap();
        assert_eq!(annotation.id, id.to_string());
        assert_eq!(annotation.created_at, 1_760_000_000_000);
        assert_eq!(annotation.selector, "main > button.buy");
        assert_eq!(annotation.styles, BTreeMap::from([("color".into(), "rgb(0, 0, 0)".into()), ("-webkit-appearance".into(), "none".into())]));
        let payload = serde_json::to_value(&annotation).unwrap();
        assert_eq!(payload["createdAt"], 1_760_000_000_000_i64);
        assert_eq!(payload["source"], json!({ "file": "src/Cart.tsx", "line": 12, "column": 5 }));
    }

    #[test]
    fn parse_annotation_refuses_what_parse_browser_annotation_refuses() {
        let with = |field: &str, value: Value| {
            let mut payload: Value = serde_json::from_str(PAYLOAD).unwrap();
            payload[field] = value;
            parse_annotation(&payload.to_string(), Uuid::new_v4(), 0)
        };
        assert!(with("comment", json!("   ")).unwrap_err().contains("comment must be a non-empty string"));
        assert!(with("url", json!("x".repeat(2049))).unwrap_err().contains("url"));
        assert!(with("url", json!("x".repeat(2048))).is_ok());
        assert!(with("title", json!("")).is_ok());
        assert!(with("outerHtml", json!("é".repeat(4000))).is_ok());
        assert!(with("outerHtml", json!("😀".repeat(2001))).is_err());
        assert!(with("styles", json!({ "Color": "red" })).unwrap_err().contains("styles"));
        assert!(with("styles", json!({ "--custom": "red" })).is_err());
        let many: serde_json::Map<String, Value> = (0..33).map(|index| (format!("p{}", "x".repeat(index)), json!("1"))).collect();
        assert!(with("styles", Value::Object(many)).is_err());
        assert!(with("source", json!({ "file": "", "line": 1 })).unwrap_err().contains("source"));
        assert!(with("source", json!({ "file": "a.ts", "line": 10_000_001 })).is_err());
        assert!(with("rect", json!({ "x": 1 })).is_err());
        assert!(parse_annotation("[]", Uuid::new_v4(), 0).is_err());
        assert!(parse_annotation("not json", Uuid::new_v4(), 0).is_err());
    }

    #[test]
    fn style_names_follow_the_widget() {
        assert!(is_style_name("color"));
        assert!(is_style_name("background-color"));
        assert!(is_style_name("-webkit-appearance"));
        assert!(!is_style_name("--custom"));
        assert!(!is_style_name("Color"));
        assert!(!is_style_name(""));
        assert!(!is_style_name("-"));
    }

    #[test]
    fn control_requests_name_a_session() {
        let id = Uuid::new_v4();
        assert_eq!(parse_control_request(&format!("{{\"open\":\"{id}\"}}\n")).unwrap(), id);
        assert!(parse_control_request("{}").is_err());
        assert!(parse_control_request(r#"{"open":"nope"}"#).is_err());
        assert!(parse_control_request("").is_err());
        assert_eq!(control_reply(&Ok(())), "{\"ok\":true}\n");
        assert_eq!(control_reply(&Err("no \"session\"".into())), "{\"error\":\"no \\\"session\\\"\"}\n");
    }

    #[tokio::test]
    async fn the_control_socket_answers_each_request() {
        let root = tempfile::tempdir().unwrap();
        let socket_path = control_socket_path(&root.path().join("browser"));
        let known = Uuid::new_v4();
        let server_path = socket_path.clone();
        let server = tokio::spawn(serve_control(server_path, move |id| async move {
            if id == known { Ok(()) } else { Err(format!("failed to open the browser: the session {id} is not stored")) }
        }));
        while !socket_path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mode = std::fs::metadata(&socket_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let ask = |line: String| {
            let socket_path = socket_path.clone();
            async move {
                let mut stream = UnixStream::connect(&socket_path).await.unwrap();
                stream.write_all(line.as_bytes()).await.unwrap();
                let mut reply = String::new();
                BufReader::new(stream).read_line(&mut reply).await.unwrap();
                reply
            }
        };
        assert_eq!(ask(format!("{{\"open\":\"{known}\"}}\n")).await, "{\"ok\":true}\n");
        assert!(ask(format!("{{\"open\":\"{}\"}}\n", Uuid::new_v4())).await.contains("is not stored"));
        assert!(ask("garbage\n".into()).await.starts_with("{\"error\":\"failed to read the request"));
        server.abort();
    }

    #[tokio::test]
    async fn the_control_socket_refuses_a_path_macos_cannot_bind() {
        let long_path = PathBuf::from(format!("/tmp/{}/control.sock", "x".repeat(100)));
        let error = serve_control(long_path, |_| async { Ok(()) }).await.unwrap_err();
        assert!(error.contains("more than the 103 macOS allows for a socket"), "{error}");
    }

    /// Starts the real Google Chrome with a fresh repository profile, lets a page call the binding and closes it again:
    /// `cargo test browser::tests::real_chrome -- --ignored`.
    #[tokio::test]
    #[ignore = "starts Google Chrome"]
    async fn real_chrome_reports_annotations_and_keeps_its_profile() {
        let root = tempfile::tempdir().unwrap();
        let browser_dir = root.path().join("browser");
        let repo_path = root.path().join("repo");
        let registry = BrowserRegistry::default();
        let id = Uuid::new_v4();
        let (annotations, mut received) = unbounded_channel();
        let sink: AnnotationSink = Arc::new(move |annotation| {
            let _ = annotations.send(annotation);
        });
        registry.open(id, &repo_path, &browser_dir, sink.clone(), false).await.unwrap();
        registry.open(id, &repo_path, &browser_dir, sink, true).await.unwrap();
        let port = registry.reserve_port(id).unwrap();

        let endpoint = browser_endpoint(port).await.unwrap();
        let (mut client, _) = tokio_tungstenite::connect_async(endpoint.as_str()).await.unwrap();
        let mut next_id = 0;
        let mut call = async |method: &str, params: Value, session_id: Option<&str>| -> Value {
            next_id += 1;
            let mut command = json!({ "id": next_id, "method": method, "params": params });
            if let Some(session_id) = session_id {
                command["sessionId"] = json!(session_id);
            }
            client.send(Message::Text(command.to_string().into())).await.unwrap();
            loop {
                let Some(Ok(Message::Text(text))) = client.next().await else { panic!("the browser closed the connection") };
                let reply: Value = serde_json::from_str(text.as_str()).unwrap();
                if reply["id"] == next_id {
                    return reply;
                }
            }
        };
        let page = "data:text/html,<title>Cart</title><main><button class=buy>Buy</button></main>";
        let created = call("Target.createTarget", json!({ "url": page }), None).await;
        let target_id = created["result"]["targetId"].as_str().unwrap().to_string();
        let attached = call("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None).await;
        let page_session = attached["result"]["sessionId"].as_str().unwrap().to_string();
        let mut has_binding = false;
        for _ in 0..50 {
            let probe = call("Runtime.evaluate", json!({ "expression": format!("typeof window.{BINDING}"), "returnByValue": true }), Some(&page_session)).await;
            if probe["result"]["result"]["value"] == "function" {
                has_binding = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(has_binding, "the page never got the binding");
        let widget_count = json!({ "expression": "document.querySelectorAll('hunt-review').length", "returnByValue": true });
        let widget = call("Runtime.evaluate", widget_count, Some(&page_session)).await;
        assert_eq!(widget["result"]["result"]["value"], 1, "the page shows no single review widget");
        call("Page.navigate", json!({ "url": "data:text/html,<title>Next</title><p>Next page</p>" }), Some(&page_session)).await;
        let mut has_widget_after_navigation = false;
        for _ in 0..50 {
            let title_and_widgets = json!({ "expression": "document.title + ':' + document.querySelectorAll('hunt-review').length", "returnByValue": true });
            let probe = call("Runtime.evaluate", title_and_widgets, Some(&page_session)).await;
            if probe["result"]["result"]["value"] == "Next:1" {
                has_widget_after_navigation = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(has_widget_after_navigation, "the next document shows no review widget");
        let expression = format!("window.{BINDING}(JSON.stringify({PAYLOAD}))");
        call("Runtime.evaluate", json!({ "expression": expression }), Some(&page_session)).await;
        let annotation = tokio::time::timeout(Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
        assert_eq!(annotation.comment, "Make it blue");
        assert_eq!(annotation.url, "https://app.example/cart");
        println!("annotation from the real Chrome: {}", serde_json::to_string(&annotation).unwrap());

        registry.close(id).await;
        let profile = Profile::of(&browser_dir, &repo_path, id);
        assert!(!profile.session.exists(), "the session's profile is left");
        assert!(profile.repository.join("Local State").is_file(), "the repository's profile lacks Chrome's state");
        assert!(browser_endpoint(port).await.is_err(), "the browser still answers");
        let entries: Vec<_> = std::fs::read_dir(&profile.repository).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        println!("repository profile after close: {entries:?}");
    }
}
