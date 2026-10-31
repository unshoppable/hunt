//! The Tauri commands of the app, the backend surface the React UI talks to through `src/ipc/commands.ts`. `handler()`
//! serves all of them: the session commands, one file per concern below, and the thin commands domain modules own
//! themselves (`ide/lsp.rs`, `ide/documents.rs`, `platform/preferences.rs`, `agent/plan_usage.rs`, `agent/accounts.rs`,
//! `github/github_token.rs`). This module holds what several command files share: the session lookups that resolve the
//! UI's worktree paths (`session_file`), starting, connecting and stopping a session's agent, making a remote session a
//! local one again, the progress of remote operations and the gateway of the remote settings.

pub mod browser;
pub mod changes;
mod chat;
mod checks;
pub mod control;
mod git;
mod github;
mod graph;
mod ide;
mod remote;
mod sessions;
mod terminal;

use std::path::PathBuf;

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectOptions, SessionNotification, SessionUpdate,
    SetSessionModeRequest,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use browser::{close_browser, close_desktop};
use crate::agent::acp::{connect, AgentTransport, LiveHandles, PermissionRegistry, SessionRegistry, SessionStart};
use crate::agent::claude_config::claude_dir;
use crate::agent::{accounts, guardrail_skill, plan_usage};
use crate::github::github_token;
use crate::graph::WatcherRegistry;
use crate::ide::{documents, lsp};
use crate::platform::{cli_install, preferences};
use crate::remote::api::GatewayApi;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::{Progress, RemoteStep, RemoteTarget, Reporter, VmRef, VmSettings};
use crate::session::attribution;
use crate::session::dependencies::{self, DependencyRegistry, DependencyStatus, Install};
use crate::session::link;
use crate::session::related;
use crate::session::relay_watch;
use crate::session::store::{self, announce_sessions_changed, SelectionContext, SessionRecord, Workspace};
use crate::session::sync;
use crate::session::vm_cleanup::{delete_session_vm, preserve_and_delete_vm};
use crate::session::worktree_watch::{self, WorktreeWatchers};
use crate::terminal::tmux::LocalTmux;

/// Defines `handler()` and, for the test against `src/ipc/commands.ts`, `COMMAND_NAMES` from one list of
/// `module::command` paths, so that the names the test checks are the commands the handler serves.
macro_rules! command_handler {
    ($($module:ident::$command:ident),* $(,)?) => {
        /// The invoke handler of every Tauri command of the app.
        pub fn handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($module::$command),*]
        }

        /// The names the UI invokes the commands of `handler()` by.
        #[cfg(test)]
        const COMMAND_NAMES: &[&str] = &[$(stringify!($command)),*];
    };
}

