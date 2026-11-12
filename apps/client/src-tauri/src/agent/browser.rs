//! The Chrome of a session: a Google Chrome of its own on this Mac, in a window of its own, which the agent of a local
//! session drives through Playwright MCP (`apps/client/scripts/browserMcp.mjs`, `--cdp-endpoint` on the session's port)
//! and on whose pages Hunt shows the review widget. A remote session's agent drives the Chromium on its VM instead; its
//! Chrome here shows the preview of the VM's apps to the user alone. Its profile is a copy of the repository's profile (`<browser dir>/<repo hash>/
//! profile`) in `<browser dir>/sessions/<session id>`, so the repository's logins are there; when the Chrome ends, the
//! copy replaces the repository's profile, so the session closed last wins. Chrome starts on demand: when the agent calls
//! its first browser tool (the wrapper asks through the control socket, `crate::platform::control`) or the user clicks
//! "Browser", which also opens a tab for each running app of the session that shows a page (`crate::agent::app_pages`).
//! Hunt attaches over CDP to the pages that show the session's apps, and to nothing else in the Chrome, adds the binding
//! `__huntReview` and the widget, captures a PNG of the element each annotation the widget reports picked, and hands
//! both to the caller's sink, with the session the widget's dropdown names and whether it is sent at once (`Delivery`);
//! the sessions the dropdown lists come from the caller (`ReviewHooks`). Knows nothing about Tauri;
//! `session/commands/browser.rs` owns the command and the sink.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::remote::status_channel::{Annotation, AnnotationRect};

/// The Chrome Hunt starts; its absence is an error of `open`.
const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/// The name of the binding the review widget calls with an annotation as JSON (`apps/session/src/review/review-widget.main.ts`).
pub const BINDING: &str = "__huntReview";

/// The review widget, built by `client:review-widget` from `apps/session/src/review/review-widget.main.ts`.
const WIDGET: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/review.js"));

/// How long a starting Chrome may take until its DevTools endpoint answers.
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a closing Chrome may take to exit before it is killed.
const EXIT_TIMEOUT: Duration = Duration::from_secs(5);

/// How often the DevTools endpoint of a starting Chrome is asked.
const START_POLL: Duration = Duration::from_millis(100);

/// The bytes of an answer of the DevTools endpoint that are read.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// How long an annotation waits for the screenshot of its element before it is reported without one.
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(2);

/// The CSS pixels around the picked element that its screenshot shows on each side.
const SCREENSHOT_PADDING: f64 = 8.0;

/// What the review widget calls the binding with instead of an annotation to ask for the sessions (`SESSIONS_REQUEST`
/// in `apps/session/src/review/annotation-delivery.utils.ts`).
const SESSIONS_REQUEST: &str = "sessions";

/// The global of the page the sessions are answered through (`SESSIONS_CALLBACK` there).
const SESSIONS_CALLBACK: &str = "__huntReviewSessions";

/// What is called with every annotation the review widget of a session's Chrome reports, together with the PNG of the
/// picked element, `None` when it could not be captured, and where the widget wants it.
pub type AnnotationSink = Arc<dyn Fn(Annotation, Option<Vec<u8>>, Delivery) + Send + Sync>;

/// What the review widget of a session's Chrome reaches Hunt through.
#[derive(Clone)]
pub struct ReviewHooks {
    pub on_annotation: AnnotationSink,
    /// The sessions the widget's dropdown lists, read anew for each comment box.
    pub sessions: Arc<dyn Fn() -> ReviewSessions + Send + Sync>,
}

/// A session an annotation can go to (mirror of `ReviewSession` in `annotation-delivery.utils.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub id: Uuid,
    pub title: String,
    pub is_sub: bool,
}

/// The sessions an annotation of a Chrome can go to, the main session first, and the one the Chrome belongs to (mirror
/// of `ReviewSessions` in `annotation-delivery.utils.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSessions {
    pub sessions: Vec<ReviewSession>,
    pub own: Uuid,
}

impl ReviewSessions {
    /// The session the annotation with `delivery` is for and whether it goes to a new sub session of it: the main
    /// session for a new one, else the session the widget named, or the Chrome's own for one that is not listed.
    pub fn target(&self, delivery: &Delivery) -> (Uuid, bool) {
        if delivery.is_new {
            return (self.sessions.first().map_or(self.own, |main| main.id), true);
        }
        let named = delivery.session_id.filter(|id| self.sessions.iter().any(|session| session.id == *id));
        (named.unwrap_or(self.own), false)
    }
}

