//! One ACP connection per Hunt session: spawns `claude-agent-acp` as a child process,
//! forwards every `session/update` to the UI as a Tauri event and routes permission
//! requests through the UI.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    ClientCapabilities, ConfigOptionUpdate, InitializeRequest, LoadSessionRequest, Meta,
    NewSessionRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionConfigOption, SessionId,
    SessionNotification, SessionUpdate,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    on_receive_notification, on_receive_request, AcpAgent, AcpAgentConfig, Agent, Client,
    ConnectionTo, Error, ErrorCode,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::accounts;
use crate::graph;
use crate::session::attribution;

const ACP_SCRIPT: &str = "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";

/// A running agent process bound to one Hunt session.
pub struct LiveSession {
    pub connection: ConnectionTo<Agent>,
    pub acp_session_id: SessionId,
    /// Every `session/update` received so far plus the user's own prompts, in order. The UI
    /// rebuilds the chat of a still-running session from it after a webview reload.
    pub history: Arc<Mutex<Vec<SessionNotification>>>,
    shutdown: Option<oneshot::Sender<()>>,
    finished: Option<oneshot::Receiver<()>>,
}

/// Cloned handles of a running session, for use after the registry lock is released.
pub struct LiveHandles {
    pub connection: ConnectionTo<Agent>,
    pub acp_session_id: SessionId,
    pub history: Arc<Mutex<Vec<SessionNotification>>>,
}

impl LiveSession {
    /// The handles of the session, cloned so a command can work with them outside the registry lock.
    pub fn handles(&self) -> LiveHandles {
        LiveHandles { connection: self.connection.clone(), acp_session_id: self.acp_session_id.clone(), history: self.history.clone() }
    }

    /// Ends the connection; the agent process is killed when the connection is dropped.
    /// Returns a receiver that resolves once the connection task has fully finished.
    pub fn shutdown(&mut self) -> Option<oneshot::Receiver<()>> {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        self.finished.take()
    }
}

/// Live sessions keyed by Hunt session ID, plus the IDs currently being connected
/// so a double "Resume" cannot spawn two agents.
#[derive(Default)]
pub struct SessionRegistry {
    pub live: tokio::sync::Mutex<HashMap<Uuid, LiveSession>>,
    connecting: tokio::sync::Mutex<HashSet<Uuid>>,
    start_ended: tokio::sync::Notify,
}

impl SessionRegistry {
    /// Claims the start of the agent of `id`; while another start of it runs, waits for that one to end. Returns
    /// `false` when the agent is live, so there is nothing to start. A claim is given back with `end_start`.
    pub async fn claim_start(&self, id: Uuid) -> bool {
        loop {
            // Registered before the check, so an `end_start` between the check and the wait is not missed.
            let ended = self.start_ended.notified();
            {
                // The start inserts its live session before it ends its claim, so under this lock one of both is seen.
                let mut connecting = self.connecting.lock().await;
                if self.live.lock().await.contains_key(&id) {
                    return false;
                }
                if connecting.insert(id) {
                    return true;
                }
            }
            ended.await;
        }
    }

    /// Ends the start of `id`'s agent, successful or not, and wakes the starts waiting for it.
    pub async fn end_start(&self, id: Uuid) {
        self.connecting.lock().await.remove(&id);
        self.start_ended.notify_waiters();
    }

    /// Shuts every session down and waits (bounded) until their agent processes are gone.
    pub async fn shutdown_all(&self) {
        let mut receivers = Vec::new();
        for (_, mut session) in self.live.lock().await.drain() {
            if let Some(receiver) = session.shutdown() {
                receivers.push(receiver);
            }
        }
        for receiver in receivers {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), receiver).await;
        }
    }
}

/// Pending permission requests waiting for an answer from the UI.
#[derive(Default)]
pub struct PermissionRegistry(pub Mutex<HashMap<Uuid, PendingPermission>>);

pub struct PendingPermission {
    pub hunt_session_id: Uuid,
    pub answer: oneshot::Sender<String>,
}

/// How Hunt reaches the agent: a `claude-agent-acp` process on this machine, or the relay of a session handed off to
/// a VM, reached by running `ssh` with `ssh_args` (see `remote::ssh::Ssh::stream_args`).
pub enum AgentTransport {
    Local,
    Remote { ssh_args: Vec<String> },
}