command_handler![
    sessions::list_sessions,
    sessions::create_session,
    sessions::create_sub_session,
    sessions::rename_session,
    sessions::open_session,
    sessions::clear_session,
    sessions::prepare_dependencies,
    sessions::close_session,
    remote::preview_status,
    remote::list_session_vms,
    remote::list_remote_secrets,
    remote::set_remote_secret,
    remote::delete_remote_secret,
    remote::adopt_session_vms,
    remote::prepare_hand_off,
    remote::hand_off_session,
    remote::retrieve_session,
    remote::continue_locally,
    remote::remote_link,
    remote::set_remote_settings,
    remote::snooze_remote_cleanup,
    chat::send_prompt,
    chat::list_screenshots,
    chat::image_files,
    chat::session_history,
    chat::cancel_prompt,
    chat::set_session_mode,
    chat::set_session_config_option,
    chat::answer_permission,
    control::answer_control_command,
    chat::decline_guardrail,
    terminal::open_terminal,
    terminal::terminal_windows,
    terminal::open_shell_window,
    terminal::rerun_terminal_window,
    terminal::close_terminal_window,
    terminal::write_terminal,
    terminal::resize_terminal,
    terminal::close_terminal,
    terminal::open_worktree_in_terminal,
    browser::desktop_open,
    browser::browser_open,
    checks::checks_status,
    checks::run_check,
    checks::run_all_checks,
    checks::cancel_check,
    checks::cancel_all_checks,
    checks::check_output,
    changes::list_changed_files,
    changes::change_stats,
    changes::read_file_diff,
    changes::read_file_history,
    changes::write_file,
    changes::create_swf_skills,
    changes::move_path,
    changes::delete_path,
    changes::revert_file,
    changes::shelve_files,
    changes::list_shelves,
    changes::unshelve,
    changes::drop_shelf,
    changes::commit_files,
    changes::push_branch,
    changes::unpushed_commit_count,
    git::list_branches,
    git::current_branch,
    git::fetch_repo_branch,
    git::git_log,
    git::git_refs,
    git::git_commit,
    git::git_commit_file_diff,
    git::git_checkout,
    git::git_rebase,
    git::git_merge,
    git::git_reset,
    git::git_update_branch,
    git::git_pull_branch,
    git::git_force_pull_branch,
    git::git_push_local_branch,
    git::git_force_push_local_branch,
    git::git_rename_branch,
    git::set_push_target,
    git::git_delete_branch,
    git::git_delete_remote_branch,
    git::git_fetch_branch,
    git::git_fetch_origin,
    github::list_pull_requests,
    github::issue_title,
    github::github_viewer,
    github::view_pull_request,
    github::pull_request_state,
    github::list_review_threads,
    github::submit_pull_request_review,
    github::add_review_comment,
    github::update_review_comment,
    github::delete_review_comment,
    github::reply_to_review_thread,
    github::resolve_review_thread,
    ide::open_worktree_in_webstorm,
    ide::open_file_in_webstorm,
    ide::open_changed_files_diff_in_webstorm,
    ide::list_dir,
    ide::list_files,
    ide::list_deleted_files,
    ide::read_file,
    ide::format_with_prettier,
    ide::read_lint_rules,
    ide::search_word,
    ide::find_in_files,
    ide::replace_in_files,
    ide::resolve_imports,
    graph::refresh_graph,
    graph::read_graph,
    graph::write_graph,
    graph::graph_status,
    lsp::lsp_request,
    lsp::lsp_cancel,
    documents::document_open,
    documents::document_edit,
    documents::document_save,
    documents::document_reload,
    documents::document_revert,
    documents::document_mark_saved,
    documents::document_close,
    documents::dirty_documents,
    preferences::set_ai_language,
    preferences::set_system_prompt,
    cli_install::cli_install_status,
    cli_install::install_cli,
    plan_usage::get_plan_usage,
    accounts::list_accounts,
    accounts::sign_in_account,
    accounts::cancel_sign_in,
    accounts::remove_account,
    accounts::set_active_account,
    github_token::github_token_status,
    github_token::set_github_token,
    github_token::remove_github_token,
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    pub record: SessionRecord,
    pub is_live: bool,
    /// Progress of preparing the worktree's `node_modules`; `None` when nothing was or is being prepared.
    pub dependencies: Option<DependencyStatus>,
    /// Whether the session's worktree exists here; a remote session adopted from its VM gets one with its first sync.
    pub has_local_worktree: bool,
    /// The branch on `origin` a push of the session lands on (`push_target`); `None` without a local worktree.
    pub push_target: Option<String>,
}

impl SessionView {
    async fn new(app: &AppHandle, record: SessionRecord, is_live: bool) -> Self {
        let dependencies = app.state::<DependencyRegistry>().status(&record.worktree_path);
        let has_local_worktree = record.worktree_path.is_dir();
        let push_target = if has_local_worktree { Some(push_target(&record, remote_host(app, &record).as_ref().map(|(_, target)| target)).await) } else { None };
        SessionView { record, is_live, dependencies, has_local_worktree, push_target }
    }
}

/// How the local agent of `record` starts: loading its conversation when it has one.
fn local_start(record: &SessionRecord) -> SessionStart {
    match &record.acp_session_id {
        Some(acp_session_id) => SessionStart::Load { cwd: record.worktree_path.clone(), acp_session_id: acp_session_id.clone() },
        None => SessionStart::New { cwd: record.worktree_path.clone() },
    }
}

/// Connects the agent of `record` with `start` (its selection, if any, goes into the system prompt), stores the
/// ACP session ID it got, registers the live session and starts watching its worktree for the diagram and for changes
/// from outside; a remote session starts syncing its files. The store may change while the agent starts (attribution, summary, or the session
/// being closed), so the view is built from the record as stored afterwards; a session closed meanwhile gets its agent
/// shut down again.
async fn activate(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    record: SessionRecord,
    start: SessionStart,
    transport: AgentTransport,
) -> Result<SessionView, String> {
    let id = record.id;
    let sync_owner = transport.sync_owner();
    // An agent on this Mac finds the worktree's tmux and `hunt-client`, which its system prompt names, ready.
    if sync_owner.is_none() && record.worktree_path.is_dir() {
        if let Err(error) = LocalTmux::prepare(&record.worktree_path, record.parent_id.unwrap_or(id)).await {
            eprintln!("preparing the tmux of session {id} failed: {error}");
        }
        if let Err(error) = control::prepare_client(app, &record.worktree_path) {
            eprintln!("preparing hunt-client for session {id} failed: {error}");
        }
    }
    // The guardrail skill exists before the system prompt quotes its criteria.
    if record.worktree_path.is_dir() {
        if let Err(error) = ensure_guardrail_skill(app, &record).await {
            eprintln!("writing the guardrail skill into the worktree of session {id} failed: {error}");
        }
    }
    let context_prompt = record.selection.as_ref().map(SelectionContext::to_system_prompt);
    let mut live = connect(app.clone(), id, start, context_prompt, transport).await?;
    let acp_session_id = live.acp_session_id.to_string();

    // The store check and the registry insert happen under the registry lock, so `stop_agent` cannot slip in
    // between them.
    let mut sessions = registry.live.lock().await;
    let stored = store::update_session(app, id, |stored| stored.acp_session_id = Some(acp_session_id))
        .and_then(|stored| stored.ok_or_else(|| "session was closed while its agent started".to_string()));
    let record = match stored {
        Ok(record) => record,
        Err(error) => {
            // The agent task ends through `forget_live_session`, which drops its permissions and attribution.
            live.shutdown();
            return Err(error);
        }
    };
    sessions.insert(id, live);
    drop(sessions);
    if let Some(owner) = sync_owner {
        sync::attach(app, owner, id);
    }
    related::agent_started(app, id);
    if !record.worktree_path.is_dir() {
        return Ok(SessionView::new(app, record, true).await);
    }

    // Every start renews the exclude entry, so repositories of older sessions learn the diagram folder's current name.
    if let Err(error) = crate::git::exclude_hunt_dir(&record.worktree_path).await {
        eprintln!("excluding the diagram folder in the worktree of session {id} failed: {error}");
    }
    if record.workspace == Workspace::Worktree {
        if let Err(error) = crate::git::configure_push(&record.worktree_path).await {
            eprintln!("configuring git push in the worktree of session {id} failed: {error}");
        }
    }
    if let Err(error) = crate::graph::watch(app, watchers, id, &record.worktree_path) {
        eprintln!("watching the graph of session {id} failed: {error}");
    }
    if let Err(error) = worktree_watch::watch(app, &app.state::<WorktreeWatchers>(), id, &record.worktree_path) {
        eprintln!("watching the worktree of session {id} for changes failed: {error}");
    }
    Ok(SessionView::new(app, record, true).await)
}