/// Where the widget wants an annotation and what happens to it there (mirror of `AnnotationDelivery` in
/// `annotation-delivery.utils.ts`); the default is the composer of the Chrome's session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Delivery {
    /// The session it goes to; without one, and without `is_new`, the session the Chrome belongs to.
    pub session_id: Option<Uuid>,
    /// It goes to a new sub session of the main session.
    pub is_new: bool,
    /// It is sent as a prompt at once instead of waiting above the composer.
    pub sends: bool,
}

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
#[derive(Debug, Clone, PartialEq, Eq)]
enum Control {
    /// Opens a tab for each of the URLs whose origin no page shows yet, or brings the last page to the front.
    Show(Vec<String>),
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
    /// to the front of the screen with a tab for each of `urls` whose origin no page shows yet. A new Chrome opens `urls`
    /// (`about:blank` without any), gets a copy of the repository's profile under `browser_dir`, listens for CDP on the
    /// session's port and shows the review widget on the pages of the session's apps (`urls` and what this Mac serves), which
    /// reaches Hunt through `hooks`.
    pub async fn open(
        &self,
        id: Uuid,
        repo_path: &Path,
        browser_dir: &Path,
        hooks: ReviewHooks,
        raises: bool,
        urls: &[String],
    ) -> Result<(), String> {
        let slot = self.slots.lock().unwrap().entry(id).or_default().clone();
        let mut running = slot.lock().await;
        if let Some(browser) = running.as_mut() {
            if browser.is_running() {
                if raises {
                    let _ = browser.controls.send(Control::Show(urls.to_vec()));
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
        // A Chrome Hunt is not attached to reports its annotations without a screenshot, and a second one on the profile
        // would leave the user in the wrong window; what it or a Chrome that died left in the folder holds the
        // session's sign-ins, so the folder goes back to the repository before the new copy.
        end_chromes(&chromes_on(&profile.session).await).await;
        {
            let _profiles = self.profiles.lock().await;
            let copied = profile.clone();
            tokio::task::spawn_blocking(move || copied.restore().and_then(|()| copied.prepare()))
                .await
                .map_err(|error| format!("failed to copy the browser profile: {error}"))??;
        }
        let mut child = Command::new(CHROME)
            .args(chrome_args(&profile.session, port, urls))
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
        tokio::spawn(run_cdp(stream, control_receiver, hooks, watch, urls.to_vec()));
        if raises {
            activate_process(child.id());
        }
        *running = Some(RunningBrowser { generation, child, profile, controls });
        Ok(())
    }

    /// Saves the sign-ins of the Chromes an earlier Hunt process could not end (a crash, a restart of `tauri dev`), at
    /// the start of Hunt: for each of `sessions` (ID and repository) whose profile folder is still there, ends the
    /// Chromes left on it and lets the folder replace the repository's profile, the folder used last at the end. A
    /// folder whose Chrome another Hunt process runs stays.
    pub async fn recover_leftovers(&self, browser_dir: &Path, sessions: &[(Uuid, PathBuf)]) {
        let mut profiles: Vec<Profile> = sessions.iter().map(|(id, repo_path)| Profile::of(browser_dir, repo_path, *id)).filter(|profile| profile.session.is_dir()).collect();
        profiles.sort_by_key(|profile| std::fs::metadata(profile.session.join("Local State")).and_then(|metadata| metadata.modified()).ok());
        for profile in profiles {
            let chromes = chromes_on(&profile.session).await;
            if chromes.iter().any(|chrome| chrome.parent != 1) {
                continue;
            }
            end_chromes(&chromes).await;
            let _profiles = self.profiles.lock().await;
            match tokio::task::spawn_blocking(move || profile.restore()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("{error}"),
                Err(error) => eprintln!("failed to restore the browser profile: {error}"),
            }
        }
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
            drop_broken_service_workers(&self.session).map_err(failed)?;
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

/// A Chrome main process on a session profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChromeProcess {
    pid: libc::pid_t,
    /// 1 once the Hunt process that started it is gone.
    parent: libc::pid_t,
}

/// The Chromes that run on the session profile `profile_dir` now. Hunt is attached to none of them: an earlier Hunt
/// process started and could not end them (a crash, a restart of `tauri dev`), or another Hunt process runs them.
async fn chromes_on(profile_dir: &Path) -> Vec<ChromeProcess> {
    match Command::new("/bin/ps").args(["-axww", "-o", "pid=,ppid=,command="]).stdin(Stdio::null()).output().await {
        Ok(output) => chromes_using(&String::from_utf8_lossy(&output.stdout), profile_dir),
        Err(error) => {
            eprintln!("failed to list the browsers on {}: {error}", profile_dir.display());
            Vec::new()
        }
    }
}

/// The Chrome main processes in `processes` (lines of `ps -o pid=,ppid=,command=`) that use the profile `profile_dir`;
/// their helper processes (`--type=…`) end with them.
fn chromes_using(processes: &str, profile_dir: &Path) -> Vec<ChromeProcess> {
    let profile_arg = format!(" --user-data-dir={}", profile_dir.display());
    processes
        .lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(' ')?;
            let (parent, command) = rest.trim_start().split_once(' ')?;
            let uses_profile = command.split_once(profile_arg.as_str()).is_some_and(|(_, rest)| rest.is_empty() || rest.starts_with(' '));
            let is_chrome = command.trim_start().starts_with(CHROME) && uses_profile && !command.contains(" --type=");
            is_chrome.then_some(ChromeProcess { pid: pid.parse().ok()?, parent: parent.parse().ok()? })
        })
        .collect()
}

/// Ends `chromes`: each is asked to quit, which writes its profile, and killed when it does not exit within `EXIT_TIMEOUT`.
async fn end_chromes(chromes: &[ChromeProcess]) {
    // SAFETY: plain syscalls without pointers; a PID that ended meanwhile only makes them fail.
    let signal = |chrome: &ChromeProcess, signal: libc::c_int| unsafe { libc::kill(chrome.pid, signal) == 0 };
    for chrome in chromes {
        signal(chrome, libc::SIGTERM);
    }
    let started = tokio::time::Instant::now();
    while chromes.iter().any(|chrome| signal(chrome, 0)) {
        if started.elapsed() > EXIT_TIMEOUT {
            for chrome in chromes {
                signal(chrome, libc::SIGKILL);
            }
            break;
        }
        tokio::time::sleep(START_POLL).await;
    }
}

/// The folder name of the profile of the repository `repo_path`: the start of the SHA-256 of its path.
fn repo_hash(repo_path: &Path) -> String {
    let digest = Sha256::digest(repo_path.to_string_lossy().as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// The folders of a profile's `Service Worker` folder that hold the scripts and the Cache API storage of its service
/// workers. They are state, not caches: without them the workers its database registers never start, and neither do
/// the extensions that run in them, such as a password manager.
const SERVICE_WORKER_STORES: [&str; 2] = ["ScriptCache", "CacheStorage"];

/// Whether a profile entry named `name` stays out of a copy: Chrome's locks of a running profile, its DevTools port file
/// and, for a folder, its caches.
fn is_left_out(name: &str, is_dir: bool) -> bool {
    name.starts_with("Singleton") || name == "DevToolsActivePort" || (is_dir && name.contains("Cache") && !SERVICE_WORKER_STORES.contains(&name))
}

/// Removes the `Service Worker` folder of every profile in the user data folder `dir` that registers workers but lacks
/// their scripts, as an earlier Hunt saved it; Chrome then registers the extensions' workers anew.
fn drop_broken_service_workers(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let service_worker = entry?.path().join("Service Worker");
        if service_worker.join("Database").is_dir() && !service_worker.join("ScriptCache").is_dir() {
            std::fs::remove_dir_all(&service_worker)?;
        }
    }
    Ok(())
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

/// The command line of a session's Chrome with the profile `profile_dir`, CDP on `port` and a tab for each of `urls`
/// (`about:blank` without any).
fn chrome_args(profile_dir: &Path, port: u16, urls: &[String]) -> Vec<String> {
    let mut args = vec![
        format!("--user-data-dir={}", profile_dir.display()),
        format!("--remote-debugging-port={port}"),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
    ];
    if urls.is_empty() {
        args.push("about:blank".into());
    }
    args.extend(urls.iter().cloned());
    args
}

/// The `scheme://host[:port]` of `url`; `None` for a URL without an authority such as `about:blank`.
fn origin(url: &str) -> Option<&str> {
    let authority_start = url.find("://")? + 3;
    let end = url[authority_start..].find(['/', '?', '#']).map_or(url.len(), |offset| authority_start + offset);
    (end > authority_start).then(|| &url[..end])
}

/// Whether a page showing `url` is one of the session's apps, which gets the review widget: a page served from this
/// Mac (`localhost`, a file, a `data:` URL) or from one of `app_origins`. Anything else, such as a sign-in page, an
/// extension's window or a page of Chrome, stays untouched.
fn is_app_page(url: &str, app_origins: &[String]) -> bool {
    if url.starts_with("file://") || url.starts_with("data:") {
        return true;
    }
    let Some(origin) = origin(url).filter(|origin| origin.starts_with("http://") || origin.starts_with("https://")) else { return false };
    let authority = origin.split_once("://").map_or("", |(_, authority)| authority);
    let host = authority.rsplit_once(':').filter(|(_, port)| port.chars().all(|digit| digit.is_ascii_digit())).map_or(authority, |(host, _)| host);
    ["localhost", "127.0.0.1", "[::1]"].contains(&host) || app_origins.iter().any(|app| app == origin)
}

/// Whether a page showing `url` is an empty tab another URL may take over.
fn is_blank(url: &str) -> bool {
    url.is_empty() || url == "about:blank" || url.starts_with("chrome://newtab")
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

/// Runs the CDP connection of a Chrome: attaches to its pages, hands the annotations of their widget with the screenshots
/// of their elements to `hooks`, answers the widget's questions for the sessions from it and carries out `controls`. An annotation whose screenshot does not arrive within
/// `SCREENSHOT_TIMEOUT`, or is still on its way when the connection drops, goes without one. Once the connection drops
/// (the Chrome closed or quit), the Chrome ends like a close, unless a close or a newer Chrome took its slot meanwhile.
async fn run_cdp<Stream>(
    stream: tokio_tungstenite::WebSocketStream<Stream>,
    mut controls: UnboundedReceiver<Control>,
    hooks: ReviewHooks,
    watch: Watch,
    urls: Vec<String>,
) where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut source) = stream.split();
    let report = |reported: Reported| (hooks.on_annotation)(reported.annotation, reported.screenshot, reported.delivery);
    let mut cdp = Cdp::showing(&urls);
    let mut outgoing = cdp.start();
    'connection: loop {
        for text in outgoing.drain(..) {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break 'connection;
            }
        }
        let deadline = cdp.next_deadline().map(tokio::time::Instant::from_std);
        tokio::select! {
            message = source.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let handled = cdp.handle(text.as_str());
                    outgoing = handled.outgoing;
                    if !handled.session_requests.is_empty() {
                        let sessions = (hooks.sessions)();
                        outgoing.extend(handled.session_requests.iter().map(|session_id| cdp.answer_sessions(session_id, &sessions)));
                    }
                    for annotation in handled.annotations {
                        match annotation {
                            Ok(reported) => report(reported),
                            Err(error) => eprintln!("dropping an annotation of the browser: {error}"),
                        }
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
            control = controls.recv() => match control {
                Some(control) => outgoing = cdp.control(control),
                None => break,
            },
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() => {
                cdp.expire(Instant::now()).into_iter().for_each(report);
            }
        }
    }
    cdp.release(|_| true).into_iter().for_each(report);
    drop(controls);
    let mut running = watch.slot.lock().await;
    if let Some(browser) = running.take_if(|browser| browser.generation == watch.generation) {
        browser.end(&watch.profiles, false).await;
    }
}

/// The CDP state of a Chrome's connection: the message IDs, the pages, the origins of the session's apps and the
/// annotations whose screenshot is on its way. Turns what Chrome sends into what Hunt answers, without doing I/O.
#[derive(Default)]
struct Cdp {
    next_id: u64,
    /// The pages of the Chrome, in the order they appeared.
    pages: Vec<Page>,
    /// The origins of the session's apps that are not on this Mac: the preview hosts of a remote session.
    app_origins: Vec<String>,
    /// The annotations whose screenshot is on its way, by the ID of the command whose answer each waits for.
    pending: HashMap<u64, Pending>,
}

/// A page of the Chrome: its target, the URL it shows and how far Hunt is attached to it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Page {
    target_id: String,
    url: String,
    attachment: Attachment,
}

/// Whether Hunt is attached to a page. It is to the pages of the session's apps only (`is_app_page`): an attached
/// debugger gets in the way of other pages, such as a sign-in with a passkey.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Attachment {
    Detached,
    /// `Target.attachToTarget` is on its way.
    Attaching,
    /// Attached with this CDP session.
    Attached(String),
}