/// How the agent session is brought up: fresh, or loaded from Claude Code's transcript.
pub enum SessionStart {
    New { cwd: PathBuf },
    Load { cwd: PathBuf, acp_session_id: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    hunt_session_id: Uuid,
    notification: SessionNotification,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
    hunt_session_id: Uuid,
    request_id: Uuid,
    request: RequestPermissionRequest,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    hunt_session_id: Uuid,
    error: Option<String>,
}

/// What `connect` needs once the session is usable: its ID, its config options and the connection to talk to it.
type Ready = (SessionId, Vec<SessionConfigOption>, ConnectionTo<Agent>);

/// Delivers the ready result to `connect` exactly once. Both the session setup and the end of the connection
/// try to fire it; whichever comes first wins and later calls are ignored.
#[derive(Clone)]
struct ReadyHandoff(Arc<Mutex<Option<oneshot::Sender<Result<Ready, String>>>>>);

impl ReadyHandoff {
    fn new() -> (Self, oneshot::Receiver<Result<Ready, String>>) {
        let (sender, receiver) = oneshot::channel();
        (Self(Arc::new(Mutex::new(Some(sender)))), receiver)
    }

    /// Hands `result` to `connect`; a no-op once fired or when `connect` already gave up waiting.
    fn fire(&self, result: Result<Ready, String>) {
        if let Some(sender) = self.0.lock().unwrap().take() {
            let _ = sender.send(result);
        }
    }
}

/// Everything the background task of one agent process works with.
struct AgentTask {
    app: AppHandle,
    hunt_session_id: Uuid,
    /// The local worktree whose changes are attributed to this session; `None` for a remote session.
    worktree: Option<PathBuf>,
    history: Arc<Mutex<Vec<SessionNotification>>>,
    start: SessionStart,
    system_prompt: String,
    /// Whether a conversation the agent no longer has may be replaced by a new one; a relay never loses its session,
    /// so a remote session reports the error instead.
    may_start_over: bool,
    ready: ReadyHandoff,
    shutdown: oneshot::Receiver<()>,
    finished: oneshot::Sender<()>,
}

/// Records a notification in the session's history and forwards it to the UI.
pub fn publish_update(
    app: &AppHandle,
    hunt_session_id: Uuid,
    history: &Mutex<Vec<SessionNotification>>,
    notification: SessionNotification,
) {
    history.lock().unwrap().push(notification.clone());
    let _ = app.emit("acp:update", UpdateEvent { hunt_session_id, notification });
}

/// Spawns the agent (or the SSH stream to its relay), initializes the protocol and creates or loads the session.
/// Resolves once the session is usable; the connection keeps running in the background.
pub async fn connect(
    app: AppHandle,
    hunt_session_id: Uuid,
    start: SessionStart,
    context_prompt: Option<String>,
    transport: AgentTransport,
) -> Result<LiveSession, String> {
    let is_local = matches!(transport, AgentTransport::Local);
    let agent = match transport {
        AgentTransport::Local => {
            let script = bundled_script_path(&app, ACP_SCRIPT)?;
            let mut config = AcpAgentConfig::new("node").arg(script.to_string_lossy());
            if let Some(token) = accounts::active_token(&app).await? {
                config = config.env(accounts::TOKEN_ENV, token);
            }
            AcpAgent::new(config)
        }
        AgentTransport::Remote { ssh_args } => AcpAgent::new(AcpAgentConfig::new("ssh").args(ssh_args)),
    };

    let (ready, ready_receiver) = ReadyHandoff::new();
    let (shutdown_sender, shutdown_receiver) = oneshot::channel::<()>();
    let (finished_sender, finished_receiver) = oneshot::channel::<()>();

    let worktree = match &start {
        SessionStart::New { cwd } | SessionStart::Load { cwd, .. } => is_local.then(|| cwd.clone()),
    };
    let history: Arc<Mutex<Vec<SessionNotification>>> = Arc::default();
    let task = AgentTask {
        app: app.clone(),
        hunt_session_id,
        worktree,
        history: history.clone(),
        start,
        system_prompt: system_prompt_append(&app, context_prompt),
        may_start_over: is_local,
        ready,
        shutdown: shutdown_receiver,
        finished: finished_sender,
    };
    tauri::async_runtime::spawn(run_agent_task(agent, task));

    let (acp_session_id, config_options, connection) = ready_receiver
        .await
        .map_err(|_| "agent task ended before the session was ready".to_string())??;

    // The session response carries the model/effort/mode options; the UI consumes them like a live update.
    let options_update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(config_options));
    publish_update(&app, hunt_session_id, &history, SessionNotification::new(acp_session_id.clone(), options_update));