/// Connects to the relay of the remote session `record` (see `start_remote_relay`) and opens the ACP stream over SSH.
/// The relay may have started a new conversation (`/clear`, or a transcript it could not load); the record then gets
/// that conversation's ID. A session whose VM no longer exists continues here instead (`continue_without_vm`).
async fn activate_remote(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, record: SessionRecord) -> Result<SessionView, String> {
    let id = record.id;
    let target = record.remote.clone().ok_or("failed to connect the remote session: it runs locally")?;
    let Some((ssh, target)) = start_remote_relay(app, id, target.clone(), &progress_reporter(app, id)).await? else {
        return continue_without_vm(app, registry, watchers, id, target).await;
    };
    open_remote_relay(app, registry, watchers, id, ssh, target).await
}

/// Opens the ACP stream to the relay of the remote session `id`, which `start_remote_relay` brought up on its VM behind
/// `ssh` (`target` names its worktree there), once the relay serves a conversation.
async fn open_remote_relay(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    id: Uuid,
    ssh: Ssh,
    target: RemoteTarget,
) -> Result<SessionView, String> {
    let status = crate::remote::hunt_ctl(&ssh, &["wait", &id.to_string(), "--timeout", "180"]).await?;
    if let Some(at) = crate::remote::relay_activity(&status, chrono::Utc::now()) {
        note_remote_activity(app, id, at);
    }
    // An adopted session's record learned its worktree on the VM meanwhile.
    let record = store::find_session(app, id)?;
    let acp_session_id = crate::remote::relay_conversation(&status, record.acp_session_id.as_deref())
        .ok_or("failed to connect the remote session: its relay reports no conversation")?;
    let ssh_args = ssh.stream_args(&crate::remote::relay_stream_command());
    let start = SessionStart::Load { cwd: target.worktree_path.clone(), acp_session_id };
    activate(app, registry, watchers, record, start, AgentTransport::Remote { ssh_args, sync_owner: id }).await
}

/// Brings the VM of the remote session `id` up for a connect: has the gateway start it when it is off (it stops itself
/// when idle), checks its release, installs the agent's tools, learns the worktree of an adopted session on its first
/// connect and makes sure the session's relay runs. Returns the connection and `target` with its worktree on the VM and
/// the VM where the gateway runs it, which every stored session on the VM takes over when the start moved it to another
/// zone; `None` when the VM no longer exists.
async fn start_remote_relay(app: &AppHandle, id: Uuid, target: RemoteTarget, progress: Progress<'_>) -> Result<Option<(Ssh, RemoteTarget)>, String> {
    progress.step(RemoteStep::Connecting);
    // A relay that runs keeps running on the release it started with.
    let gateway = gateway_vm("connect the remote session").await?;
    let Some((ssh, vm)) = crate::remote::start_session_vm(&gateway, id, &target.vm, &ssh_dir()?, progress).await? else {
        return Ok(None);
    };
    let target = if vm == target.vm {
        target
    } else {
        if store::replace_remote_vm(app, &target.vm, &vm)? > 0 {
            announce_sessions_changed(app);
        }
        RemoteTarget { vm, ..target }
    };
    // An adopted session learns its worktree on the VM with its first connect; the chat works without it.
    let target = if target.worktree_path.as_os_str().is_empty() {
        match remote_worktree(app, id, &target, &ssh).await {
            Ok(worktree) => RemoteTarget { worktree_path: PathBuf::from(worktree), ..target },
            Err(error) => {
                eprintln!("finding the worktree of session {id} on its VM failed: {error}");
                target
            }
        }
    } else {
        target
    };
    progress.step(RemoteStep::ConnectingAgent);
    // A running relay keeps its tokens, so it stays reachable with the local login selected.
    let token_input = crate::remote::local_token_input(&store::app_data_dir(app)?).await?;
    crate::remote::start_relay(&ssh, id, target.origin, &token_input).await?;
    sync::take_over_vm_push_target(app, id, &ssh, &target).await;
    Ok(Some((ssh, target)))
}