/// An annotation the review widget reported, with the PNG of the picked element, `None` when it could not be captured,
/// and where the widget wants it.
#[derive(Debug)]
struct Reported {
    annotation: Annotation,
    screenshot: Option<Vec<u8>>,
    delivery: Delivery,
}

/// An annotation whose screenshot is on its way: the CDP session of the page it came from, the step of the capture whose
/// answer it waits for and when it goes without a screenshot.
#[derive(Debug)]
struct Pending {
    annotation: Annotation,
    delivery: Delivery,
    session_id: String,
    step: Capture,
    deadline: Instant,
}

/// The steps of capturing the screenshot of an annotation's element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Capture {
    /// `Page.getLayoutMetrics`, for where the viewport is in the page.
    Metrics,
    /// `Page.captureScreenshot` of the element.
    Screenshot,
}

impl Pending {
    fn without_screenshot(self) -> Reported {
        Reported { annotation: self.annotation, screenshot: None, delivery: self.delivery }
    }
}

/// What `Cdp::handle` makes of a message of Chrome.
#[derive(Debug, Default)]
struct Handled {
    /// The messages to send to Chrome, in order.
    outgoing: Vec<String>,
    /// The annotations of the review widget that are complete, or why one is dropped.
    annotations: Vec<Result<Reported, String>>,
    /// The CDP sessions of the pages whose widget asked for the sessions an annotation can go to.
    session_requests: Vec<String>,
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

    /// A command to `method` with `params` to the page of `pending`, whose answer takes `pending` further.
    /// The command that answers the widget on the page of `session_id` with `sessions`, through its callback.
    fn answer_sessions(&mut self, session_id: &str, sessions: &ReviewSessions) -> String {
        let expression = format!("globalThis.{SESSIONS_CALLBACK}?.({})", json!(sessions));
        self.command("Runtime.evaluate", json!({ "expression": expression }), Some(session_id))
    }

    fn await_reply(&mut self, method: &str, params: Value, pending: Pending) -> String {
        let command = self.command(method, params, Some(&pending.session_id));
        self.pending.insert(self.next_id, pending);
        command
    }