    Ok(LiveSession { connection, acp_session_id, history, shutdown: Some(shutdown_sender), finished: Some(finished_receiver) })
}

/// Runs the agent process until it exits or the session is shut down: forwards its notifications and permission
/// requests, hands the established session to `connect`, and announces the end to the registries and the UI.
async fn run_agent_task(agent: AcpAgent, task: AgentTask) {
    let AgentTask { app, hunt_session_id, worktree, history, start, system_prompt, may_start_over, ready, shutdown, finished } = task;
    let notify_app = app.clone();
    let permission_app = app.clone();
    let session_ready = ready.clone();

    let result = Client
        .builder()
        .name("hunt")
        .on_receive_notification(
            async move |mut notification: SessionNotification, _connection| {
                graph::hide_replayed_refresh(&mut notification);
                if let Some(worktree) = &worktree {
                    attribution::observe(&notify_app, hunt_session_id, worktree, &notification);
                }
                publish_update(&notify_app, hunt_session_id, &history, notification);
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, connection: ConnectionTo<Agent>| {
                // Handlers run on the dispatch loop; waiting for the UI here would stall every other message.
                let app = permission_app.clone();
                connection.spawn(async move {
                    let outcome = ask_permission(&app, hunt_session_id, request).await;
                    responder.respond(RequestPermissionResponse::new(outcome))
                })
            },
            on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            run_session(connection, start, system_prompt, may_start_over, session_ready, shutdown).await
        })
        .await;

    let error = result.err().map(|error| error.to_string());
    ready.fire(Err(match &error {
        Some(error) => format!("failed to start the agent session: {error}"),
        None => "agent exited before the session was ready".into(),
    }));
    forget_live_session(&app, hunt_session_id).await;
    let _ = app.emit("acp:closed", ClosedEvent { hunt_session_id, error });
    let _ = finished.send(());
}

/// Establishes the session on an open connection, hands it over through `ready` and then keeps the connection
/// alive until `shutdown` fires or the agent closes its side.
async fn run_session(
    connection: ConnectionTo<Agent>,
    start: SessionStart,
    system_prompt: String,
    may_start_over: bool,
    ready: ReadyHandoff,
    shutdown: oneshot::Receiver<()>,
) -> Result<(), Error> {
    // A failed setup is not fired here: it surfaces as the connection's result, which fires the handoff with it.
    let (acp_session_id, config_options) = establish(&connection, start, &system_prompt, may_start_over).await?;
    ready.fire(Ok((acp_session_id, config_options, connection.clone())));

    tokio::select! {
        _ = shutdown => {}
        _ = connection.incoming_closed() => {}
    }
    Ok(())
}

/// Removes a session whose agent process ended from the registries so it can be reopened.
async fn forget_live_session(app: &AppHandle, hunt_session_id: Uuid) {
    app.state::<SessionRegistry>().live.lock().await.remove(&hunt_session_id);
    app.state::<SessionRegistry>().end_start(hunt_session_id).await;
    crate::graph::unwatch(&app.state::<crate::graph::WatcherRegistry>(), hunt_session_id);
    attribution::forget_session(app, hunt_session_id);
    app.state::<PermissionRegistry>()
        .0
        .lock()
        .unwrap()
        .retain(|_, pending| pending.hunt_session_id != hunt_session_id);
}