/// Makes the remote session `id` a local one again, since its VM `target.vm` no longer exists: whatever the agent did
/// there since is lost with it, the session continues here with the local worktree as the file sync left it and the
/// conversation as of the agent's last finished turn, which the sync backed up, and it can be handed off again. Once
/// its local agent runs, fails with a message that says so, which the chat shows. An adopted session without a local
/// worktree has nothing to continue with.
async fn continue_without_vm(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    id: Uuid,
    target: RemoteTarget,
) -> Result<SessionView, String> {
    let instance = target.vm.instance.clone();
    if target.is_adopted() && !store::find_session(app, id)?.worktree_path.is_dir() {
        return Err(format!("failed to connect the session: its VM {instance} no longer exists and nothing of it is on this Mac; delete the session"));
    }
    let retrieved = crate::remote::retrieve::Retrieved { acp_session_id: None, branch: None };
    finish_retrieval(app, registry, watchers, id, &target, retrieved, VmEnd::Delete).await?;
    Err(format!(
        "the VM {instance} of the session no longer exists; the session continues here with the files of its local worktree and the \
         conversation as of the agent's last finished turn, and can be handed off again"
    ))
}

/// The OAuth token of the active Claude account, which the relay on the VM runs Claude Code with. The local login
/// stays in this Mac's keychain, so it fails with `what` (the action) and a hint where to pick an account.
async fn remote_claude_token(app: &AppHandle, what: &str) -> Result<String, String> {
    accounts::active_token(app).await?.ok_or_else(|| {
        format!("failed to {what}: the agent on the VM needs a Claude account; pick one in the sidebar or add one under Settings → Agent")
    })
}

/// The worktree of the remote session `id` on its running VM behind `ssh`: the one `target` names, or for an adopted
/// session that never reached its VM the one the VM records, which the session's record keeps from then on.
async fn remote_worktree(app: &AppHandle, id: Uuid, target: &RemoteTarget, ssh: &Ssh) -> Result<String, String> {
    if !target.worktree_path.as_os_str().is_empty() {
        return Ok(target.worktree_path.display().to_string());
    }
    let meta = crate::remote::adoption::read_session_meta(ssh, id).await?;
    store::update_session(app, id, |stored| {
        let Some(remote) = stored.remote.as_mut() else { return };
        remote.worktree_path = PathBuf::from(&meta.worktree);
        if let Some(branch) = meta.branch.as_ref().filter(|_| remote.branch.is_empty()) {
            remote.branch = branch.clone();
            stored.branch = branch.clone();
        }
    })?;
    announce_sessions_changed(app);
    Ok(meta.worktree)
}

/// The remote target of the session `id` and whether its VM runs; the VM is not started. A connected session proves a
/// running VM, so only an unconnected one asks the gateway. `action` names what the caller does, for errors.
async fn remote_vm_state(app: &AppHandle, registry: &SessionRegistry, id: Uuid, action: &str) -> Result<(RemoteTarget, bool), String> {
    let target = store::find_session(app, id)?.remote.ok_or_else(|| format!("failed to {action}: the session runs locally"))?;
    let is_connected = registry.live.lock().await.contains_key(&id);
    let is_running = is_connected || gateway_api(action).await?.is_vm_running(id).await?;
    Ok((target, is_running))
}

/// The remote target of the session `id` once its VM is known to run; a VM that is off is an error and stays off.
async fn running_remote(app: &AppHandle, registry: &SessionRegistry, id: Uuid, action: &str) -> Result<RemoteTarget, String> {
    let (target, is_running) = remote_vm_state(app, registry, id, action).await?;
    if !is_running {
        return Err(format!("failed to {action}: the VM {} is off; the next prompt starts it", target.vm.instance));
    }
    Ok(target)
}

/// What becomes of a remote session's VM when the session runs here again.
#[derive(Clone, Copy)]
enum VmEnd {
    Delete,
    /// Saved into the local repository first, once it can be reached (`preserve_and_delete_vm`).
    PreserveAndDelete,
}