    /// When the next annotation goes without its screenshot.
    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|pending| pending.deadline).min()
    }

    /// The annotations whose screenshot did not arrive by `now`, without one.
    fn expire(&mut self, now: Instant) -> Vec<Reported> {
        self.release(|pending| pending.deadline <= now)
    }

    /// The annotations `is_released` picks, without their screenshot, in the order they were reported.
    fn release(&mut self, is_released: impl Fn(&Pending) -> bool) -> Vec<Reported> {
        let mut ids: Vec<u64> = self.pending.iter().filter(|(_, pending)| is_released(pending)).map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.into_iter().filter_map(|id| self.pending.remove(&id)).map(Pending::without_screenshot).collect()
    }

    /// Takes the screenshot of `pending` a step further with `reply`, Chrome's answer to the command it waited for: the
    /// layout metrics give the clip, the screenshot the PNG. An error, an answer it cannot read or an element outside the
    /// viewport reports the annotation without a screenshot.
    fn advance(&mut self, pending: Pending, reply: &Value, handled: &mut Handled) {
        if let Some(error) = reply.get("error") {
            eprintln!("capturing the screenshot of an annotation failed: {error}");
            handled.annotations.push(Ok(pending.without_screenshot()));
            return;
        }
        let result = &reply["result"];
        match pending.step {
            Capture::Metrics => match screenshot_clip(&pending.annotation.rect, &result["cssVisualViewport"]) {
                Some(clip) => {
                    let params = json!({ "format": "png", "clip": clip, "captureBeyondViewport": false });
                    let next = Pending { step: Capture::Screenshot, ..pending };
                    handled.outgoing.push(self.await_reply("Page.captureScreenshot", params, next));
                }
                None => handled.annotations.push(Ok(pending.without_screenshot())),
            },
            Capture::Screenshot => {
                let data = result["data"].as_str().map(|data| base64::engine::general_purpose::STANDARD.decode(data));
                let screenshot = match data {
                    Some(Ok(bytes)) => Some(bytes),
                    Some(Err(error)) => {
                        eprintln!("failed to read the screenshot of an annotation: {error}");
                        None
                    }
                    None => None,
                };
                handled.annotations.push(Ok(Reported { annotation: pending.annotation, screenshot, delivery: pending.delivery }));
            }
        }
    }

    /// The state of a Chrome that shows the apps at `urls`.
    fn showing(urls: &[String]) -> Self {
        let mut cdp = Cdp::default();
        cdp.add_apps(urls);
        cdp
    }

    /// Takes the origins of `urls` as origins of the session's apps.
    fn add_apps(&mut self, urls: &[String]) {
        for app in urls.iter().filter_map(|url| origin(url)) {
            if !self.app_origins.iter().any(|known| known == app) {
                self.app_origins.push(app.to_string());
            }
        }
    }

    /// The first command: report every target and its URL changes. Hunt attaches by itself to the pages of the
    /// session's apps; an auto-attach would pause and instrument every page, extension window and worker.
    fn start(&mut self) -> Vec<String> {
        vec![self.command("Target.setDiscoverTargets", json!({ "discover": true }), None)]
    }

    /// The commands that bring the attachment of the page `target_id` in line with the URL it shows: attach to a page
    /// of an app, detach from any other.
    fn follow(&mut self, target_id: &str) -> Vec<String> {
        let Some(index) = self.pages.iter().position(|page| page.target_id == target_id) else { return Vec::new() };
        let is_app = is_app_page(&self.pages[index].url, &self.app_origins);
        match (&self.pages[index].attachment, is_app) {
            (Attachment::Detached, true) => {
                self.pages[index].attachment = Attachment::Attaching;
                vec![self.command("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None)]
            }
            (Attachment::Attached(session_id), false) => {
                let session_id = session_id.clone();
                vec![self.command("Target.detachFromTarget", json!({ "sessionId": session_id }), None)]
            }
            _ => Vec::new(),
        }
    }

    /// The commands that carry out `control`. `Show` takes the URLs as apps of the session and opens each whose origin
    /// no page shows in a new tab, which replaces an empty one; with none missing, it brings the last page to the front,
    /// or opens a window without any.
    fn control(&mut self, control: Control) -> Vec<String> {
        match control {
            Control::Show(urls) => {
                self.add_apps(&urls);
                let missing: Vec<String> =
                    urls.into_iter().filter(|url| !self.pages.iter().any(|page| origin(&page.url).is_some_and(|shown| Some(shown) == origin(url)))).collect();
                if missing.is_empty() {
                    let command = match self.pages.last().map(|page| page.target_id.clone()) {
                        Some(target_id) => self.command("Target.activateTarget", json!({ "targetId": target_id }), None),
                        None => self.command("Target.createTarget", json!({ "url": "about:blank", "newWindow": true }), None),
                    };
                    return vec![command];
                }
                let mut blank_pages: std::vec::IntoIter<String> =
                    self.pages.iter().filter(|page| is_blank(&page.url)).map(|page| page.target_id.clone()).collect::<Vec<_>>().into_iter();
                let mut outgoing = Vec::new();
                for url in missing {
                    outgoing.push(self.command("Target.createTarget", json!({ "url": url }), None));
                    if let Some(target_id) = blank_pages.next() {
                        outgoing.push(self.command("Target.closeTarget", json!({ "targetId": target_id }), None));
                    }
                }
                outgoing
            }
        }
    }

    /// What follows from the message `text` of Chrome: Hunt attaches to a page that shows an app of the session and
    /// detaches once it shows something else; an attached page gets the binding and the widget, for the document it
    /// shows and the ones that follow (Chrome runs the scripts for new documents and installs the binding only while
    /// the page's Page and Runtime domains are enabled); a binding call of the widget asks for the sessions or is an
    /// annotation, whose element is captured before it is reported, unless its page goes; a failed command is logged.
    fn handle(&mut self, text: &str) -> Handled {
        let mut handled = Handled::default();
        let Ok(message) = serde_json::from_str::<Value>(text) else { return handled };
        if let Some(pending) = message["id"].as_u64().and_then(|id| self.pending.remove(&id)) {
            self.advance(pending, &message, &mut handled);
            return handled;
        }
        if let Some(error) = message.get("error") {
            eprintln!("a CDP command of the browser failed: {error}");
            return handled;
        }
        let params = &message["params"];
        match message["method"].as_str() {
            Some("Target.targetCreated") | Some("Target.targetInfoChanged") => {
                let info = &params["targetInfo"];
                let (Some(target_id), Some("page")) = (info["targetId"].as_str(), info["type"].as_str()) else { return handled };
                let url = info["url"].as_str().unwrap_or_default().to_string();
                match self.pages.iter_mut().find(|page| page.target_id == target_id) {
                    Some(page) => page.url = url,
                    None => self.pages.push(Page { target_id: target_id.to_string(), url, attachment: Attachment::Detached }),
                }
                handled.outgoing = self.follow(target_id);
            }
            Some("Target.targetDestroyed") => {
                if let Some(target_id) = params["targetId"].as_str() {
                    self.pages.retain(|page| page.target_id != target_id);
                }
            }
            Some("Target.attachedToTarget") => {
                let (Some(session_id), Some(target_id)) = (params["sessionId"].as_str(), params["targetInfo"]["targetId"].as_str()) else { return handled };
                let Some(page) = self.pages.iter_mut().find(|page| page.target_id == target_id) else { return handled };
                page.attachment = Attachment::Attached(session_id.to_string());
                // The page may have left the app while the attach was on its way.
                handled.outgoing = self.follow(target_id);
                if handled.outgoing.is_empty() {
                    handled.outgoing.push(self.command("Page.enable", json!({}), Some(session_id)));
                    handled.outgoing.push(self.command("Runtime.enable", json!({}), Some(session_id)));
                    handled.outgoing.push(self.command("Runtime.addBinding", json!({ "name": BINDING }), Some(session_id)));
                    handled.outgoing.push(self.command("Page.addScriptToEvaluateOnNewDocument", json!({ "source": WIDGET }), Some(session_id)));
                    handled.outgoing.push(self.command("Runtime.evaluate", json!({ "expression": WIDGET }), Some(session_id)));
                }
            }
            Some("Target.detachedFromTarget") => {
                if let Some(session_id) = params["sessionId"].as_str() {
                    let detached = self.pages.iter_mut().find(|page| page.attachment == Attachment::Attached(session_id.to_string()));
                    if let Some(page) = detached {
                        page.attachment = Attachment::Detached;
                        let target_id = page.target_id.clone();
                        // It may show an app again by now.
                        handled.outgoing = self.follow(&target_id);
                    }
                    handled.annotations.extend(self.release(|pending| pending.session_id == session_id).into_iter().map(Ok));
                }
            }
            Some("Runtime.bindingCalled") if params["name"].as_str() == Some(BINDING) => {
                let payload = params["payload"].as_str().unwrap_or_default();
                if payload == SESSIONS_REQUEST {
                    handled.session_requests.extend(message["sessionId"].as_str().map(str::to_string));
                    return handled;
                }
                match (parse_annotation(payload, Uuid::new_v4(), chrono::Utc::now().timestamp_millis()), message["sessionId"].as_str()) {
                    (Ok((annotation, delivery)), Some(session_id)) => {
                        let deadline = Instant::now() + SCREENSHOT_TIMEOUT;
                        let pending = Pending { annotation, delivery, session_id: session_id.to_string(), step: Capture::Metrics, deadline };
                        handled.outgoing.push(self.await_reply("Page.getLayoutMetrics", json!({}), pending));
                    }
                    (Ok((annotation, delivery)), None) => handled.annotations.push(Ok(Reported { annotation, screenshot: None, delivery })),
                    (Err(error), _) => handled.annotations.push(Err(error)),
                }
            }
            _ => {}
        }
        handled
    }
}

/// The clip of the screenshot of the element at `rect` (CSS pixels of the viewport) on a page whose visual viewport is
/// `viewport` (`cssVisualViewport` of `Page.getLayoutMetrics`): the element in page coordinates with `SCREENSHOT_PADDING`
/// on each side, cut to what the viewport shows; `None` when nothing of it shows or `viewport` cannot be read.
fn screenshot_clip(rect: &AnnotationRect, viewport: &Value) -> Option<Value> {
    let [page_x, page_y, width, height] = ["pageX", "pageY", "clientWidth", "clientHeight"].map(|field| viewport[field].as_f64());
    let (page_x, page_y, width, height) = (page_x?, page_y?, width?, height?);
    let left = (page_x + rect.x - SCREENSHOT_PADDING).max(page_x);
    let top = (page_y + rect.y - SCREENSHOT_PADDING).max(page_y);
    let right = (page_x + rect.x + rect.width + SCREENSHOT_PADDING).min(page_x + width);
    let bottom = (page_y + rect.y + rect.height + SCREENSHOT_PADDING).min(page_y + height);
    (right > left && bottom > top).then(|| json!({ "x": left, "y": top, "width": right - left, "height": bottom - top, "scale": 1 }))
}

/// The longest value of each text field of an annotation, in UTF-16 code units (mirror of `ANNOTATION_LIMITS` in
/// `libs/domain/src/review/browser-annotation.utils.ts`).
mod limits {
    pub const URL: usize = 2048;
    pub const TITLE: usize = 512;
    pub const SELECTOR: usize = 1024;
    pub const TEXT: usize = 1000;
    pub const OUTER_HTML: usize = 4000;
    pub const COMMENT: usize = 4000;
    pub const SOURCE_FILE: usize = 512;
    pub const COMPONENT_NAME: usize = 256;
    pub const STYLE_COUNT: usize = 32;
    pub const STYLE_NAME: usize = 64;
    pub const STYLE_VALUE: usize = 256;
    pub const LINE_NUMBER: u32 = 10_000_000;
}

/// The annotation the widget sent as `payload` (a `BrowserAnnotation` as JSON), with the ID `id` and the time
/// `created_at` (Unix ms), checked like `parseBrowserAnnotation` in `libs/domain/src/review/browser-annotation.utils.ts`
/// does, and where the widget wants it (its `delivery`; the default without one).
fn parse_annotation(payload: &str, id: Uuid, created_at: i64) -> Result<(Annotation, Delivery), String> {
    let mut value: Value = serde_json::from_str(payload).map_err(|error| format!("failed to read the annotation: {error}"))?;
    let fields = value.as_object_mut().ok_or("failed to read the annotation: it is no object")?;
    let delivery = match fields.remove("delivery") {
        Some(delivery) => serde_json::from_value(delivery).map_err(|error| format!("failed to read the delivery of the annotation: {error}"))?,
        None => Delivery::default(),
    };
    fields.insert("id".into(), json!(id.to_string()));
    fields.insert("createdAt".into(), json!(created_at));
    let annotation: Annotation = serde_json::from_value(value).map_err(|error| format!("failed to read the annotation: {error}"))?;
    check_annotation(&annotation).map_err(|problem| format!("failed to read the annotation: {problem}"))?;
    Ok((annotation, delivery))
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
    if let Some(component) = &annotation.component {
        let is_name = |value: &str| !value.trim().is_empty() && utf16_length(value) <= limits::COMPONENT_NAME;
        if !is_name(&component.name) || !is_name(&component.tag) {
            return Err(format!("component must hold a name and a tag of at most {} characters", limits::COMPONENT_NAME));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const PAYLOAD: &str = concat!(
        r#"{"url":"https://app.example/cart","title":"Cart","selector":"main > button.buy","text":"Buy","#,
        r#""outerHtml":"<button class=\"buy\">Buy</button>","rect":{"x":10,"y":20.5,"width":80,"height":32},"#,
        r#""viewport":{"width":1280,"height":800},"styles":{"color":"rgb(0, 0, 0)","-webkit-appearance":"none"},"#,
        r#""source":{"file":"src/Cart.tsx","line":12,"column":5},"component":{"name":"CartComponent","tag":"app-cart"},"#,
        r#""comment":"Make it blue"}"#,
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
    fn a_profile_copy_keeps_the_service_workers_and_drops_those_saved_without_their_scripts() {
        let root = tempfile::tempdir().unwrap();
        let profile = Profile::of(root.path(), Path::new("/repo"), Uuid::new_v4());
        let workers = |profile_name: &str| profile.repository.join(profile_name).join("Service Worker");
        for folder in ["Database", "ScriptCache", "CacheStorage"] {
            std::fs::create_dir_all(workers("Default").join(folder)).unwrap();
        }
        std::fs::create_dir_all(workers("Profile 1").join("Database")).unwrap();
        std::fs::write(profile.repository.join("Local State"), "{}").unwrap();
        profile.prepare().unwrap();
        let copied = |profile_name: &str| profile.session.join(profile_name).join("Service Worker");
        for folder in ["Database", "ScriptCache", "CacheStorage"] {
            assert!(copied("Default").join(folder).is_dir(), "{folder}");
        }
        assert!(!copied("Profile 1").exists(), "workers without their scripts are left");
        profile.restore().unwrap();
        assert!(workers("Default").join("ScriptCache").is_dir(), "the saved profile lost the scripts");
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
    fn the_chromes_on_a_profile_are_its_main_processes() {
        let profile = Path::new("/data/Application Support/browser/sessions/aa22");
        let processes = format!(
            "  101     1 {CHROME} --user-data-dir=/data/Application Support/browser/sessions/aa22 --remote-debugging-port=1 about:blank\n\
             102   101 {CHROME} Helper --type=renderer --user-data-dir=/data/Application Support/browser/sessions/aa22 --lang=en\n\
             103     1 {CHROME} --user-data-dir=/data/Application Support/browser/sessions/aa223 --remote-debugging-port=2\n\
             104    77 {CHROME} --user-data-dir=/data/Application Support/browser/sessions/aa22\n\
             105     1 /bin/zsh -c echo {CHROME} --user-data-dir=/data/Application Support/browser/sessions/aa22 \n"
        );
        assert_eq!(chromes_using(&processes, profile), vec![ChromeProcess { pid: 101, parent: 1 }, ChromeProcess { pid: 104, parent: 77 }]);
    }

    #[test]
    fn chrome_gets_its_own_profile_and_port() {
        let args = chrome_args(Path::new("/data/browser/sessions/abc"), 9333, &[]);
        assert_eq!(args[0], "--user-data-dir=/data/browser/sessions/abc");
        assert_eq!(args[1], "--remote-debugging-port=9333");
        assert!(args.contains(&"--no-first-run".to_string()));
        assert_eq!(args.last().unwrap(), "about:blank");
    }

    #[test]
    fn chrome_opens_a_tab_per_url_instead_of_a_blank_one() {
        let urls = ["http://localhost:4200".to_string(), "http://localhost:4300".to_string()];
        let args = chrome_args(Path::new("/data/browser/sessions/abc"), 9333, &urls);
        assert_eq!(args[args.len() - 2..], urls);
        assert!(!args.contains(&"about:blank".to_string()));
    }

    #[test]
    fn origin_is_scheme_host_and_port() {
        assert_eq!(origin("http://localhost:4200/patients?id=1"), Some("http://localhost:4200"));
        assert_eq!(origin("http://localhost:4200"), Some("http://localhost:4200"));
        assert_eq!(origin("https://app.example#top"), Some("https://app.example"));
        assert_eq!(origin("about:blank"), None);
        assert_eq!(origin("file:///tmp/a.html"), None);
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
    fn the_connection_starts_by_discovering_the_targets_without_attaching_to_all() {
        let mut cdp = Cdp::default();
        let start: Vec<Value> = cdp.start().iter().map(|text| parsed(text)).collect();
        assert_eq!(start.len(), 1);
        assert_eq!(start[0]["method"], "Target.setDiscoverTargets");
        assert_eq!(start[0]["params"], json!({ "discover": true }));
        assert!(start[0].get("sessionId").is_none());
    }

    /// What Hunt sends when Chrome reports `event` for the target `target` of `kind` showing `url`, as method names.
    fn target_event(cdp: &mut Cdp, event: &str, target: &str, kind: &str, url: &str) -> Vec<Value> {
        let message = json!({ "method": format!("Target.{event}"), "params": { "targetInfo": { "targetId": target, "type": kind, "url": url } } });
        cdp.handle(&message.to_string()).outgoing.iter().map(|text| parsed(text)).collect()
    }

    fn attached(cdp: &mut Cdp, session: &str, target: &str) -> Vec<Value> {
        let message = json!({ "method": "Target.attachedToTarget", "params": { "sessionId": session, "targetInfo": { "targetId": target, "type": "page" } } });
        cdp.handle(&message.to_string()).outgoing.iter().map(|text| parsed(text)).collect()
    }

    fn methods(commands: &[Value]) -> Vec<&str> {
        commands.iter().map(|command| command["method"].as_str().unwrap()).collect()
    }

    /// A page of an app that Hunt is attached to.
    fn attach_page(cdp: &mut Cdp, session: &str, target: &str, url: &str) {
        target_event(cdp, "targetCreated", target, "page", url);
        attached(cdp, session, target);
    }

    #[test]
    fn a_page_of_an_app_is_attached_and_gets_the_binding_and_the_widget() {
        let mut cdp = Cdp::default();
        let outgoing = target_event(&mut cdp, "targetCreated", "T1", "page", "http://localhost:4200/cart");
        assert_eq!(methods(&outgoing), ["Target.attachToTarget"]);
        assert_eq!(outgoing[0]["params"], json!({ "targetId": "T1", "flatten": true }));
        assert_eq!(cdp.pages[0].attachment, Attachment::Attaching);
        assert!(target_event(&mut cdp, "targetInfoChanged", "T1", "page", "http://localhost:4200/login").is_empty(), "attaches once");

        let outgoing = attached(&mut cdp, "S1", "T1");
        assert_eq!(methods(&outgoing), ["Page.enable", "Runtime.enable", "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
        assert!(outgoing.iter().all(|command| command["sessionId"] == "S1"));
        assert_eq!(outgoing[2]["params"]["name"], BINDING);
        assert_eq!(outgoing[3]["params"]["source"], WIDGET);
        assert_eq!(cdp.pages, [Page { target_id: "T1".into(), url: "http://localhost:4200/login".into(), attachment: Attachment::Attached("S1".into()) }]);
    }

    #[test]
    fn any_other_page_or_target_stays_untouched() {
        let mut cdp = Cdp::default();
        for (kind, url) in [
            ("page", "https://accounts.google.com/v3/signin"),
            ("page", "chrome-extension://abc/popup/index.html"),
            ("page", "chrome://settings/"),
            ("page", "about:blank"),
            ("service_worker", "http://localhost:4200/worker.js"),
            ("iframe", "http://localhost:4200/frame"),
        ] {
            assert!(target_event(&mut cdp, "targetCreated", url, kind, url).is_empty(), "{kind} {url}");
        }
        assert_eq!(cdp.pages.len(), 4);
    }

    #[test]
    fn a_page_is_detached_while_it_shows_something_else_such_as_a_sign_in() {
        let preview = "https://aa22-4203.hunt.example".to_string();
        let mut cdp = Cdp::showing(&[format!("{preview}/")]);
        assert_eq!(methods(&target_event(&mut cdp, "targetCreated", "T1", "page", &preview)), ["Target.attachToTarget"]);
        attached(&mut cdp, "S1", "T1");

        let outgoing = target_event(&mut cdp, "targetInfoChanged", "T1", "page", "https://accounts.google.com/v3/signin");
        assert_eq!(methods(&outgoing), ["Target.detachFromTarget"]);
        assert_eq!(outgoing[0]["params"]["sessionId"], "S1");
        assert!(cdp.handle(r#"{"method":"Target.detachedFromTarget","params":{"sessionId":"S1"}}"#).outgoing.is_empty());
        assert_eq!(cdp.pages[0].attachment, Attachment::Detached);

        let back = target_event(&mut cdp, "targetInfoChanged", "T1", "page", &format!("{preview}/de-de"));
        assert_eq!(methods(&back), ["Target.attachToTarget"]);
    }

    #[test]
    fn a_page_that_left_the_app_while_the_attach_was_on_its_way_is_detached_at_once() {
        let mut cdp = Cdp::default();
        target_event(&mut cdp, "targetCreated", "T1", "page", "http://localhost:4200/");
        target_event(&mut cdp, "targetInfoChanged", "T1", "page", "https://accounts.google.com/v3/signin");
        assert_eq!(methods(&attached(&mut cdp, "S1", "T1")), ["Target.detachFromTarget"]);
    }

    #[test]
    fn a_page_that_closed_is_forgotten() {
        let mut cdp = Cdp::default();
        attach_page(&mut cdp, "S1", "T1", "http://localhost:4200/");
        cdp.handle(r#"{"method":"Target.targetDestroyed","params":{"targetId":"T1"}}"#);
        assert!(cdp.pages.is_empty());
    }

    #[test]
    fn app_pages_are_local_ones_and_the_origins_hunt_opened() {
        let apps = ["https://aa22-4203.hunt.example".to_string()];
        for url in ["http://localhost:4200/x", "https://localhost/", "http://127.0.0.1:3000", "http://[::1]:8080/", "file:///tmp/a.html", "data:text/html,<p>", "https://aa22-4203.hunt.example/de"] {
            assert!(is_app_page(url, &apps), "{url}");
        }
        for url in ["https://accounts.google.com/", "https://aa22-4204.hunt.example/", "http://localhost.evil.example/", "chrome-extension://abc/popup.html", "chrome://newtab/", "about:blank", ""] {
            assert!(!is_app_page(url, &apps), "{url}");
        }
    }

    #[test]
    fn bring_to_front_shows_the_last_page_or_opens_a_window() {
        let mut cdp = Cdp::default();
        let front = |cdp: &mut Cdp| {
            let commands = cdp.control(Control::Show(Vec::new()));
            assert_eq!(commands.len(), 1);
            parsed(&commands[0])
        };
        assert_eq!(front(&mut cdp)["method"], "Target.createTarget");
        target_event(&mut cdp, "targetCreated", "T1", "page", "http://localhost:4200/");
        target_event(&mut cdp, "targetCreated", "T2", "page", "https://accounts.google.com/");
        let last = front(&mut cdp);
        assert_eq!(last["method"], "Target.activateTarget");
        assert_eq!(last["params"]["targetId"], "T2");
        cdp.handle(r#"{"method":"Target.targetDestroyed","params":{"targetId":"T2"}}"#);
        assert_eq!(front(&mut cdp)["params"]["targetId"], "T1");
    }

    #[test]
    fn show_opens_a_tab_for_each_app_no_page_shows_yet() {
        let mut cdp = Cdp::default();
        target_event(&mut cdp, "targetCreated", "T1", "page", "about:blank");
        attach_page(&mut cdp, "S2", "T2", "http://localhost:4200/login");
        let urls = ["http://localhost:4200", "https://aa22-4300.hunt.example", "https://aa22-4400.hunt.example"].map(String::from).to_vec();
        let commands: Vec<Value> = cdp.control(Control::Show(urls)).iter().map(|text| parsed(text)).collect();
        let summary: Vec<(&str, &str)> =
            commands.iter().map(|command| (command["method"].as_str().unwrap(), command["params"]["url"].as_str().or(command["params"]["targetId"].as_str()).unwrap())).collect();
        assert_eq!(
            summary,
            [
                ("Target.createTarget", "https://aa22-4300.hunt.example"),
                ("Target.closeTarget", "T1"),
                ("Target.createTarget", "https://aa22-4400.hunt.example"),
            ]
        );
        assert_eq!(methods(&target_event(&mut cdp, "targetCreated", "T3", "page", "https://aa22-4300.hunt.example/")), ["Target.attachToTarget"], "a shown URL is an app");
    }

    #[test]
    fn show_follows_the_url_a_page_navigated_to() {
        let mut cdp = Cdp::default();
        target_event(&mut cdp, "targetCreated", "T1", "page", "about:blank");
        target_event(&mut cdp, "targetInfoChanged", "T1", "page", "http://localhost:4200/");
        let commands = cdp.control(Control::Show(vec!["http://localhost:4200".into()]));
        assert_eq!(commands.len(), 1);
        assert_eq!(parsed(&commands[0])["method"], "Target.activateTarget");
    }

    /// The binding call of the widget with `PAYLOAD` on the page of `session_id`; without one, a call Chrome sends unflattened.
    fn binding_call(session_id: Option<&str>) -> String {
        let params = json!({ "name": BINDING, "payload": PAYLOAD, "executionContextId": 3 });
        let mut called = json!({ "method": "Runtime.bindingCalled", "params": params });
        if let Some(session_id) = session_id {
            called["sessionId"] = json!(session_id);
        }
        called.to_string()
    }

    /// The answer of Chrome to the single command `outgoing` holds, with `result`.
    fn reply(outgoing: &[String], result: Value) -> String {
        assert_eq!(outgoing.len(), 1);
        let command = parsed(&outgoing[0]);
        json!({ "id": command["id"], "sessionId": command["sessionId"], "result": result }).to_string()
    }

    /// The layout metrics of a page scrolled down by 1200 px, with a viewport of 1280×800.
    fn layout_metrics() -> Value {
        let viewport = json!({ "offsetX": 0, "offsetY": 0, "pageX": 0, "pageY": 1200, "clientWidth": 1280, "clientHeight": 800 });
        json!({ "cssVisualViewport": viewport, "cssContentSize": { "x": 0, "y": 0, "width": 1280, "height": 3000 } })
    }

    #[test]
    fn a_binding_call_of_the_widget_is_an_annotation_with_the_screenshot_of_its_element() {
        let mut cdp = Cdp::default();
        let called = cdp.handle(&binding_call(Some("S1")));
        assert!(called.annotations.is_empty());
        let metrics = parsed(&called.outgoing[0]);
        assert_eq!(metrics["method"], "Page.getLayoutMetrics");
        assert_eq!(metrics["sessionId"], "S1");

        let measured = cdp.handle(&reply(&called.outgoing, layout_metrics()));
        assert!(measured.annotations.is_empty());
        let capture = parsed(&measured.outgoing[0]);
        assert_eq!(capture["method"], "Page.captureScreenshot");
        assert_eq!(capture["sessionId"], "S1");
        let clip = json!({ "x": 2.0, "y": 1212.5, "width": 96.0, "height": 48.0, "scale": 1 });
        assert_eq!(capture["params"], json!({ "format": "png", "clip": clip, "captureBeyondViewport": false }));

        let png = b"\x89PNG\r\n\x1a\nimage".to_vec();
        let data = base64::engine::general_purpose::STANDARD.encode(&png);
        let mut captured = cdp.handle(&reply(&measured.outgoing, json!({ "data": data })));
        assert!(captured.outgoing.is_empty());
        let reported = captured.annotations.pop().unwrap().unwrap();
        assert!(captured.annotations.is_empty());
        assert_eq!(reported.screenshot, Some(png));
        assert_eq!(reported.annotation.comment, "Make it blue");
        assert!(Uuid::parse_str(&reported.annotation.id).is_ok());
        assert!(reported.annotation.created_at > 0);
        assert!(cdp.pending.is_empty());
        assert_eq!(cdp.next_deadline(), None);
    }

    #[test]
    fn a_failed_capture_reports_the_annotation_without_a_screenshot() {
        let mut cdp = Cdp::default();
        let called = cdp.handle(&binding_call(Some("S1")));
        assert!(cdp.handle(r#"{"id":999,"error":{"code":-32000,"message":"No target"}}"#).annotations.is_empty());
        let id = parsed(&called.outgoing[0])["id"].clone();
        let failed = cdp.handle(&json!({ "id": id, "sessionId": "S1", "error": { "code": -32000, "message": "No target" } }).to_string());
        assert!(failed.outgoing.is_empty());
        let reported = failed.annotations.into_iter().next().unwrap().unwrap();
        assert_eq!(reported.screenshot, None);
        assert_eq!(reported.annotation.comment, "Make it blue");

        let called = cdp.handle(&binding_call(Some("S1")));
        let measured = cdp.handle(&reply(&called.outgoing, layout_metrics()));
        let unreadable = cdp.handle(&reply(&measured.outgoing, json!({ "data": "not base64!" })));
        assert_eq!(unreadable.annotations.into_iter().next().unwrap().unwrap().screenshot, None);
        assert!(cdp.pending.is_empty());
    }

    #[test]
    fn an_element_outside_the_viewport_goes_without_a_screenshot() {
        let mut cdp = Cdp::default();
        let called = cdp.handle(&binding_call(Some("S1")));
        let mut metrics = layout_metrics();
        metrics["cssVisualViewport"]["clientWidth"] = json!(0);
        let measured = cdp.handle(&reply(&called.outgoing, metrics));
        assert!(measured.outgoing.is_empty());
        assert_eq!(measured.annotations.into_iter().next().unwrap().unwrap().screenshot, None);

        let called = cdp.handle(&binding_call(Some("S1")));
        let measured = cdp.handle(&reply(&called.outgoing, json!({})));
        assert!(measured.outgoing.is_empty());
        assert_eq!(measured.annotations.into_iter().next().unwrap().unwrap().screenshot, None);
    }

    #[test]
    fn the_clip_is_the_padded_element_cut_to_the_viewport() {
        let viewport = json!({ "pageX": 50, "pageY": 1200, "clientWidth": 1280, "clientHeight": 800 });
        let rect = |x: f64, y: f64, width: f64, height: f64| AnnotationRect { x, y, width, height };
        let clip = |rect: AnnotationRect| screenshot_clip(&rect, &viewport);
        let expected = |x: f64, y: f64, width: f64, height: f64| {
            Some(json!({ "x": x, "y": y, "width": width, "height": height, "scale": 1 }))
        };
        assert_eq!(clip(rect(100.0, 300.0, 80.0, 40.0)), expected(142.0, 1492.0, 96.0, 56.0));
        assert_eq!(clip(rect(-20.0, 2.0, 40.0, 30.0)), expected(50.0, 1200.0, 28.0, 40.0));
        assert_eq!(clip(rect(1250.0, 780.0, 100.0, 100.0)), expected(1292.0, 1972.0, 38.0, 28.0));
        assert_eq!(clip(rect(0.0, -100.0, 50.0, 50.0)), None);
        assert_eq!(clip(rect(1300.0, 10.0, 50.0, 50.0)), None);
        assert_eq!(screenshot_clip(&rect(0.0, 0.0, 10.0, 10.0), &json!({ "pageX": 0 })), None);
    }

    #[test]
    fn an_annotation_whose_page_goes_or_whose_screenshot_is_late_goes_without_one() {
        let mut cdp = Cdp::default();
        cdp.handle(&binding_call(Some("S1")));
        let called = cdp.handle(&binding_call(Some("S2")));
        let detached = cdp.handle(r#"{"method":"Target.detachedFromTarget","params":{"sessionId":"S1"}}"#);
        assert_eq!(detached.annotations.into_iter().map(|reported| reported.unwrap().screenshot).collect::<Vec<_>>(), [None]);
        assert_eq!(cdp.pending.len(), 1);

        let deadline = cdp.next_deadline().unwrap();
        assert!(deadline <= Instant::now() + SCREENSHOT_TIMEOUT);
        assert!(cdp.expire(deadline - Duration::from_millis(1)).is_empty());
        let late = cdp.expire(deadline);
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].screenshot, None);
        assert_eq!(cdp.next_deadline(), None);
        let answered_late = cdp.handle(&reply(&called.outgoing, layout_metrics()));
        assert!(answered_late.outgoing.is_empty() && answered_late.annotations.is_empty());
    }

    #[test]
    fn a_binding_call_without_a_page_session_or_another_binding_is_no_capture() {
        let mut cdp = Cdp::default();
        let handled = cdp.handle(&binding_call(None));
        assert!(handled.outgoing.is_empty());
        assert_eq!(handled.annotations.into_iter().next().unwrap().unwrap().screenshot, None);

        let params = json!({ "name": "somethingElse", "payload": PAYLOAD });
        let other = json!({ "method": "Runtime.bindingCalled", "sessionId": "S1", "params": params });
        let handled = cdp.handle(&other.to_string());
        assert!(handled.annotations.is_empty() && handled.outgoing.is_empty());
        let malformed = json!({ "method": "Runtime.bindingCalled", "sessionId": "S1", "params": { "name": BINDING, "payload": "[]" } });
        let handled = cdp.handle(&malformed.to_string());
        assert!(handled.outgoing.is_empty());
        assert!(handled.annotations.into_iter().next().unwrap().is_err());
        assert!(cdp.handle("not json").annotations.is_empty());
        assert!(cdp.pending.is_empty());
    }

    #[test]
    fn parse_annotation_adds_the_id_and_time() {
        let id = Uuid::new_v4();
        let (annotation, delivery) = parse_annotation(PAYLOAD, id, 1_760_000_000_000).unwrap();
        assert_eq!(delivery, Delivery::default());
        assert_eq!(annotation.id, id.to_string());
        assert_eq!(annotation.created_at, 1_760_000_000_000);
        assert_eq!(annotation.selector, "main > button.buy");
        assert_eq!(annotation.styles, BTreeMap::from([("color".into(), "rgb(0, 0, 0)".into()), ("-webkit-appearance".into(), "none".into())]));
        let payload = serde_json::to_value(&annotation).unwrap();
        assert_eq!(payload["createdAt"], 1_760_000_000_000_i64);
        assert_eq!(payload["source"], json!({ "file": "src/Cart.tsx", "line": 12, "column": 5 }));
        assert_eq!(payload["component"], json!({ "name": "CartComponent", "tag": "app-cart" }));
        assert!(payload.get("screenshotPath").is_none());
    }

    #[test]
    fn parse_annotation_reads_where_the_widget_wants_the_annotation() {
        let with_delivery = |delivery: Value| {
            let mut payload: Value = serde_json::from_str(PAYLOAD).unwrap();
            payload["delivery"] = delivery;
            parse_annotation(&payload.to_string(), Uuid::new_v4(), 0).map(|(_, delivery)| delivery)
        };
        let session_id = Uuid::new_v4();
        assert_eq!(
            with_delivery(json!({ "sessionId": session_id, "isNew": false, "sends": true })).unwrap(),
            Delivery { session_id: Some(session_id), is_new: false, sends: true }
        );
        assert_eq!(with_delivery(json!({ "isNew": true })).unwrap(), Delivery { session_id: None, is_new: true, sends: false });
        assert!(with_delivery(json!({ "sessionId": "not a session" })).unwrap_err().contains("delivery"));
        assert!(with_delivery(json!("sends")).is_err());
    }

    #[test]
    fn an_annotation_goes_to_the_listed_session_the_widget_names_else_to_the_chromes_own() {
        let [main, sub, stranger] = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let session = |id: Uuid, is_sub: bool| ReviewSession { id, title: "Cart".into(), is_sub };
        let sessions = ReviewSessions { sessions: vec![session(main, false), session(sub, true)], own: sub };
        let to = |session_id: Option<Uuid>, is_new: bool| sessions.target(&Delivery { session_id, is_new, sends: true });
        assert_eq!(to(None, false), (sub, false));
        assert_eq!(to(Some(main), false), (main, false));
        assert_eq!(to(Some(stranger), false), (sub, false));
        assert_eq!(to(Some(sub), true), (main, true));
        assert_eq!(ReviewSessions { sessions: Vec::new(), own: sub }.target(&Delivery { is_new: true, ..Delivery::default() }), (sub, true));
    }

    #[test]
    fn a_binding_call_for_the_sessions_is_answered_through_the_callback_of_its_page() {
        let mut cdp = Cdp::default();
        let params = json!({ "name": BINDING, "payload": SESSIONS_REQUEST });
        let asked = cdp.handle(&json!({ "method": "Runtime.bindingCalled", "sessionId": "S1", "params": params }).to_string());
        assert!(asked.outgoing.is_empty() && asked.annotations.is_empty());
        assert_eq!(asked.session_requests, ["S1"]);

        let own = Uuid::new_v4();
        let sessions = ReviewSessions { sessions: vec![ReviewSession { id: own, title: "Cart \"v2\"".into(), is_sub: false }], own };
        let answer = parsed(&cdp.answer_sessions("S1", &sessions));
        assert_eq!(answer["method"], "Runtime.evaluate");
        assert_eq!(answer["sessionId"], "S1");
        let expected = format!(r#"globalThis.__huntReviewSessions?.({{"sessions":[{{"id":"{own}","title":"Cart \"v2\"","isSub":false}}],"own":"{own}"}})"#);
        assert_eq!(answer["params"]["expression"], expected);
    }

    #[test]
    fn the_page_cannot_set_the_screenshot_path() {
        let mut payload: Value = serde_json::from_str(PAYLOAD).unwrap();
        payload["screenshotPath"] = json!("/Users/someone/.ssh/id_ed25519");
        let (annotation, _) = parse_annotation(&payload.to_string(), Uuid::new_v4(), 0).unwrap();
        assert_eq!(annotation.screenshot_path, None);
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
        let component = |name: &str, tag: &str| with("component", json!({ "name": name, "tag": tag }));
        assert!(component("CartComponent", "app-cart").is_ok());
        assert!(component(&"x".repeat(256), &"é".repeat(256)).is_ok());
        let problem = "component must hold a name and a tag of at most 256 characters";
        assert!(component("", "app-cart").unwrap_err().contains(problem));
        assert!(component("CartComponent", "  ").unwrap_err().contains(problem));
        assert!(component(&"x".repeat(257), "app-cart").unwrap_err().contains(problem));
        assert!(component("CartComponent", &"😀".repeat(129)).unwrap_err().contains(problem));
        assert!(with("component", json!({ "name": "CartComponent" })).is_err());
        let mut without_component: Value = serde_json::from_str(PAYLOAD).unwrap();
        without_component.as_object_mut().unwrap().remove("component");
        assert_eq!(parse_annotation(&without_component.to_string(), Uuid::new_v4(), 0).unwrap().0.component, None);
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

    /// Starts the real Google Chrome with a fresh repository profile, lets a page call the binding, checks the screenshot of
    /// an element of a scrolled page and closes it again: `cargo test browser::tests::real_chrome -- --ignored`.
    #[tokio::test]
    #[ignore = "starts Google Chrome"]
    async fn real_chrome_reports_annotations_and_keeps_its_profile() {
        let root = tempfile::tempdir().unwrap();
        let browser_dir = root.path().join("browser");
        let repo_path = root.path().join("repo");
        let registry = BrowserRegistry::default();
        let id = Uuid::new_v4();
        let (annotations, mut received) = unbounded_channel();
        let on_annotation: AnnotationSink = Arc::new(move |annotation, screenshot, _| {
            let _ = annotations.send((annotation, screenshot));
        });
        let hooks = ReviewHooks { on_annotation, sessions: Arc::new(move || ReviewSessions { sessions: Vec::new(), own: id }) };
        registry.open(id, &repo_path, &browser_dir, hooks.clone(), false, &[]).await.unwrap();
        registry.open(id, &repo_path, &browser_dir, hooks, true, &[]).await.unwrap();
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
        let (annotation, screenshot) = tokio::time::timeout(Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
        assert_eq!(annotation.comment, "Make it blue");
        assert_eq!(annotation.url, "https://app.example/cart");
        assert!(screenshot.is_some(), "the annotation came without a screenshot");
        println!("annotation from the real Chrome: {}", serde_json::to_string(&annotation).unwrap());

        let body = "margin:0;background:rgb(255,255,255)";
        let target = "position:absolute;left:100px;top:1500px;width:80px;height:40px;background:rgb(255,0,0)";
        let tall = format!("data:text/html,<body style='{body}'><div style='height:3000px'></div><div id=target style='{target}'></div>");
        call("Page.navigate", json!({ "url": tall }), Some(&page_session)).await;
        let has_target_and_binding = format!("!!document.getElementById('target') && typeof window.{BINDING} === 'function'");
        let is_ready = json!({ "expression": has_target_and_binding, "returnByValue": true });
        let mut has_target = false;
        for _ in 0..50 {
            if call("Runtime.evaluate", is_ready.clone(), Some(&page_session)).await["result"]["result"]["value"] == true {
                has_target = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(has_target, "the tall page never showed its target");
        let scroll = json!({
            "expression": "window.scrollTo(0, 1200); JSON.stringify(document.getElementById('target').getBoundingClientRect())",
            "returnByValue": true,
        });
        let scrolled = call("Runtime.evaluate", scroll, Some(&page_session)).await;
        let rect: Value = serde_json::from_str(scrolled["result"]["result"]["value"].as_str().unwrap()).unwrap();
        assert_eq!((&rect["x"], &rect["y"]), (&json!(100), &json!(300)), "the page did not scroll as expected");
        let mut payload: Value = serde_json::from_str(PAYLOAD).unwrap();
        payload["rect"] = json!({ "x": rect["x"], "y": rect["y"], "width": rect["width"], "height": rect["height"] });
        let expression = format!("window.{BINDING}({})", serde_json::to_string(&payload.to_string()).unwrap());
        call("Runtime.evaluate", json!({ "expression": expression }), Some(&page_session)).await;
        let (_, screenshot) = tokio::time::timeout(Duration::from_secs(5), received.recv()).await.unwrap().unwrap();
        let png = screenshot.expect("the annotation of the scrolled page came without a screenshot");
        // Chrome decodes the PNG on the page itself; `pixel` reads the colour at CSS pixels of the clip.
        let data_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
        let decode = format!(
            "new Promise((resolve, reject) => {{ const image = new Image(); image.onload = () => {{ \
             const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; \
             const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const ratio = devicePixelRatio; \
             const pixel = (x, y) => \
             context.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data[1] < 128 ? 'red' : 'white'; \
             resolve(JSON.stringify({{ width: image.width / ratio, height: image.height / ratio, \
             outside: [pixel(6.5, 28), pixel(89.5, 28), pixel(48, 6.5), pixel(48, 49.5)], \
             inside: [pixel(9.5, 28), pixel(86.5, 28), pixel(48, 9.5), pixel(48, 46.5)] }})); }}; \
             image.onerror = reject; image.src = {data_url:?}; }})"
        );
        let decode = json!({ "expression": decode, "awaitPromise": true, "returnByValue": true });
        let decoded = call("Runtime.evaluate", decode, Some(&page_session)).await;
        let clip: Value = serde_json::from_str(decoded["result"]["result"]["value"].as_str().unwrap()).unwrap();
        println!("screenshot of the scrolled page: {clip}");
        assert_eq!(clip["width"], 96);
        assert_eq!(clip["height"], 56);
        assert_eq!(clip["outside"], json!(["white", "white", "white", "white"]), "the padding shows the element");
        assert_eq!(clip["inside"], json!(["red", "red", "red", "red"]), "the clip misses the element");

        registry.close(id).await;
        let profile = Profile::of(&browser_dir, &repo_path, id);
        assert!(!profile.session.exists(), "the session's profile is left");
        assert!(profile.repository.join("Local State").is_file(), "the repository's profile lacks Chrome's state");
        assert!(browser_endpoint(port).await.is_err(), "the browser still answers");
        let entries: Vec<_> = std::fs::read_dir(&profile.repository).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        println!("repository profile after close: {entries:?}");
    }
}