/// Initializes the protocol and creates or loads the session; returns its ID and config options.
/// `system_prompt` is appended to the agent's own system prompt (see `system_prompt_append`).
/// With `may_start_over`, a conversation the agent no longer has (its transcript was cleaned up or never written) is
/// replaced by a new one, so the session stays usable; the caller stores the new ID.
async fn establish(
    connection: &ConnectionTo<Agent>,
    start: SessionStart,
    system_prompt: &str,
    may_start_over: bool,
) -> Result<(SessionId, Vec<SessionConfigOption>), Error> {
    let mut capability_meta = Meta::new();
    capability_meta.insert("terminal_output".into(), serde_json::Value::Bool(true));
    connection
        .send_request(
            InitializeRequest::new(ProtocolVersion::V1)
                .client_capabilities(ClientCapabilities::new().meta(capability_meta)),
        )
        .block_task()
        .await?;

    match start {
        SessionStart::New { cwd } => new_session(connection, cwd, system_prompt).await,
        SessionStart::Load { cwd, acp_session_id } => {
            let session_id = SessionId::new(acp_session_id);
            let request = LoadSessionRequest::new(session_id.clone(), cwd.clone())
                .meta(build_session_meta(system_prompt));
            match connection.send_request(request).block_task().await {
                Ok(response) => Ok((session_id, response.config_options.unwrap_or_default())),
                Err(error) if may_start_over && error.code == ErrorCode::ResourceNotFound => {
                    eprintln!("the agent no longer has the conversation {session_id}, starting a new one: {error}");
                    new_session(connection, cwd, system_prompt).await
                }
                Err(error) => Err(error),
            }
        }
    }
}

/// Creates a new session in `cwd` on the initialized connection; returns its ID and config options.
async fn new_session(
    connection: &ConnectionTo<Agent>,
    cwd: PathBuf,
    system_prompt: &str,
) -> Result<(SessionId, Vec<SessionConfigOption>), Error> {
    let response = connection
        .send_request(NewSessionRequest::new(cwd).meta(build_session_meta(system_prompt)))
        .block_task()
        .await?;
    Ok((response.session_id, response.config_options.unwrap_or_default()))
}

/// Asks the agent to offer recording an answer the user accepted as an ADR, skill, rule, agent or instruction.
const GUARDRAIL_OFFER_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/guardrail-offer.md"));

/// Everything Hunt appends to the agent's system prompt: the user's response-style prompt from the settings (if
/// not cleared), the guardrail offer, the diagram instructions in the user's AI language and the optional selection
/// context.
pub fn system_prompt_append(app: &AppHandle, context_prompt: Option<String>) -> String {
    let style = crate::preferences::system_prompt(app);
    let diagram = crate::graph::system_prompt(&crate::preferences::ai_language(app));
    let mut append = String::new();
    if !style.is_empty() {
        append.push_str(&style);
        append.push_str("\n\n");
    }
    append.push_str(GUARDRAIL_OFFER_PROMPT);
    append.push_str(&diagram);
    append.push_str(context_prompt.as_deref().unwrap_or_default());
    append
}

/// The `session/new` and `session/load` meta the adapter reads the system prompt addition from.
fn build_session_meta(system_prompt: &str) -> Meta {
    let mut meta = Meta::new();
    meta.insert("systemPrompt".into(), serde_json::json!({ "append": system_prompt }));
    meta
}

/// Forwards the permission request to the UI and waits for `answer_permission`.
/// A dropped sender (cancel, closed session) resolves to `Cancelled`.
async fn ask_permission(
    app: &AppHandle,
    hunt_session_id: Uuid,
    request: RequestPermissionRequest,
) -> RequestPermissionOutcome {
    let (answer, answer_receiver) = oneshot::channel::<String>();
    let request_id = Uuid::new_v4();
    app.state::<PermissionRegistry>()
        .0
        .lock()
        .unwrap()
        .insert(request_id, PendingPermission { hunt_session_id, answer });

    let emitted = app.emit("acp:permission", PermissionEvent { hunt_session_id, request_id, request });
    if emitted.is_err() {
        app.state::<PermissionRegistry>().0.lock().unwrap().remove(&request_id);
        return RequestPermissionOutcome::Cancelled;
    }

    match answer_receiver.await {
        Ok(option_id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
        Err(_) => RequestPermissionOutcome::Cancelled,
    }
}

/// Resolves a script shipped with the app by its repo-relative path (`tauri.conf.json` bundles it under the same
/// path): the copy next to the app in development, the bundled resource copy in a release build.
pub fn bundled_script_path(app: &AppHandle, script: &str) -> Result<PathBuf, String> {
    let development_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(script);
    if cfg!(debug_assertions) && development_path.exists() {
        return Ok(development_path);
    }

    let resource_path = app
        .path()
        .resolve(script, tauri::path::BaseDirectory::Resource)
        .map_err(|error| format!("failed to resolve the {script} resource: {error}"))?;
    if resource_path.exists() {
        return Ok(resource_path);
    }

    Err(format!("{script} is not installed at {}", resource_path.display()))
}