/// Makes the session `id`, retrieved from `target` with `retrieved`, run locally: stores the conversation and branch
/// the retrieval brought, ends the remote side (the VM is deleted, as `vm_end` says), prepares the worktree's
/// dependencies and starts the local agent in the permission mode the session had before the handoff. The caller holds
/// the session's start claim.
async fn finish_retrieval(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    id: Uuid,
    target: &RemoteTarget,
    retrieved: crate::remote::retrieve::Retrieved,
    vm_end: VmEnd,
) -> Result<SessionView, String> {
    let record = store::update_session(app, id, |stored| {
        stored.remote = None;
        if let Some(acp_session_id) = &retrieved.acp_session_id {
            stored.acp_session_id = Some(acp_session_id.clone());
        }
        if let Some(branch) = &retrieved.branch {
            stored.branch = branch.clone();
        }
    })?
    .ok_or_else(|| "failed to retrieve the session: it was closed meanwhile".to_string())?;
    announce_sessions_changed(app);
    sync::forget(app, id);
    match vm_end {
        VmEnd::Delete => forget_remote(app, target, id, true).await,
        VmEnd::PreserveAndDelete => {
            forget_remote(app, target, id, false).await;
            preserve_and_delete_vm(app, target, id, &record.worktree_path);
        }
    }
    restore_transcript_mode(&record, target)?;
    dependencies::ensure(app, record.repo_path.clone(), record.worktree_path.clone(), Install::Updating);
    let start = local_start(&record);
    let view = activate(app, registry, watchers, record, start, AgentTransport::Local).await?;
    let LiveHandles { history, .. } = live_session(registry, id).await?;
    let mode = match target.restored_mode() {
        mode if offers_mode(&history.lock().unwrap(), mode) => mode,
        _ => "default",
    };
    set_mode(registry, id, mode.to_string())
        .await
        .map_err(|error| format!("failed to restore the permission mode {mode} of the retrieved session: {error}"))?;
    Ok(view)
}

/// Gives the local transcript of the retrieved session `record`, which the VM wrote in its own permission mode, the mode
/// the session gets back (`RemoteTarget::restored_mode`).
fn restore_transcript_mode(record: &SessionRecord, target: &RemoteTarget) -> Result<(), String> {
    let acp_session_ids: Vec<String> = record.acp_session_id.iter().cloned().collect();
    crate::remote::retrieve::restore_mode(&claude_dir()?, &record.worktree_path, target.restored_mode(), &acp_session_ids)
        .map_err(|error| format!("failed to restore the permission mode of the retrieved session's transcript: {error}"))
}

/// The VM the worktree of `record` lives on, with the id of the remote session that owns it: the session's own, or for
/// a sub chat its parent's, whose worktree it works in; `None` for a worktree only on this Mac.
fn remote_host(app: &AppHandle, record: &SessionRecord) -> Option<(Uuid, RemoteTarget)> {
    let parent = record.remote.is_none().then_some(record.parent_id).flatten().and_then(|id| store::find_session(app, id).ok());
    host_of(record, parent.as_ref())
}

/// `remote_host` of `record`, whose parent is `parent`.
fn host_of(record: &SessionRecord, parent: Option<&SessionRecord>) -> Option<(Uuid, RemoteTarget)> {
    match (&record.remote, parent) {
        (Some(target), _) => Some((record.id, target.clone())),
        (None, Some(parent)) => parent.remote.clone().map(|target| (parent.id, target)),
        (None, None) => None,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProgressEvent {
    hunt_session_id: Uuid,
    /// The step that runs now; `None` once the operation ended.
    step: Option<RemoteStep>,
    /// The gateway's last log line about the step, e.g. why the VM does not answer yet.
    detail: Option<String>,
}

/// Reports the steps of a remote operation on a session and the gateway's log lines about them to the UI as
/// `remote:progress`.
struct ProgressEmitter {
    app: AppHandle,
    id: Uuid,
    /// The step that runs now, which a log line belongs to.
    current: std::sync::Mutex<Option<RemoteStep>>,
}

impl ProgressEmitter {
    fn emit(&self, step: Option<RemoteStep>, detail: Option<String>) {
        let _ = self.app.emit("remote:progress", RemoteProgressEvent { hunt_session_id: self.id, step, detail });
    }
}

impl Reporter for ProgressEmitter {
    fn step(&self, step: RemoteStep) {
        *self.current.lock().unwrap() = Some(step);
        self.emit(Some(step), None);
    }

    fn log(&self, message: &str) {
        let Some(step) = *self.current.lock().unwrap() else { return };
        self.emit(Some(step), Some(message.to_string()));
    }
}

/// Reports the steps of a remote operation on session `id` to the UI; see `ProgressEmitter`.
fn progress_reporter(app: &AppHandle, id: Uuid) -> ProgressEmitter {
    ProgressEmitter { app: app.clone(), id, current: std::sync::Mutex::new(None) }
}

/// Tells the UI that the remote operation on session `id` ended, successful or not.
fn finish_progress(app: &AppHandle, id: Uuid) {
    let _ = app.emit("remote:progress", RemoteProgressEvent { hunt_session_id: id, step: None, detail: None });
}

/// Where Hunt keeps the base of the repository memory the handoff of session `id` sent.
fn memory_base_path(app: &AppHandle, id: Uuid) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join("remote-memory").join(format!("{id}.json")))
}

/// The remote settings the main window pushed last; `None` before it did and while the project is missing.
static REMOTE_SETTINGS: std::sync::Mutex<Option<VmSettings>> = std::sync::Mutex::new(None);

/// The gateway of the remote settings; fails with `what` (the action) while there are none.
pub(super) async fn gateway_vm(what: &str) -> Result<VmRef, String> {
    let settings = REMOTE_SETTINGS
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| format!("failed to {what}: set the project under Settings → Remote VM"))?;
    crate::remote::gateway_vm(&settings).await
}

/// The gateway API of the remote settings, for `what` (the action).
pub(crate) async fn gateway_api(what: &str) -> Result<GatewayApi, String> {
    GatewayApi::open(&gateway_vm(what).await?, &ssh_dir()?).await
}

/// Forgets what this Mac keeps for the remote session `id` on `target` (the base of its memory merge) and, with
/// `delete_vm`, deletes its VM. Failures are only logged.
async fn forget_remote(app: &AppHandle, target: &RemoteTarget, id: Uuid, delete_vm: bool) {
    if let Ok(path) = memory_base_path(app, id) {
        let _ = std::fs::remove_file(path);
    }
    link::forget(app, id);
    relay_watch::stop(app, id);
    if delete_vm {
        delete_session_vm(app, &target.vm, id).await;
    }
}

/// Ends the agent of `id` like `stop_agent` and waits until its task finished, so a new start cannot race it.
async fn stop_agent_and_wait(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, permissions: &PermissionRegistry, id: Uuid) {
    drop_pending_permissions(permissions, id);
    let finished = registry.live.lock().await.remove(&id).and_then(|mut live| live.shutdown());
    if let Some(finished) = finished {
        let _ = finished.await;
    }
    crate::graph::unwatch(watchers, id);
    worktree_watch::unwatch(&app.state::<WorktreeWatchers>(), id);
    attribution::forget_session(app, id);
    close_desktop(app, id);
    close_browser(app, id);
    sync::stop_and_wait(app, id).await;
}

/// Records `at` as the last work of the agent of the remote session `id` unless a later one is known; a local session
/// is left alone. Failures are only logged: the activity only times the reminder about idle sessions.
fn note_remote_activity(app: &AppHandle, id: Uuid, at: chrono::DateTime<chrono::Utc>) {
    let updated = store::update_session(app, id, |record| {
        if let Some(remote) = record.remote.as_mut() {
            remote.last_active_at = remote.last_active_at.max(Some(at));
        }
    });
    if let Err(error) = updated {
        eprintln!("recording the activity of session {id} failed: {error}");
    }
}

/// Ends the agent process of `id` (if any) and drops everything bound to it.
async fn stop_agent(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, permissions: &PermissionRegistry, id: Uuid) {
    drop_pending_permissions(permissions, id);
    if let Some(mut live) = registry.live.lock().await.remove(&id) {
        live.shutdown();
    }
    crate::graph::unwatch(watchers, id);
    worktree_watch::unwatch(&app.state::<WorktreeWatchers>(), id);
    attribution::forget_session(app, id);
    close_desktop(app, id);
    close_browser(app, id);
    sync::detach(app, id);
}

/// Agent config options the chat shows, which a handoff carries over to the VM.
const MODEL_CONFIG_ID: &str = "model";
const EFFORT_CONFIG_ID: &str = "effort";
const MODE_CONFIG_ID: &str = "mode";

/// The values of the select options `config_ids` as the chat shows them, taken from the last option list in `history`,
/// in the order of `config_ids`; options the list lacks are left out.
fn shown_config_values(history: &[SessionNotification], config_ids: &[&str]) -> Vec<(String, String)> {
    let Some(options) = latest_config_options(history) else { return Vec::new() };
    config_ids
        .iter()
        .filter_map(|config_id| {
            let option = options.iter().find(|option| &*option.id.0 == *config_id)?;
            let SessionConfigKind::Select(select) = &option.kind else { return None };
            Some((config_id.to_string(), select.current_value.0.to_string()))
        })
        .collect()
}

/// Whether the last option list in `history` offers the permission mode `mode_id`.
fn offers_mode(history: &[SessionNotification], mode_id: &str) -> bool {
    let Some(options) = latest_config_options(history) else { return false };
    let Some(option) = options.iter().find(|option| &*option.id.0 == MODE_CONFIG_ID) else { return false };
    let SessionConfigKind::Select(select) = &option.kind else { return false };
    let is_mode = |choice: &SessionConfigSelectOption| &*choice.value.0 == mode_id;
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(choices) => choices.iter().any(is_mode),
        SessionConfigSelectOptions::Grouped(groups) => groups.iter().flat_map(|group| &group.options).any(is_mode),
        _ => false,
    }
}

/// The option list the agent sent last, as `history` recorded it.
fn latest_config_options(history: &[SessionNotification]) -> Option<&[SessionConfigOption]> {
    history.iter().rev().find_map(|notification| match &notification.update {
        SessionUpdate::ConfigOptionUpdate(update) => Some(update.config_options.as_slice()),
        _ => None,
    })
}

/// The handles of the running session `id`; the error is what the UI shows when its agent is not running.
async fn live_session(registry: &SessionRegistry, id: Uuid) -> Result<LiveHandles, String> {
    let live = registry.live.lock().await;
    let session = live.get(&id).ok_or("session is not running")?;
    Ok(session.handles())
}

/// Switches the permission mode of the running agent of `id`; the agent announces it as a `config_option_update`.
async fn set_mode(registry: &SessionRegistry, id: Uuid, mode_id: String) -> Result<(), String> {
    let LiveHandles { connection, acp_session_id, .. } = live_session(registry, id).await?;

    connection
        .send_request(SetSessionModeRequest::new(acp_session_id, mode_id))
        .block_task()
        .await
        .map_err(|error| format!("failed to set the session mode: {error}"))?;
    Ok(())
}

/// The stored record of `id` and the absolute location of the worktree-relative `path` in its worktree. Every
/// command that takes a path from the UI resolves it here: absolute paths and `..` segments are rejected.
pub(crate) fn session_file(app: &AppHandle, id: Uuid, path: &str) -> Result<(SessionRecord, PathBuf), String> {
    let record = worktree_session(app, id)?;
    let target = worktree_file(&record, path)?;
    Ok((record, target))
}

/// The stored record of `id` for a command only a local session allows, such as work next to its agent.
fn local_session(app: &AppHandle, id: Uuid) -> Result<SessionRecord, String> {
    let record = store::find_session(app, id)?;
    if record.remote.is_some() {
        return Err(format!("failed to use the worktree of session {id}: the session runs on a remote VM"));
    }
    Ok(record)
}

/// The stored record of `id` for a command that works on the local worktree: a local session's, or a remote session's,
/// which `session::sync` keeps in sync with its VM; a session adopted from its VM gets one with its first sync.
pub(crate) fn worktree_session(app: &AppHandle, id: Uuid) -> Result<SessionRecord, String> {
    let record = store::find_session(app, id)?;
    if record.remote.is_some() && !record.worktree_path.is_dir() {
        return Err(format!("failed to use the worktree of session {id}: it has no local worktree yet; it gets one once Hunt reached its VM"));
    }
    Ok(record)
}

/// The absolute location of the worktree-relative `path` in the worktree of `record`; rejects paths that would
/// leave the worktree.
fn worktree_file(record: &SessionRecord, path: &str) -> Result<PathBuf, String> {
    crate::git::ensure_inside_worktree(path)?;
    Ok(record.worktree_path.join(path))
}

/// Writes the repository's guardrail skill into the session's worktree unless it exists (`guardrail_skill::ensure`);
/// the new file counts as the session's own change.
async fn ensure_guardrail_skill(app: &AppHandle, record: &SessionRecord) -> Result<(), String> {
    let mut written = None;
    attribution::record_write(app, &record.worktree_path, record.id, || {
        written = guardrail_skill::ensure(&record.worktree_path)?;
        Ok(())
    })
    .await?;
    let Some(path) = written else { return Ok(()) };
    store::add_touched_files(app, record.id, std::slice::from_ref(&path))?;
    sync::note_local_change(app, record.id);
    store::note_worktree_changed(app, record.id)
}

/// The branch on `origin` a push of the session `record`, which runs on the VM `remote` when any, lands on: the one its
/// local branch tracks, else a branch of its own name, as a plain `git push` in the worktree does (`git::configure_push`).
/// A poller session's VM pushes its branch under its own name.
async fn push_target(record: &SessionRecord, remote: Option<&RemoteTarget>) -> String {
    if remote.is_some_and(|target| target.origin.keeps_vm_tokens()) {
        return record.branch.clone();
    }
    crate::git::origin_upstream(&record.worktree_path, &record.branch).await.unwrap_or_else(|| record.branch.clone())
}

fn drop_pending_permissions(permissions: &PermissionRegistry, hunt_session_id: Uuid) {
    permissions.0.lock().unwrap().retain(|_, pending| pending.hunt_session_id != hunt_session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::ConfigOptionUpdate;
    use std::collections::BTreeSet;
    use std::path::Path;

    /// The command names the `invoke` calls in `source`, the text of `src/ipc/commands.ts`, pass, in their order: those of
    /// `invoke("<name>"` and of `invoke<…>("<name>"`, whose type arguments may nest brackets of their own.
    fn invoked_command_names(source: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut rest = source;
        while let Some(start) = rest.find("invoke") {
            let preceding = rest[..start].chars().next_back();
            let is_inside_a_name = preceding.is_some_and(|character| character.is_alphanumeric() || matches!(character, '_' | '$'));
            rest = &rest[start + "invoke".len()..];
            if is_inside_a_name {
                continue;
            }
            let mut call = rest;
            if call.starts_with('<') {
                let Some(end) = closing_angle_bracket(call) else { continue };
                call = &call[end + 1..];
            }
            let Some(arguments) = call.strip_prefix('(') else { continue };
            let Some(literal) = arguments.trim_start().strip_prefix('"') else {
                let call: String = call.chars().take(60).collect();
                panic!("an invoke call in commands.ts names its command without a string literal: invoke{call}");
            };
            let end = literal.find('"').expect("the string literal of the command name ends");
            names.push(literal[..end].to_string());
        }
        names
    }

    /// The byte offset of the `>` that closes the `<` `text` starts with.
    fn closing_angle_bracket(text: &str) -> Option<usize> {
        let mut depth = 0;
        for (offset, character) in text.char_indices() {
            match character {
                '<' => depth += 1,
                '>' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(offset);
                    }
                }
                _ => {}
            }
        }
        None
    }

    #[test]
    fn the_handler_serves_exactly_the_commands_the_ui_invokes() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/commands.ts");
        let source = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        let invoked: BTreeSet<String> = invoked_command_names(&source).into_iter().collect();
        let served: BTreeSet<String> = COMMAND_NAMES.iter().map(|name| name.to_string()).collect();
        assert_eq!(served.len(), COMMAND_NAMES.len(), "the handler lists a command twice");
        let unserved: Vec<&String> = invoked.difference(&served).collect();
        let uninvoked: Vec<&String> = served.difference(&invoked).collect();
        assert!(
            unserved.is_empty() && uninvoked.is_empty(),
            "commands.ts invokes commands no handler serves: {unserved:?}; handlers commands.ts never invokes: {uninvoked:?}"
        );
    }

    #[test]
    fn the_worktree_of_a_sub_chat_lives_on_the_vm_of_its_remote_parent() {
        let local = |title: &str| {
            let worktree = PathBuf::from(format!("/worktrees/{title}"));
            SessionRecord::new(Uuid::new_v4(), title.into(), PathBuf::from("/repo"), worktree, "feat/x".into(), "main".into(), "abc".into())
        };
        let target = RemoteTarget {
            vm: VmRef { project: "hunt".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-12345678".into() },
            worktree_path: PathBuf::from("/home/agent/app"),
            repo: "medconomy/app".into(),
            branch: "feat/x".into(),
            handoff_head: "abc".into(),
            handed_off_at: chrono::Utc::now(),
            local_mode: None,
            last_active_at: None,
            cleanup_asked_at: None,
            preview_domain: None,
            origin: Default::default(),
            issue: None,
            agent: String::new(),
            push_target_pending: false,
            relay_activity: None,
        };
        let mut parent = local("parent");
        let sub_chat = SessionRecord::sub_session(Uuid::new_v4(), "sub".into(), &parent, None);
        assert_eq!(host_of(&parent, None), None);
        assert_eq!(host_of(&sub_chat, Some(&parent)), None);

        parent.remote = Some(target.clone());
        assert_eq!(host_of(&parent, None), Some((parent.id, target.clone())));
        assert_eq!(host_of(&sub_chat, Some(&parent)), Some((parent.id, target)));
        assert_eq!(host_of(&sub_chat, None), None);
    }

    #[test]
    fn shown_config_values_reads_the_last_recorded_option_list() {
        let select = |id: &'static str, value: &'static str| {
            SessionConfigOption::select(id, id, value, vec![SessionConfigSelectOption::new(value, value)])
        };
        let update = |options: Vec<SessionConfigOption>| {
            SessionNotification::new("acp-session", SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options)))
        };
        let history = vec![
            update(vec![select("model", "sonnet"), select("effort", "low")]),
            update(vec![select("effort", "xhigh"), select("model", "fable")]),
        ];

        let shown = shown_config_values(&history, &["model", "effort", "fast"]);
        assert_eq!(shown, vec![("model".to_string(), "fable".to_string()), ("effort".to_string(), "xhigh".to_string())]);
        assert!(shown_config_values(&[], &["model"]).is_empty());
    }

    #[test]
    fn offers_mode_reads_the_modes_of_the_last_recorded_option_list() {
        let modes = |ids: &[&'static str]| {
            let choices = ids.iter().map(|id| SessionConfigSelectOption::new(*id, *id)).collect::<Vec<_>>();
            let option = SessionConfigOption::select(MODE_CONFIG_ID, "Mode", ids[0], choices);
            SessionNotification::new("acp-session", SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(vec![option])))
        };
        let history = vec![modes(&["default", "auto"]), modes(&["default", "plan"])];

        assert!(offers_mode(&history, "plan"));
        assert!(!offers_mode(&history, "auto"));
        assert!(!offers_mode(&[], "default"));
    }
}
