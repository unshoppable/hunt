//! Tauri commands of the session domain: the backend surface the React UI talks to. Domain modules own their
//! thin commands themselves: `lsp_request`, `lsp_notify` and `lsp_cancel` live in `lsp.rs`, `set_ai_language` in
//! `preferences.rs`.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, ContentChunk, EmbeddedResource, EmbeddedResourceResource, ImageContent, Meta,
    PromptRequest, SessionConfigId, SessionConfigKind, SessionConfigOption, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, TextContent, TextResourceContents,
};
use agent_client_protocol::{Agent, ConnectionTo};
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::accounts;
use crate::acp::{
    bundled_script_path, connect, publish_update, system_prompt_append, AgentTransport, LiveHandles, PermissionRegistry, SessionRegistry,
    SessionStart,
};
use crate::git::{self, ChangedFile, FileDiff, Shelf};
use crate::github::{self, GithubViewer, PullRequest, PullRequestDetails, PullRequestRef, ReplyTarget, ReviewComment, ReviewEvent, ReviewThread};
use crate::github_token;
use crate::graph::{self, WatcherRegistry};
use crate::ide;
use crate::lsp::{self, LspRegistry};
use crate::remote::diff::RemoteChanges;
use crate::remote::preview::PreviewStatus;
use crate::remote::ssh::Ssh;
use crate::remote::terminal::{Terminal, TerminalEvent, TerminalRegistry, TerminalSize};
use crate::remote::vm::SessionVm;
use crate::remote::{self, RemoteStep, RemoteTarget, VmRef, VmSettings};
use crate::screenshots::{self, Screenshot};
use crate::session::attribution::{self, FileVersion};
use crate::session::dependencies::{self, DependencyRegistry, DependencyStatus};
use crate::session::review;
use crate::session::store::{self, SelectionContext, SessionRecord, Workspace};
use crate::session::summary;
use crate::workspace;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    pub record: SessionRecord,
    pub is_live: bool,
    /// Progress of preparing the worktree's `node_modules`; `None` when nothing was or is being prepared.
    pub dependencies: Option<DependencyStatus>,
}

impl SessionView {
    fn new(app: &AppHandle, record: SessionRecord, is_live: bool) -> Self {
        let dependencies = app.state::<DependencyRegistry>().status(&record.worktree_path);
        SessionView { record, is_live, dependencies }
    }
}

#[tauri::command]
pub async fn list_sessions(app: AppHandle, registry: State<'_, SessionRegistry>) -> Result<Vec<SessionView>, String> {
    let live = registry.live.lock().await;
    let mut sessions: Vec<SessionView> = store::load_sessions(&app)?
        .into_iter()
        .map(|record| {
            let is_live = live.contains_key(&record.id);
            SessionView::new(&app, record, is_live)
        })
        .collect();
    sessions.sort_by(|left, right| right.record.created_at.cmp(&left.record.created_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn list_branches(repo_path: String) -> Result<Vec<String>, String> {
    git::list_branches(Path::new(&repo_path)).await
}

/// The branch the repository's checkout is on; `HEAD` when it is detached.
#[tauri::command]
pub async fn current_branch(repo_path: String) -> Result<String, String> {
    git::current_branch(Path::new(&repo_path)).await
}

#[tauri::command]
pub async fn list_pull_requests(repo_path: String) -> Result<Vec<PullRequest>, String> {
    github::list_open_pull_requests(Path::new(&repo_path)).await
}

/// The GitHub account `gh` is logged in as for the host of the repository's remote.
#[tauri::command]
pub async fn github_viewer(repo_path: String) -> Result<GithubViewer, String> {
    github::viewer(Path::new(&repo_path)).await
}

/// Description and conversation of the pull request the session reviews.
#[tauri::command]
pub async fn view_pull_request(app: AppHandle, session_id: Uuid) -> Result<PullRequestDetails, String> {
    let record = store::find_session(&app, session_id)?;
    let Some(pull_request) = record.pull_request else {
        return Err("failed to view pull request: the session does not review one".into());
    };
    github::view_pull_request(&record.repo_path, pull_request.number).await
}

/// Review threads of the pull request the session reviews, with their replies, as the diff shows them.
#[tauri::command]
pub async fn list_review_threads(app: AppHandle, session_id: Uuid) -> Result<Vec<ReviewThread>, String> {
    let record = store::find_session(&app, session_id)?;
    let Some(pull_request) = record.pull_request else {
        return Err("failed to list review threads: the session does not review a pull request".into());
    };
    github::review_threads(&record.repo_path, pull_request.number).await
}

/// Submits a review of the pull request the session reviews: `body` is its summary comment, the session's drafted
/// review comments and replies go with it (inline where GitHub takes them, as notes in the summary otherwise) and are
/// cleared once GitHub accepted the review.
#[tauri::command]
pub async fn submit_pull_request_review(app: AppHandle, id: Uuid, event: ReviewEvent, body: String) -> Result<(), String> {
    let record = local_session(&app, id)?;
    let Some(pull_request) = record.pull_request.clone() else {
        return Err("failed to submit review: the session does not review a pull request".into());
    };
    let review_id = review_session_id(&record);
    let drafts = store::find_session(&app, review_id)?.review_comments;
    let prepared = review::prepare(&record, &drafts, &body).await?;
    github::submit_review_with_comments(&record.repo_path, pull_request.number, event, &prepared.body, &prepared.threads, &prepared.replies).await?;
    if !drafts.is_empty() {
        store::update_session(&app, review_id, |review| review.review_comments.clear())?;
        announce_sessions_changed(&app);
    }
    Ok(())
}

/// Drafts a review comment on lines `start_line..=line` of the new version of `path` for the session's pull
/// request, or on the whole file when both are 0; it shows under the line (a file comment above the first line) in
/// every code view until the review is submitted. With `reply_to` it answers a thread on GitHub or a drafted comment
/// that opens a thread, and `path` and the lines are those of what it answers.
#[tauri::command]
pub async fn add_review_comment(
    app: AppHandle,
    id: Uuid,
    path: String,
    start_line: u32,
    line: u32,
    body: String,
    reply_to: Option<ReplyTarget>,
) -> Result<ReviewComment, String> {
    let (record, _) = session_file(&app, id, &path)?;
    if record.pull_request.is_none() {
        return Err("failed to add review comment: the session does not review a pull request".into());
    }
    let is_on_file = start_line == 0 && line == 0;
    if !is_on_file && (start_line == 0 || line < start_line) {
        return Err(format!("failed to add review comment: lines {start_line}-{line} are not a line range"));
    }
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("failed to add review comment: the comment is empty".into());
    }
    let comment = ReviewComment { id: Uuid::new_v4(), path, start_line, line, body, created_at: chrono::Utc::now(), reply_to };
    let stored = comment.clone();
    let mut is_answerable = true;
    store::update_session(&app, review_session_id(&record), |review| {
        if let Some(ReplyTarget::Draft(parent_id)) = &stored.reply_to {
            is_answerable = review.review_comments.iter().any(|draft| draft.id == *parent_id && draft.reply_to.is_none());
        }
        if is_answerable {
            review.review_comments.push(stored);
        }
    })?
    .ok_or_else(|| "failed to add review comment: the session no longer exists".to_string())?;
    if !is_answerable {
        return Err("failed to add review comment: the comment it answers no longer exists".into());
    }
    announce_sessions_changed(&app);
    Ok(comment)
}

/// Replaces the text of the drafted review comment `comment_id`.
#[tauri::command]
pub async fn update_review_comment(app: AppHandle, id: Uuid, comment_id: Uuid, body: String) -> Result<(), String> {
    let record = local_session(&app, id)?;
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("failed to update review comment: the comment is empty".into());
    }
    let mut was_found = false;
    store::update_session(&app, review_session_id(&record), |review| {
        if let Some(comment) = review.review_comments.iter_mut().find(|comment| comment.id == comment_id) {
            comment.body = body;
            was_found = true;
        }
    })?;
    if !was_found {
        return Err("failed to update review comment: it no longer exists".into());
    }
    announce_sessions_changed(&app);
    Ok(())
}

/// Discards the drafted review comment `comment_id` and the drafted replies to it.
#[tauri::command]
pub async fn delete_review_comment(app: AppHandle, id: Uuid, comment_id: Uuid) -> Result<(), String> {
    let record = local_session(&app, id)?;
    let reply_target = Some(ReplyTarget::Draft(comment_id));
    store::update_session(&app, review_session_id(&record), |review| {
        review.review_comments.retain(|comment| comment.id != comment_id && comment.reply_to != reply_target)
    })?;
    announce_sessions_changed(&app);
    Ok(())
}

/// Posts `body` as a reply to the review thread `thread_id` of the session's pull request right away, outside of a
/// review.
#[tauri::command]
pub async fn reply_to_review_thread(app: AppHandle, id: Uuid, thread_id: String, body: String) -> Result<(), String> {
    let record = local_session(&app, id)?;
    if record.pull_request.is_none() {
        return Err("failed to reply to review thread: the session does not review a pull request".into());
    }
    github::reply_to_thread(&record.repo_path, &thread_id, body.trim()).await
}

/// Marks the review thread `thread_id` of the session's pull request as resolved, or as unresolved again.
#[tauri::command]
pub async fn resolve_review_thread(app: AppHandle, id: Uuid, thread_id: String, is_resolved: bool) -> Result<(), String> {
    let record = local_session(&app, id)?;
    if record.pull_request.is_none() {
        return Err("failed to resolve review thread: the session does not review a pull request".into());
    }
    github::set_thread_resolved(&record.repo_path, &thread_id, is_resolved).await
}

/// The session whose record holds the review drafts: a sub session drafts into its parent's list.
fn review_session_id(record: &SessionRecord) -> Uuid {
    record.parent_id.unwrap_or(record.id)
}

/// Creates the session `id`: with `workspace` `Worktree` in a fresh worktree off `base_ref`, with `Checkout` in the
/// repository's own checkout on its current branch, where `base_ref` is ignored. The UI picks the id so it can list
/// the session before this returns. `pull_request` marks it as the review of that pull request; `diff_base_ref` is
/// then the pull request's target branch, whose merge base with the base becomes the diff base.
#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    id: Uuid,
    repo_path: String,
    base_ref: String,
    title: String,
    pull_request: Option<PullRequestRef>,
    diff_base_ref: Option<String>,
    workspace: Workspace,
) -> Result<SessionView, String> {
    ensure_new_id(&app, id)?;
    let repo_path = PathBuf::from(repo_path);
    let (worktree_path, branch, base_ref) = match workspace {
        Workspace::Worktree => {
            let branch = format!("hunt/{}", build_branch_slug(&title, id));
            (store::worktrees_dir(&app)?.join(id.to_string()), branch, base_ref)
        }
        Workspace::Checkout => {
            let branch = git::current_branch(&repo_path).await?;
            (repo_path.clone(), branch.clone(), branch)
        }
    };
    let base_commit = git::rev_parse(&repo_path, &base_ref).await?;
    let diff_base = match &diff_base_ref {
        Some(reference) => Some(git::merge_base(&repo_path, reference, &base_commit).await?),
        None => None,
    };

    if workspace == Workspace::Worktree {
        git::worktree_add(&repo_path, &branch, &worktree_path, &base_commit).await?;
        dependencies::ensure(&app, repo_path.clone(), worktree_path.clone());
    }

    let mut record = SessionRecord::new(id, title, repo_path, worktree_path.clone(), branch, base_ref, base_commit);
    record.pull_request = pull_request;
    record.diff_base = diff_base;
    record.workspace = workspace;
    store::upsert_session(&app, record.clone())?;
    announce_sessions_changed(&app);
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: worktree_path }, AgentTransport::Local).await?;
    announce_sessions_changed(&app);
    Ok(view)
}

/// Starts the sub session `id` of `parent_id`: a fresh agent session in the parent's worktree, listed under the
/// parent in the UI, which picks the id so it can list the session before this returns. A sub chat opened from the
/// diff passes the `selection`, which goes into the system prompt.
#[tauri::command]
pub async fn create_sub_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    id: Uuid,
    parent_id: Uuid,
    title: String,
    selection: Option<SelectionContext>,
) -> Result<SessionView, String> {
    ensure_new_id(&app, id)?;
    let parent = local_session(&app, parent_id)?;
    let record = SessionRecord::sub_session(id, title, &parent, selection);
    store::upsert_session(&app, record.clone())?;
    announce_sessions_changed(&app);
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: parent.worktree_path }, AgentTransport::Local).await?;
    announce_sessions_changed(&app);
    Ok(view)
}

/// Gives the session `id` the title `title`; the UI names a session created without a prompt after its first one.
/// The branch keeps the slug of the title the session was created with.
#[tauri::command]
pub async fn rename_session(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, title: String) -> Result<SessionView, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("failed to rename session: the title is empty".into());
    }
    let record = store::update_session(&app, id, |stored| stored.title = title)?.ok_or_else(|| format!("failed to rename session: the session {id} is not stored"))?;
    announce_sessions_changed(&app);
    let is_live = registry.live.lock().await.contains_key(&id);
    Ok(SessionView::new(&app, record, is_live))
}

/// Rejects a session id the UI picked when a stored session carries it already.
fn ensure_new_id(app: &AppHandle, id: Uuid) -> Result<(), String> {
    if store::find_session(app, id).is_ok() {
        return Err(format!("failed to create session: a session with the id {id} exists already"));
    }
    Ok(())
}

/// Brings a stored session back to life by loading its Claude Code transcript.
#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    // An open while another one runs (the sidebar and a sub chat popover, or a double click) waits for that one.
    if !registry.claim_start(id).await {
        return Ok(SessionView::new(&app, store::find_session(&app, id)?, true));
    }
    if record.remote.is_some() {
        let activated = activate_remote(&app, &registry, &watchers, record).await;
        registry.end_start(id).await;
        finish_progress(&app, id);
        return activated;
    }
    dependencies::ensure(&app, record.repo_path.clone(), record.worktree_path.clone());

    let start = local_start(&record);
    let activated = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await;
    registry.end_start(id).await;
    activated
}

/// How the local agent of `record` starts: loading its conversation when it has one.
fn local_start(record: &SessionRecord) -> SessionStart {
    match &record.acp_session_id {
        Some(acp_session_id) => SessionStart::Load { cwd: record.worktree_path.clone(), acp_session_id: acp_session_id.clone() },
        None => SessionStart::New { cwd: record.worktree_path.clone() },
    }
}

/// Starts the conversation of `id` over, like `/clear` in the terminal: the agent is restarted with a new session
/// and the session record gets its ID. Clearing inside the running agent would move it to a conversation Hunt
/// does not know, so a later resume would not find the one the agent continued.
#[tauri::command]
pub async fn clear_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    // Fetched before anything stops: without a token the remote conversation keeps running as it is.
    let claude_token = match record.remote {
        Some(_) => remote_claude_token(&app, "clear session").await?,
        None => String::new(),
    };
    drop_pending_permissions(&permissions, id);
    let finished = registry.live.lock().await.remove(&id).and_then(|mut live| live.shutdown());
    // The ended agent task clears the registries on its way out; the new agent registers only after that.
    if let Some(finished) = finished {
        let _ = finished.await;
    }
    if !registry.claim_start(id).await {
        return Err("failed to clear session: its agent was started again meanwhile".into());
    }
    if let Some(target) = record.remote.clone() {
        let activated = async {
            let ssh = remote::ssh::Ssh::open(&target.vm, &ssh_dir()?).await?;
            let progress = progress_reporter(&app, id);
            remote::vm::ensure_running(&target.vm, &ssh, &progress).await?;
            let token_input = remote::token_input(&claude_token, github_token::read().await?.as_deref());
            let status = remote::hunt_ctl_with_input(&ssh, &["clear", &id.to_string()], token_input.as_bytes()).await?;
            let acp_session_id = status["acpSessionId"].as_str().map(str::to_string).ok_or("failed to clear session: the relay reports no new session")?;
            let record = store::update_session(&app, id, |stored| stored.acp_session_id = Some(acp_session_id))?
                .ok_or_else(|| "failed to clear session: the session was closed meanwhile".to_string())?;
            activate_remote(&app, &registry, &watchers, record).await
        }
        .await;
        registry.end_start(id).await;
        finish_progress(&app, id);
        return activated;
    }
    let start = SessionStart::New { cwd: record.worktree_path.clone() };
    let activated = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await;
    registry.end_start(id).await;
    activated
}

/// Prepares the worktree's `node_modules` again, after a failed attempt or for a session created before Hunt did
/// this; the result shows up in the session list.
#[tauri::command]
pub async fn prepare_dependencies(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = local_session(&app, id)?;
    dependencies::ensure(&app, record.repo_path, record.worktree_path);
    announce_sessions_changed(&app);
    Ok(())
}

/// Connects the agent of `record` with `start` (its selection, if any, goes into the system prompt), stores the
/// ACP session ID it got, registers the live session and starts watching its worktree for the diagram. The
/// store may change while the agent starts (attribution, summary, or the session being closed), so the view is
/// built from the record as stored afterwards; a session closed meanwhile gets its agent shut down again.
async fn activate(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    record: SessionRecord,
    start: SessionStart,
    transport: AgentTransport,
) -> Result<SessionView, String> {
    let id = record.id;
    let is_local = matches!(transport, AgentTransport::Local);
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
    if !is_local {
        return Ok(SessionView::new(app, record, true));
    }

    // Every start renews the exclude entry, so repositories of older sessions learn the diagram folder's current name.
    if let Err(error) = git::exclude_hunt_dir(&record.worktree_path).await {
        eprintln!("excluding the diagram folder in the worktree of session {id} failed: {error}");
    }
    if let Err(error) = graph::watch(app, watchers, id, &record.worktree_path) {
        eprintln!("watching the graph of session {id} failed: {error}");
    }
    Ok(SessionView::new(app, record, true))
}

/// Connects to the relay of the remote session `record`: starts its VM when it is off (it stops itself when idle), makes
/// sure its relay runs and opens the ACP stream over SSH. The relay may have started a new conversation (`/clear`, or a transcript it could
/// not load); the record then gets that conversation's ID.
async fn activate_remote(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, record: SessionRecord) -> Result<SessionView, String> {
    let id = record.id;
    let target = record.remote.clone().ok_or("failed to connect the remote session: it runs locally")?;
    let progress = progress_reporter(app, id);
    progress(RemoteStep::Connecting);
    let ssh = remote::ssh::Ssh::open(&target.vm, &ssh_dir()?).await?;
    remote::vm::ensure_running(&target.vm, &ssh, &progress).await?;
    // An adopted session learns its worktree on the VM with its first connect; the chat works without it.
    let (record, target) = if target.worktree_path.as_os_str().is_empty() {
        match remote_worktree(app, id, &target, &ssh).await {
            Ok(worktree) => (store::find_session(app, id)?, RemoteTarget { worktree_path: PathBuf::from(worktree), ..target }),
            Err(error) => {
                eprintln!("finding the worktree of session {id} on its VM failed: {error}");
                (record, target)
            }
        }
    } else {
        (record, target)
    };
    progress(RemoteStep::StartingAgent);
    // A running relay keeps its tokens, so it stays reachable with the local login selected.
    let token_input = local_token_input(app).await?;
    remote::hunt_ctl_with_input(&ssh, &["start", &id.to_string()], token_input.as_bytes()).await?;
    let status = remote::hunt_ctl(&ssh, &["wait", &id.to_string(), "--timeout", "180"]).await?;
    if let Some(at) = remote::relay_activity(&status, chrono::Utc::now()) {
        note_remote_activity(app, id, at);
    }
    let acp_session_id = status["acpSessionId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| record.acp_session_id.clone())
        .ok_or("failed to connect the remote session: its relay reports no conversation")?;

    let ssh_args = ssh.stream_args(&remote::shell_command("sudo", &["-n", "-u", "agent", "socat", "-", RELAY_SOCKET]));
    let start = SessionStart::Load { cwd: target.worktree_path.clone(), acp_session_id };
    activate(app, registry, watchers, record, start, AgentTransport::Remote { ssh_args }).await
}

/// The relay of a session VM, as `socat` addresses it.
const RELAY_SOCKET: &str = "UNIX-CONNECT:/run/hunt/relay.sock";

/// The OAuth token of the active Claude account, which the relay on the VM runs Claude Code with. The local login
/// stays in this Mac's keychain, so it fails with `what` (the action) and a hint where to pick an account.
async fn remote_claude_token(app: &AppHandle, what: &str) -> Result<String, String> {
    accounts::active_token(app).await?.ok_or_else(|| {
        format!("failed to {what}: the agent on the VM needs a Claude account; pick one in the sidebar or add one under Settings → Agent")
    })
}

/// The tokens for `hunt-ctl start` with the Claude account selected now, empty with the local login.
async fn local_token_input(app: &AppHandle) -> Result<String, String> {
    let claude_token = accounts::active_token(app).await?.unwrap_or_default();
    Ok(remote::token_input(&claude_token, github_token::read().await?.as_deref()))
}

/// The preview of the remote session `id`: its URLs, the ports that listen on its VM and whether the main port answers.
/// A VM that is off has none; it is not started. A connected session proves a running VM, so only an unconnected one
/// asks Compute Engine.
#[tauri::command]
pub async fn preview_status(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid) -> Result<PreviewStatus, String> {
    let target = store::find_session(&app, id)?.remote.ok_or("failed to read the preview: the session runs locally")?;
    let domain = target
        .preview_domain
        .as_deref()
        .ok_or("failed to read the preview: the session was handed off without a preview domain; bring it back and hand it off again")?;
    let is_connected = registry.live.lock().await.contains_key(&id);
    if !is_connected && remote::vm::status(&target.vm).await? != "RUNNING" {
        return Ok(remote::preview::stopped_status(id, domain));
    }
    let ssh = remote::ssh::Ssh::open(&target.vm, &ssh_dir()?).await?;
    let status = remote::hunt_ctl(&ssh, &["preview-status", &id.to_string()]).await?;
    remote::preview::parse_status(&status, id, domain)
}

/// The session VMs of `project` with the labels and metadata that name their sessions, for adopting VMs no local
/// session knows.
#[tauri::command]
pub async fn list_session_vms(project: String) -> Result<Vec<SessionVm>, String> {
    if project.trim().is_empty() {
        return Err("failed to list the session VMs: no Google Cloud project is set".into());
    }
    remote::vm::list_session_vms(project.trim()).await
}

/// Adopts the session VMs of the project in `settings` that no local session knows (see `remote::adoption`): each
/// becomes a remote session of this Mac in the local checkout of its repository, found among `repo_paths` and the
/// repositories of the stored sessions, or without one when none matches. Adopted sessions still without a checkout
/// get another chance to find one. VMs this Mac deletes or deleted are left out. Returns the IDs of the new sessions.
#[tauri::command]
pub async fn adopt_session_vms(app: AppHandle, settings: VmSettings, repo_paths: Vec<String>) -> Result<Vec<Uuid>, String> {
    let project = settings.project.trim().to_string();
    if project.is_empty() {
        return Err("failed to adopt the session VMs: no Google Cloud project is set".into());
    }
    let preview_domain = remote::preview::validate_domain(&settings.preview_domain)?;
    let vms = remote::vm::list_session_vms(&project).await?;
    let sessions = store::load_sessions(&app)?;
    let mut known: HashSet<Uuid> = sessions.iter().map(|session| session.id).collect();
    known.extend(deleted_session_vms(&app));
    let adoptable = remote::adoption::sessions_to_adopt(&vms, &project, &known);
    let without_checkout: Vec<&SessionRecord> = sessions
        .iter()
        .filter(|session| session.remote.as_ref().is_some_and(RemoteTarget::is_adopted) && session.repo_path.as_os_str().is_empty())
        .collect();
    if adoptable.is_empty() && without_checkout.is_empty() {
        return Ok(Vec::new());
    }

    let stored_repos = sessions.iter().map(|session| session.repo_path.clone());
    let candidates: Vec<PathBuf> = repo_paths.iter().map(PathBuf::from).chain(stored_repos).collect();
    let repositories = remote::adoption::repository_keys(&candidates).await;
    let worktrees = store::worktrees_dir(&app)?;
    let mut adopted = Vec::new();
    for session in &adoptable {
        let repo_path = remote::adoption::matching_repository(&repositories, &session.repo).map(Path::to_path_buf).unwrap_or_default();
        let record = SessionRecord::adopted(session, repo_path, worktrees.join(session.id.to_string()), preview_domain.clone());
        if store::insert_session(&app, record)? {
            adopted.push(session.id);
        }
    }
    let mut has_changed = !adopted.is_empty();
    for session in without_checkout {
        let Some(repo) = session.remote.as_ref().map(|target| target.repo.as_str()) else { continue };
        let Some(repo_path) = remote::adoption::matching_repository(&repositories, repo) else { continue };
        let repo_path = repo_path.to_path_buf();
        store::update_session(&app, session.id, |stored| {
            if stored.repo_path.as_os_str().is_empty() {
                stored.repo_path = repo_path;
            }
        })?;
        has_changed = true;
    }
    if has_changed {
        announce_sessions_changed(&app);
    }

    // The worktree paths of running VMs are read in the background; the others follow with the first connect.
    for session in adoptable.into_iter().filter(|session| session.is_running && adopted.contains(&session.id)) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let id = session.id;
            let found = async {
                let target = store::find_session(&app, id)?.remote.ok_or("the session runs locally")?;
                let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
                remote_worktree(&app, id, &target, &ssh).await
            }
            .await;
            if let Err(error) = found {
                eprintln!("finding the worktree of the adopted session {id} on its VM failed: {error}");
            }
        });
    }
    Ok(adopted)
}

/// The worktree of the remote session `id` on its running VM behind `ssh`: the one `target` names, or for an adopted
/// session that never reached its VM the one the VM records, which the session's record keeps from then on.
async fn remote_worktree(app: &AppHandle, id: Uuid, target: &RemoteTarget, ssh: &Ssh) -> Result<String, String> {
    if !target.worktree_path.as_os_str().is_empty() {
        return Ok(target.worktree_path.display().to_string());
    }
    let meta = remote::adoption::read_session_meta(ssh, id).await?;
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

/// The changes of the remote session `id` on its VM since its handoff (or, for a session the poller started, since its
/// default branch), read-only. A VM that is off reports none and stays off unless `start_vm` is set.
#[tauri::command]
pub async fn remote_changes(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    start_vm: bool,
) -> Result<RemoteChanges, String> {
    let target = store::find_session(&app, id)?.remote.ok_or("failed to list the changes on the VM: the session runs locally")?;
    let is_connected = registry.live.lock().await.contains_key(&id);
    if !is_connected && !start_vm && remote::vm::status(&target.vm).await? != "RUNNING" {
        return Ok(RemoteChanges::vm_off());
    }
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    if !is_connected && start_vm {
        remote::vm::ensure_running(&target.vm, &ssh, &|_: RemoteStep| {}).await?;
    }
    let worktree = remote_worktree(&app, id, &target, &ssh).await?;
    remote::diff::changed_files(&ssh, &worktree, id, &target.handoff_head).await
}

/// The diff of the worktree-relative `path` of the remote session `id` on its VM against `base`, the commit
/// `remote_changes` compared against.
#[tauri::command]
pub async fn read_remote_file_diff(app: AppHandle, id: Uuid, base: String, path: String) -> Result<FileDiff, String> {
    git::ensure_inside_worktree(&path)?;
    let target = store::find_session(&app, id)?.remote.ok_or("failed to read the diff on the VM: the session runs locally")?;
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let worktree = remote_worktree(&app, id, &target, &ssh).await?;
    remote::diff::file_diff(&ssh, &worktree, &base, &path).await
}

/// A chunk of a terminal's output as base64 of its bytes, which may end inside a UTF-8 or an escape sequence.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    id: Uuid,
    data: String,
}

/// The end of a terminal's program; `code` is `None` when a signal ended it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    id: Uuid,
    code: Option<u32>,
}

/// Opens the terminal `terminal_id` with `cols` × `rows` cells on the VM of the remote session `id`, attached to the
/// tmux session the agent runs the app's processes in. The caller picks the ID so it can listen before the first output
/// arrives: `terminal:output` and finally `terminal:exit` go to the calling window only, which owns the terminal.
/// A VM that is off is not started.
#[tauri::command]
pub async fn open_terminal(
    app: AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, SessionRegistry>,
    terminals: State<'_, TerminalRegistry>,
    id: Uuid,
    terminal_id: Uuid,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let target = store::find_session(&app, id)?.remote.ok_or("failed to open the terminal: the session runs locally")?;
    let is_connected = registry.live.lock().await.contains_key(&id);
    if !is_connected && remote::vm::status(&target.vm).await? != "RUNNING" {
        return Err(format!("failed to open the terminal: the VM {} is off; the next prompt starts it", target.vm.instance));
    }
    let args = remote::terminal::attach_args(&target, &ssh_dir()?).await?;
    let owner = window.label().to_string();
    let (emitter, receiver) = (app.clone(), owner.clone());
    let terminal = Terminal::spawn("ssh", &args, TerminalSize { cols, rows }, move |event| {
        let _ = match event {
            TerminalEvent::Output(bytes) => {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                emitter.emit_to(receiver.as_str(), "terminal:output", TerminalOutputEvent { id: terminal_id, data })
            }
            TerminalEvent::Exit(code) => emitter.emit_to(receiver.as_str(), "terminal:exit", TerminalExitEvent { id: terminal_id, code }),
        };
    })?;
    terminals.insert(terminal_id, &owner, terminal)
}

/// Types `data`, base64 of the input bytes, into the terminal `terminal_id`.
#[tauri::command]
pub fn write_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid, data: String) -> Result<(), String> {
    let bytes =
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| format!("failed to decode the terminal input: {error}"))?;
    terminals.write(terminal_id, bytes)
}

#[tauri::command]
pub fn resize_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid, cols: u16, rows: u16) -> Result<(), String> {
    terminals.resize(terminal_id, TerminalSize { cols, rows })
}

/// Ends the terminal `terminal_id`; the tmux session and the processes in it keep running.
#[tauri::command]
pub fn close_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid) {
    terminals.close(terminal_id);
}

/// What Hunt tells the agent of a remote session on top of its usual system prompt addition, whatever the repository.
const REMOTE_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../remote/session/prompts/remote.md"));

/// The Git part of `REMOTE_PROMPT` when Hunt hands the user's GitHub token to the agent on the VM.
const REMOTE_GIT_PUSH_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../remote/session/prompts/git-push.md"));

/// The Git part of `REMOTE_PROMPT` without a GitHub token.
const REMOTE_GIT_LOCAL_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../remote/session/prompts/git-local.md"));

/// What Hunt appends to the system prompt of a remote session: `base`, the usual addition, then `REMOTE_PROMPT`, the Git
/// part that fits whether the agent has the user's GitHub token, and the repository's HUNT.md under a heading of its own.
/// The gateway's poller (`remote/gateway/swf.ts`) composes the prompt of its sessions the same way, with an empty `base`.
fn remote_system_prompt(base: &str, has_github_token: bool, hunt_md: Option<&str>) -> String {
    let git_prompt = if has_github_token { REMOTE_GIT_PUSH_PROMPT } else { REMOTE_GIT_LOCAL_PROMPT };
    let prompt = format!("{base}\n\n{REMOTE_PROMPT}\n{git_prompt}");
    match hunt_md.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => format!("{prompt}\n### The repository's HUNT.md\n{text}\n"),
        None => prompt,
    }
}

/// Moves the session `id` to a VM of its own, created as `settings` say: its agent stops here, its branch, uncommitted
/// work, transcript and the ignored files matching `file_patterns` go to the VM, and the chat continues with the agent
/// there. On failure the session stays local, its agent starts again and the VM stays for the next attempt.
#[tauri::command]
pub async fn hand_off_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    lsp: State<'_, LspRegistry>,
    id: Uuid,
    settings: VmSettings,
    file_patterns: Vec<String>,
) -> Result<SessionView, String> {
    let record = local_session(&app, id)?;
    ensure_hand_off_allowed(&app, &record)?;
    let settings = VmSettings { preview_domain: settings.validate(id)?, ..settings };
    let claude_token = remote_claude_token(&app, "hand off the session").await?;
    let github_token = github_token::read().await?;
    let (config_values, local_mode) = match live_session(&registry, id).await {
        Ok(handles) => {
            let history = handles.history.lock().unwrap();
            let local_mode = shown_config_values(&history, &[MODE_CONFIG_ID]).pop().map(|(_, value)| value);
            (shown_config_values(&history, &[MODEL_CONFIG_ID, EFFORT_CONFIG_ID]), local_mode)
        }
        Err(_) => (Vec::new(), None),
    };
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    if !registry.claim_start(id).await {
        return Err("failed to hand off the session: its agent was started again meanwhile".into());
    }

    let handed_off = async {
        let session_vm = settings.session_vm(id);
        if let Some(leftover) = record.leftover_vm.as_ref().filter(|leftover| **leftover != session_vm) {
            delete_session_vm(&app, leftover, id).await;
        }
        store::update_session(&app, id, |stored| stored.leftover_vm = Some(session_vm.clone()))?;
        let context_prompt = record.selection.as_ref().map(SelectionContext::to_system_prompt);
        let local_hunt_md = remote::read_hunt_md(&record.worktree_path)?;
        let base_prompt = system_prompt_append(&app, context_prompt);
        let has_github_token = github_token.is_some();
        let system_prompt = |hunt_md: Option<&str>| remote_system_prompt(&base_prompt, has_github_token, hunt_md.or(local_hunt_md.as_deref()));
        let token_input = remote::token_input(&claude_token, github_token.as_deref());
        let bundle_dir = bundled_script_path(&app, "remote")?;
        let (ssh_dir, claude_dir) = (ssh_dir()?, claude_dir()?);
        let memory_base = memory_base_path(&app, id)?;
        let request = remote::handoff::HandoffRequest {
            hunt_session_id: id,
            title: &record.title,
            worktree: &record.worktree_path,
            acp_session_id: record.acp_session_id.as_deref(),
            settings: &settings,
            bundle_dir: &bundle_dir,
            ssh_dir: &ssh_dir,
            claude_dir: &claude_dir,
            memory_base: &memory_base,
            file_patterns: &file_patterns,
            system_prompt: &system_prompt,
            config_values: &config_values,
            token_input: &token_input,
            local_mode: local_mode.as_deref(),
        };
        remote::handoff::hand_off(request, &progress_reporter(&app, id)).await
    }
    .await;

    let activated = match handed_off {
        Ok(handed_off) => {
            lsp::forget_session(&lsp, id);
            lsp::stop_for_worktree(&lsp, &record.worktree_path).await;
            let stored = store::update_session(&app, id, |stored| {
                stored.remote = Some(handed_off.target.clone());
                stored.leftover_vm = None;
                if let Some(acp_session_id) = &handed_off.acp_session_id {
                    stored.acp_session_id = Some(acp_session_id.clone());
                }
            });
            announce_sessions_changed(&app);
            match stored {
                Ok(Some(record)) => activate_remote(&app, &registry, &watchers, record).await,
                Ok(None) => Err("failed to hand off the session: it was closed meanwhile".into()),
                Err(error) => Err(error),
            }
        }
        Err(error) => {
            // The session stays local, so its agent comes back and the chat can go on.
            let start = local_start(&record);
            if let Err(restart_error) = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await {
                eprintln!("restarting the agent of session {id} after a failed handoff failed: {restart_error}");
            }
            Err(error)
        }
    };
    registry.end_start(id).await;
    finish_progress(&app, id);
    announce_sessions_changed(&app);
    activated
}

/// Rejects sessions that cannot run on a VM yet: sub sessions and sessions with sub sessions (they share one worktree),
/// sessions in the repository's own checkout, and pull request reviews.
fn ensure_hand_off_allowed(app: &AppHandle, record: &SessionRecord) -> Result<(), String> {
    if record.parent_id.is_some() {
        return Err("failed to hand off the session: a sub session runs where its parent runs".into());
    }
    if record.workspace != Workspace::Worktree {
        return Err("failed to hand off the session: sessions in the repository's own checkout stay local".into());
    }
    if record.pull_request.is_some() {
        return Err("failed to hand off the session: pull request reviews stay local".into());
    }
    if store::load_sessions(app)?.iter().any(|session| session.parent_id == Some(record.id)) {
        return Err("failed to hand off the session: close its sub sessions first".into());
    }
    Ok(())
}

/// Brings the remote session `id` back: its relay stops, its commits, uncommitted work and transcript come back into the
/// local worktree, its VM is deleted and the chat continues with a local agent.
#[tauri::command]
pub async fn retrieve_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    let target = record.remote.clone().ok_or("failed to retrieve the session: it runs locally")?;
    let adopted_into = target.is_adopted().then_some(record.repo_path.as_path());
    if adopted_into.is_some_and(|repo| repo.as_os_str().is_empty()) {
        return Err(format!(
            "failed to bring back the session: there is no local checkout of {}; start a session in one, then refresh the remote sessions",
            target.repo
        ));
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    if !registry.claim_start(id).await {
        return Err("failed to retrieve the session: its agent was started again meanwhile".into());
    }

    let activated = async {
        let (ssh_dir, claude_dir) = (ssh_dir()?, claude_dir()?);
        let memory_base = memory_base_path(&app, id)?;
        let request = remote::retrieve::RetrieveRequest {
            hunt_session_id: id,
            worktree: &record.worktree_path,
            target: &target,
            ssh_dir: &ssh_dir,
            claude_dir: &claude_dir,
            memory_base: &memory_base,
            adopted_into,
        };
        let retrieved = remote::retrieve::retrieve(request, &progress_reporter(&app, id)).await?;
        let record = store::update_session(&app, id, |stored| {
            stored.remote = None;
            if let Some(acp_session_id) = &retrieved.acp_session_id {
                stored.acp_session_id = Some(acp_session_id.clone());
            }
            if let Some(branch) = &retrieved.branch {
                stored.branch = branch.clone();
            }
        })?
        .ok_or_else(|| "failed to retrieve the session: it was closed meanwhile".to_string())?;
        announce_sessions_changed(&app);
        forget_remote(&app, &target.vm, id).await;
        dependencies::ensure(&app, record.repo_path.clone(), record.worktree_path.clone());
        let start = local_start(&record);
        let view = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await?;
        let mode = target.restored_mode();
        set_mode(&registry, id, mode.to_string())
            .await
            .map_err(|error| format!("failed to restore the permission mode {mode} of the retrieved session: {error}"))?;
        Ok(view)
    }
    .await;
    registry.end_start(id).await;
    finish_progress(&app, id);
    announce_sessions_changed(&app);
    activated
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProgressEvent {
    hunt_session_id: Uuid,
    /// The step that runs now; `None` once the operation ended.
    step: Option<RemoteStep>,
}

/// Reports the steps of a remote operation on session `id` to the UI as `remote:progress`.
fn progress_reporter(app: &AppHandle, id: Uuid) -> impl Fn(RemoteStep) + Send + Sync {
    let app = app.clone();
    move |step| {
        let _ = app.emit("remote:progress", RemoteProgressEvent { hunt_session_id: id, step: Some(step) });
    }
}

/// Tells the UI that the remote operation on session `id` ended, successful or not.
fn finish_progress(app: &AppHandle, id: Uuid) {
    let _ = app.emit("remote:progress", RemoteProgressEvent { hunt_session_id: id, step: None });
}

/// Where Hunt keeps its SSH key and known hosts for the VM; a path without spaces, which ssh options cannot hold.
fn ssh_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "failed to find the home folder: HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".ssh").join("hunt"))
}

/// Claude Code's configuration folder, where transcripts, the global `CLAUDE.md` and skills live.
fn claude_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME").map_err(|_| "failed to find the home folder: HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
}

/// Where Hunt keeps the base of the repository memory the handoff of session `id` sent.
fn memory_base_path(app: &AppHandle, id: Uuid) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join("remote-memory").join(format!("{id}.json")))
}

/// A session VM whose deletion failed, e.g. while the Mac was offline; Hunt deletes it at its next start. Entries of
/// older releases name the VM all sessions shared and are dropped.
#[derive(Clone, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PendingCleanup {
    vm: VmRef,
    hunt_session_id: Uuid,
}

/// Serializes the changes to `remote-cleanups.json`.
static PENDING_CLEANUPS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pending_cleanups_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join("remote-cleanups.json"))
}

fn read_pending_cleanups(path: &Path) -> Vec<PendingCleanup> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// Applies `change` to the pending cleanups on disk.
fn change_pending_cleanups(app: &AppHandle, change: impl FnOnce(&mut Vec<PendingCleanup>)) {
    let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
    let changed = pending_cleanups_path(app).and_then(|path| {
        let mut cleanups = read_pending_cleanups(&path);
        change(&mut cleanups);
        let bytes = serde_json::to_vec(&cleanups).map_err(|error| error.to_string())?;
        std::fs::write(path, bytes).map_err(|error| error.to_string())
    });
    if let Err(error) = changed {
        eprintln!("saving the pending remote cleanups failed: {error}");
    }
}

/// Ends the remote side of session `id` for good: the base of its memory merge goes, and its VM `vm` is deleted.
async fn forget_remote(app: &AppHandle, vm: &VmRef, id: Uuid) {
    if let Ok(path) = memory_base_path(app, id) {
        let _ = std::fs::remove_file(path);
    }
    delete_session_vm(app, vm, id).await;
}

/// Sessions whose VM this run of Hunt asked Compute Engine to delete. The VM stays listed while it shuts down, and an
/// adoption in that time must not bring its session back.
static DELETED_SESSION_VMS: std::sync::Mutex<Vec<Uuid>> = std::sync::Mutex::new(Vec::new());

/// The sessions whose VM this Mac deleted in this run or still has to delete; adoptions leave their VMs alone.
fn deleted_session_vms(app: &AppHandle) -> Vec<Uuid> {
    let mut ids = DELETED_SESSION_VMS.lock().unwrap().clone();
    if let Ok(path) = pending_cleanups_path(app) {
        let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
        ids.extend(read_pending_cleanups(&path).into_iter().map(|cleanup| cleanup.hunt_session_id));
    }
    ids
}

/// Deletes `vm`, the VM of session `id`, with its disks; a failed deletion is remembered for the next start of Hunt.
/// Failures are only logged: the local session must stay deletable. The VM an older handoff shared with other sessions
/// is never deleted.
async fn delete_session_vm(app: &AppHandle, vm: &VmRef, id: Uuid) {
    if !remote::vm::is_session_vm(vm, id) {
        eprintln!("keeping the VM {} of session {id}: it is shared with other sessions", vm.instance);
        return;
    }
    DELETED_SESSION_VMS.lock().unwrap().push(id);
    if let Err(error) = remote::vm::delete(vm).await {
        eprintln!("deleting the VM {} of session {id} failed, retrying at the next start: {error}", vm.instance);
        let cleanup = PendingCleanup { vm: vm.clone(), hunt_session_id: id };
        change_pending_cleanups(app, |cleanups| {
            if !cleanups.contains(&cleanup) {
                cleanups.push(cleanup);
            }
        });
    }
}

/// Deletes the session VMs whose deletion failed before, in the background; Hunt runs it at its start.
pub fn run_pending_cleanups(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(path) = pending_cleanups_path(&app) else { return };
        let cleanups = {
            let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
            read_pending_cleanups(&path)
        };
        for cleanup in cleanups {
            let id = cleanup.hunt_session_id;
            let is_done = if !remote::vm::is_session_vm(&cleanup.vm, id) {
                eprintln!("dropping the cleanup of session {id} on the shared VM {}", cleanup.vm.instance);
                true
            } else {
                match remote::vm::delete(&cleanup.vm).await {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("deleting the VM {} of session {id} failed again, retrying at the next start: {error}", cleanup.vm.instance);
                        false
                    }
                }
            };
            if is_done {
                change_pending_cleanups(&app, |pending| pending.retain(|other| *other != cleanup));
            }
        }
    });
}

/// Ends the agent of `id` like `stop_agent` and waits until its task finished, so a new start cannot race it.
async fn stop_agent_and_wait(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, permissions: &PermissionRegistry, id: Uuid) {
    drop_pending_permissions(permissions, id);
    let finished = registry.live.lock().await.remove(&id).and_then(|mut live| live.shutdown());
    if let Some(finished) = finished {
        let _ = finished.await;
    }
    graph::unwatch(watchers, id);
    attribution::forget_session(app, id);
}

#[tauri::command]
pub async fn close_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    lsp: State<'_, LspRegistry>,
    id: Uuid,
    remove_worktree: bool,
) -> Result<(), String> {
    let result = end_session(&app, &registry, &watchers, &permissions, &lsp, id, remove_worktree).await;
    announce_sessions_changed(&app);
    result
}

/// Stops the agent of `id` and, with `remove_worktree`, deletes the session record together with its sub chats,
/// worktree and branch; a session in the repository's own checkout only loses its records.
async fn end_session(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    permissions: &PermissionRegistry,
    lsp: &LspRegistry,
    id: Uuid,
    remove_worktree: bool,
) -> Result<(), String> {
    stop_agent(app, registry, watchers, permissions, id).await;
    if !remove_worktree {
        return Ok(());
    }

    let record = store::find_session(app, id)?;
    if let Some(target) = &record.remote {
        forget_remote(app, &target.vm, id).await;
        // An adopted session has nothing here but its record.
        if target.is_adopted() {
            return store::remove_session(app, id);
        }
    } else if let Some(leftover) = &record.leftover_vm {
        delete_session_vm(app, leftover, id).await;
    }
    // A sub chat only owns its record; the worktree belongs to its parent.
    if record.parent_id.is_some() {
        return store::remove_session(app, id);
    }

    for child in store::load_sessions(app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent(app, registry, watchers, permissions, child.id).await;
        store::remove_session(app, child.id)?;
    }
    if record.workspace == Workspace::Checkout {
        store::remove_session(app, id)?;
        forget_edit_log_if_unused(app, &record.worktree_path);
        return Ok(());
    }

    // The language server holds files of the worktree open; it must be gone before the directory is removed.
    lsp::stop_for_worktree(lsp, &record.worktree_path).await;
    app.state::<DependencyRegistry>().forget(&record.worktree_path);
    // A moved or deleted repository must not make the session undeletable.
    let removal = git::worktree_remove(&record.repo_path, &record.worktree_path).await;
    if removal.is_ok() {
        if let Err(error) = git::delete_branch(&record.repo_path, &record.branch).await {
            eprintln!("deleting branch {} of session {id} failed: {error}", record.branch);
        }
    } else if record.worktree_path.exists() {
        std::fs::remove_dir_all(&record.worktree_path)
            .map_err(|error| format!("failed to remove the worktree {}: {error}", record.worktree_path.display()))?;
    }
    // Handoffs and retrievals leave snapshot refs behind, which keep their commits alive.
    if let Err(error) = git::delete_refs(&record.repo_path, &format!("refs/hunt/{id}/")).await {
        eprintln!("deleting the refs of session {id} failed: {error}");
    }
    store::remove_session(app, id)?;
    forget_edit_log_if_unused(app, &record.worktree_path);
    removal
}

/// Deletes the edit log of `worktree` when no stored session works in it any more; a failure is only logged.
fn forget_edit_log_if_unused(app: &AppHandle, worktree: &Path) {
    let result = store::load_sessions(app).and_then(|sessions| {
        if sessions.iter().any(|session| session.worktree_path == worktree) {
            return Ok(());
        }
        attribution::forget_worktree(app, worktree)
    });
    if let Err(error) = result {
        eprintln!("deleting the edit log of {} failed: {error}", worktree.display());
    }
}

/// Tells every window that the stored sessions changed in a way the sidebar must reload: a session was added
/// or removed, or its title or state changed.
/// Records `at` as the last work of the agent of the remote session `id` unless a later one is known; a local session
/// is left alone. Failures are only logged: the activity only times the reminder about idle sessions.
fn note_remote_activity(app: &AppHandle, id: Uuid, at: chrono::DateTime<chrono::Utc>) {
    let is_remote = store::find_session(app, id).is_ok_and(|record| record.remote.is_some());
    if !is_remote {
        return;
    }
    let updated = store::update_session(app, id, |record| {
        if let Some(remote) = record.remote.as_mut() {
            remote.last_active_at = remote.last_active_at.max(Some(at));
        }
    });
    if let Err(error) = updated {
        eprintln!("recording the activity of session {id} failed: {error}");
    }
}

/// Remembers that the user chose to keep the idle remote session `id` for now; Hunt asks again three days later.
#[tauri::command]
pub async fn snooze_remote_cleanup(app: AppHandle, id: Uuid) -> Result<(), String> {
    store::update_session(&app, id, |record| {
        if let Some(remote) = record.remote.as_mut() {
            remote.cleanup_asked_at = Some(chrono::Utc::now());
        }
    })?;
    announce_sessions_changed(&app);
    Ok(())
}

fn announce_sessions_changed(app: &AppHandle) {
    let _ = app.emit("sessions:changed", ());
}

/// Ends the agent process of `id` (if any) and drops everything bound to it.
async fn stop_agent(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, permissions: &PermissionRegistry, id: Uuid) {
    drop_pending_permissions(permissions, id);
    if let Some(mut live) = registry.live.lock().await.remove(&id) {
        live.shutdown();
    }
    graph::unwatch(watchers, id);
    attribution::forget_session(app, id);
}

/// Sends one user turn (the text plus the image files in `images`) and resolves with the stop reason once the
/// agent finished. A sub chat about writing a file (a selection with a task) gets the file's current content
/// ahead of the text, so the agent always sees the version on disk. The finished turn is handed to the
/// background summarizer, which refreshes the session's summary and title.
#[tauri::command]
pub async fn send_prompt(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    text: String,
    images: Vec<String>,
) -> Result<String, String> {
    let mut blocks = prompt_blocks(&text, &images)?;
    if blocks.is_empty() {
        return Err("the prompt is empty".into());
    }
    let record = store::find_session(&app, id)?;
    if let Some(selection) = record.selection.as_ref().filter(|selection| selection.task.is_some() && record.remote.is_none()) {
        if let Some(block) = worktree_file(&record, &selection.path).ok().and_then(|target| file_context_block(&target)) {
            blocks.insert(0, block);
        }
    }
    run_turn(&app, &registry, id, blocks, None).await
}

/// The current text of the file at `target` as an embedded resource block, which the agent receives as a context
/// block tagged with the file's URI; none when there is no readable file there (yet).
fn file_context_block(target: &Path) -> Option<ContentBlock> {
    let text = std::fs::read_to_string(target).ok()?;
    let uri = format!("file://{}", target.display());
    Some(ContentBlock::Resource(EmbeddedResource::new(EmbeddedResourceResource::TextResourceContents(TextResourceContents::new(text, uri)))))
}

/// Asks the agent to rewrite the component diagram with the standard prompt. The turn runs with the agent config
/// values `model` and `effort` from the diagram settings; afterwards the agent gets back the model and effort the chat
/// showed before. The turn is recorded as hidden, so the chat shows neither the prompt text nor the agent's output,
/// and it leaves the session summary alone.
#[tauri::command]
pub async fn refresh_graph(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    model: String,
    effort: String,
) -> Result<String, String> {
    let record = local_session(&app, id)?;
    let prompt = graph::refresh_prompt(&crate::preferences::ai_language(&app), record.diff_base());
    let blocks = vec![ContentBlock::Text(TextContent::new(prompt))];
    let LiveHandles { connection, acp_session_id, history } = live_session(&registry, id).await?;

    // The model goes first: switching it resets the effort.
    let graph_config = [(MODEL_CONFIG_ID, model.as_str()), (EFFORT_CONFIG_ID, effort.as_str())];
    let chat_config = shown_config_values(&history.lock().unwrap(), &graph_config.map(|(config_id, _)| config_id));
    let outcome = async {
        for (config_id, value) in graph_config {
            set_config_option(&connection, &acp_session_id, config_id, value).await?;
        }
        run_turn(&app, &registry, id, blocks, Some(graph::hidden_turn_meta())).await
    }
    .await;
    let restored = async {
        for (config_id, value) in &chat_config {
            let options = set_config_option(&connection, &acp_session_id, config_id, value).await?;
            let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options));
            publish_update(&app, id, &history, SessionNotification::new(acp_session_id.clone(), update));
        }
        Ok::<(), String>(())
    }
    .await;

    let stop_reason = outcome?;
    restored?;
    Ok(stop_reason)
}

/// Agent config options a diagram refresh switches for its turn.
const MODEL_CONFIG_ID: &str = "model";
const EFFORT_CONFIG_ID: &str = "effort";
const MODE_CONFIG_ID: &str = "mode";

/// The values of the select options `config_ids` as the chat shows them, taken from the last option list in `history`,
/// in the order of `config_ids`; options the list lacks are left out.
fn shown_config_values(history: &[SessionNotification], config_ids: &[&str]) -> Vec<(String, String)> {
    let latest = history.iter().rev().find_map(|notification| match &notification.update {
        SessionUpdate::ConfigOptionUpdate(update) => Some(&update.config_options),
        _ => None,
    });
    let Some(options) = latest else { return Vec::new() };
    config_ids
        .iter()
        .filter_map(|config_id| {
            let option = options.iter().find(|option| &*option.id.0 == *config_id)?;
            let SessionConfigKind::Select(select) = &option.kind else { return None };
            Some((config_id.to_string(), select.current_value.0.to_string()))
        })
        .collect()
}

/// Records `blocks` as a user turn, sends them and resolves with the stop reason once the agent finished.
/// `hidden_meta` marks the recorded chunks as a hidden turn; a visible turn is summarized afterwards.
async fn run_turn(
    app: &AppHandle,
    registry: &SessionRegistry,
    id: Uuid,
    blocks: Vec<ContentBlock>,
    hidden_meta: Option<Meta>,
) -> Result<String, String> {
    let LiveHandles { connection, acp_session_id, history } = live_session(registry, id).await?;
    note_remote_activity(app, id, chrono::Utc::now());

    // The agent never echoes the prompt back, so the history records it here.
    let turn_start = {
        let mut history = history.lock().unwrap();
        let turn_start = history.len();
        for block in &blocks {
            let chunk = ContentChunk::new(block.clone()).meta(hidden_meta.clone());
            history.push(SessionNotification::new(acp_session_id.clone(), SessionUpdate::UserMessageChunk(chunk)));
        }
        turn_start
    };

    let response = connection
        .send_request(PromptRequest::new(acp_session_id, blocks))
        .block_task()
        .await
        .map_err(|error| format!("failed to send the prompt: {error}"))?;

    note_remote_activity(app, id, chrono::Utc::now());
    if hidden_meta.is_none() {
        let turn = history.lock().unwrap()[turn_start..].to_vec();
        summary::schedule(app.clone(), id, turn);
    }

    Ok(format!("{:?}", response.stop_reason))
}

/// The content blocks of one prompt: the text (left out when blank) followed by one image block per file.
fn prompt_blocks(text: &str, images: &[String]) -> Result<Vec<ContentBlock>, String> {
    let mut blocks = Vec::with_capacity(images.len() + 1);
    if !text.trim().is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text.to_string())));
    }
    for path in images {
        let mime_type = screenshots::image_mime_type(path).ok_or_else(|| format!("{path} is not an image"))?;
        let bytes = std::fs::read(path).map_err(|error| format!("failed to read {path}: {error}"))?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        blocks.push(ContentBlock::Image(ImageContent::new(data, mime_type).uri(format!("file://{path}"))));
    }
    Ok(blocks)
}

/// Every image in the macOS screenshot folder, newest first, for the prompt's screenshot picker.
#[tauri::command]
pub async fn list_screenshots() -> Result<Vec<Screenshot>, String> {
    screenshots::list_screenshots().await
}

/// Every notification of a running session so far, for rebuilding its chat in the UI.
#[tauri::command]
pub async fn session_history(registry: State<'_, SessionRegistry>, id: Uuid) -> Result<Vec<SessionNotification>, String> {
    let history = live_session(&registry, id).await?.history;
    let history = history.lock().unwrap().clone();
    Ok(history)
}

/// The handles of the running session `id`; the error is what the UI shows when its agent is not running.
async fn live_session(registry: &SessionRegistry, id: Uuid) -> Result<LiveHandles, String> {
    let live = registry.live.lock().await;
    let session = live.get(&id).ok_or("session is not running")?;
    Ok(session.handles())
}

#[tauri::command]
pub async fn cancel_prompt(
    registry: State<'_, SessionRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<(), String> {
    drop_pending_permissions(&permissions, id);

    let session = live_session(&registry, id).await?;
    session
        .connection
        .send_notification(CancelNotification::new(session.acp_session_id))
        .map_err(|error| format!("failed to cancel the prompt: {error}"))
}

#[tauri::command]
pub async fn set_session_mode(registry: State<'_, SessionRegistry>, id: Uuid, mode_id: String) -> Result<(), String> {
    set_mode(&registry, id, mode_id).await
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

/// Changes one session config option (model, effort, …). The agent answers with the full option
/// list, which is published as a `config_option_update` so the UI has a single code path.
#[tauri::command]
pub async fn set_session_config_option(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    config_id: String,
    value: String,
) -> Result<(), String> {
    let LiveHandles { connection, acp_session_id, history } = live_session(&registry, id).await?;

    let options = set_config_option(&connection, &acp_session_id, &config_id, &value).await?;
    let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options));
    publish_update(&app, id, &history, SessionNotification::new(acp_session_id, update));
    Ok(())
}

/// Sets the session config option `config_id` to `value` and returns the agent's full option list.
async fn set_config_option(
    connection: &ConnectionTo<Agent>,
    acp_session_id: &SessionId,
    config_id: &str,
    value: &str,
) -> Result<Vec<SessionConfigOption>, String> {
    let request = SetSessionConfigOptionRequest::new(acp_session_id.clone(), SessionConfigId::new(config_id), value);
    let response = connection
        .send_request(request)
        .block_task()
        .await
        .map_err(|error| format!("failed to set the session config option {config_id}: {error}"))?;
    Ok(response.config_options)
}

#[tauri::command]
pub fn answer_permission(permissions: State<'_, PermissionRegistry>, request_id: Uuid, option_id: String) -> Result<(), String> {
    let pending = permissions.0.lock().unwrap().remove(&request_id).ok_or("permission request is no longer pending")?;
    pending.answer.send(option_id).map_err(|_| "agent stopped waiting for the permission answer".to_string())
}

/// A changed file plus the sessions of the same worktree whose tool calls touched it (empty when the
/// change was made outside the agents, for example in an IDE or by restoring a shelf).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileView {
    #[serde(flatten)]
    pub file: ChangedFile,
    pub touched_by: Vec<Uuid>,
}

#[tauri::command]
pub async fn list_changed_files(app: AppHandle, id: Uuid) -> Result<Vec<ChangedFileView>, String> {
    let record = local_session(&app, id)?;
    let files = git::changed_files(&record.worktree_path, record.diff_base()).await?;
    let mut touched_by = store::touched_by(&app, &record.worktree_path)?;
    Ok(files
        .into_iter()
        .map(|file| ChangedFileView { touched_by: touched_by.remove(&file.path).unwrap_or_default(), file })
        .collect())
}

/// Added and removed lines of every changed file of the session (untracked files count as all added).
#[tauri::command]
pub async fn change_stats(app: AppHandle, id: Uuid) -> Result<Vec<git::ChangeStat>, String> {
    let record = local_session(&app, id)?;
    git::change_stats(&record.worktree_path, record.diff_base()).await
}

#[tauri::command]
pub async fn read_file_diff(app: AppHandle, id: Uuid, path: String) -> Result<FileDiff, String> {
    let (record, _) = session_file(&app, id, &path)?;
    git::file_diff(&record.worktree_path, record.diff_base(), &path).await
}

/// The versions of `path` in the edit log of the session's worktree, oldest first, each with the session that wrote it.
#[tauri::command]
pub async fn read_file_history(app: AppHandle, id: Uuid, path: String) -> Result<Vec<FileVersion>, String> {
    let (record, _) = session_file(&app, id, &path)?;
    attribution::file_history(&app, &record.worktree_path, &path).await
}

/// The stored record of `id` and the absolute location of the worktree-relative `path` in its worktree. Every
/// command that takes a path from the UI resolves it here: absolute paths and `..` segments are rejected.
fn session_file(app: &AppHandle, id: Uuid, path: &str) -> Result<(SessionRecord, PathBuf), String> {
    let record = local_session(app, id)?;
    let target = worktree_file(&record, path)?;
    Ok((record, target))
}

/// The stored record of `id` for a command that works on the local worktree or starts work next to it; a session
/// handed off to a VM keeps its local worktree untouched until it is retrieved.
fn local_session(app: &AppHandle, id: Uuid) -> Result<SessionRecord, String> {
    let record = store::find_session(app, id)?;
    if record.remote.is_some() {
        return Err(format!("failed to use the worktree of session {id}: the session runs on a remote VM"));
    }
    Ok(record)
}

/// The absolute location of the worktree-relative `path` in the worktree of `record`; rejects paths that would
/// leave the worktree.
fn worktree_file(record: &SessionRecord, path: &str) -> Result<PathBuf, String> {
    git::ensure_inside_worktree(path)?;
    Ok(record.worktree_path.join(path))
}

/// Writes `content` to `path` inside the session's worktree; `path` must be relative and must not leave the worktree.
/// The change counts as the session's own, like an edit by its agent.
#[tauri::command]
pub async fn write_file(app: AppHandle, id: Uuid, path: String, content: String) -> Result<(), String> {
    let (record, target) = session_file(&app, id, &path)?;
    attribution::record_write(&app, &record.worktree_path, id, || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, content).map_err(|error| format!("failed to write {path}: {error}"))
    })
    .await?;
    store::add_touched_files(&app, id, std::slice::from_ref(&path))?;
    store::note_worktree_changed(&app, id)
}

/// Moves the file at `from` to `to` inside the session's worktree, creating `to`'s folders; both paths must be
/// relative and must not leave the worktree, and nothing may exist at `to` yet. Both count as the session's own
/// changes, like an edit by its agent.
#[tauri::command]
pub async fn move_path(app: AppHandle, id: Uuid, from: String, to: String) -> Result<(), String> {
    let (record, source) = session_file(&app, id, &from)?;
    let target = worktree_file(&record, &to)?;
    if from.is_empty() || to.is_empty() {
        return Err("refusing to move the worktree itself".to_string());
    }
    if target.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&source, &target).map_err(|error| format!("failed to move {from} to {to}: {error}"))?;
    store::add_touched_files(&app, id, &[from, to])?;
    store::note_worktree_changed(&app, id)
}

/// Deletes the file or folder (recursively) at `path` inside the session's worktree; `path` must be relative and
/// must not leave the worktree. The deleted files count as the session's own changes, like an edit by its agent.
#[tauri::command]
pub async fn delete_path(app: AppHandle, id: Uuid, path: String) -> Result<(), String> {
    let (record, target) = session_file(&app, id, &path)?;
    if path.is_empty() {
        return Err("refusing to delete the worktree itself".to_string());
    }

    let mut deleted = Vec::new();
    if target.is_dir() {
        collect_files_below(&target, &record.worktree_path, &mut deleted);
        std::fs::remove_dir_all(&target).map_err(|error| format!("failed to delete {path}: {error}"))?;
    } else {
        deleted.push(path.clone());
        std::fs::remove_file(&target).map_err(|error| format!("failed to delete {path}: {error}"))?;
    }
    store::add_touched_files(&app, id, &deleted)?;
    store::note_worktree_changed(&app, id)
}

/// Appends the worktree-relative paths of every file below `dir` to `out`.
fn collect_files_below(dir: &Path, worktree: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_below(&path, worktree, out);
        } else if let Ok(relative) = path.strip_prefix(worktree) {
            out.push(relative.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
pub async fn revert_file(app: AppHandle, id: Uuid, path: String) -> Result<(), String> {
    let (record, _) = session_file(&app, id, &path)?;
    git::revert_file(&record.worktree_path, record.diff_base(), &path).await?;
    store::forget_touched_files(&app, &record.worktree_path, std::slice::from_ref(&path))?;
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn shelve_files(app: AppHandle, id: Uuid, paths: Vec<String>, name: String) -> Result<(), String> {
    let record = local_session(&app, id)?;
    git::shelve_files(&record.worktree_path, &paths, &name).await?;
    store::forget_touched_files(&app, &record.worktree_path, &paths)?;
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn list_shelves(app: AppHandle, id: Uuid) -> Result<Vec<Shelf>, String> {
    let record = local_session(&app, id)?;
    git::list_shelves(&record.worktree_path, &record.branch).await
}

/// Restores a shelf into the worktree; `keep` leaves the shelf in place instead of dropping it.
#[tauri::command]
pub async fn unshelve(app: AppHandle, id: Uuid, reference: String, keep: bool) -> Result<(), String> {
    let record = local_session(&app, id)?;
    git::unshelve(&record.worktree_path, &reference, keep).await?;
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn drop_shelf(app: AppHandle, id: Uuid, reference: String) -> Result<(), String> {
    let record = local_session(&app, id)?;
    git::drop_shelf(&record.worktree_path, &reference).await
}

#[tauri::command]
pub async fn open_worktree_in_webstorm(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = local_session(&app, id)?;
    ide::open_path(&record.worktree_path).await
}

/// Opens a worktree file in WebStorm with the caret on `line`:`column` (1-based).
#[tauri::command]
pub async fn open_file_in_webstorm(app: AppHandle, id: Uuid, path: String, line: u32, column: u32) -> Result<(), String> {
    let (record, target) = session_file(&app, id, &path)?;
    ide::open_path_at(&record.worktree_path, &target, line, column).await
}

/// Mirrors the base and current version of every changed file into a temp directory pair and opens
/// WebStorm's directory diff on them, which lists all changed files in a tree next to the diff.
/// The current side is a read-only copy: edits belong in the worktree, not in the snapshot.
#[tauri::command]
pub async fn open_changed_files_diff_in_webstorm(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = local_session(&app, id)?;
    let files = git::changed_files(&record.worktree_path, record.diff_base()).await?;

    let snapshot_dir = std::env::temp_dir().join("hunt").join(id.to_string());
    let base_dir = snapshot_dir.join("base");
    let current_dir = snapshot_dir.join("current");
    for dir in [&base_dir, &current_dir] {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|error| error.to_string())?;
        }
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }

    for file in &files {
        if let Some(base_content) = git::show(&record.worktree_path, record.diff_base(), &file.path).await {
            let target = base_dir.join(&file.path);
            create_parent_dir(&target)?;
            std::fs::write(&target, base_content).map_err(|error| error.to_string())?;
        }

        let current_path = record.worktree_path.join(&file.path);
        if !current_path.is_file() {
            continue;
        }
        let target = current_dir.join(&file.path);
        create_parent_dir(&target)?;
        std::fs::copy(&current_path, &target).map_err(|error| error.to_string())?;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o444)).map_err(|error| error.to_string())?;
    }

    ide::open_diff(&base_dir, &current_dir).await
}

fn create_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn read_graph(app: AppHandle, id: Uuid) -> Result<Option<serde_json::Value>, String> {
    let record = local_session(&app, id)?;
    graph::read_graph(&record.worktree_path)
}

/// When the session's diagram was generated and whether files of its worktree changed since.
#[tauri::command]
pub async fn graph_status(app: AppHandle, id: Uuid) -> Result<graph::GraphStatus, String> {
    let record = local_session(&app, id)?;
    let changed_at = store::worktree_changed_at(&app, &record.worktree_path)?;
    graph::status(&record.worktree_path, changed_at)
}

fn drop_pending_permissions(permissions: &PermissionRegistry, hunt_session_id: Uuid) {
    permissions.0.lock().unwrap().retain(|_, pending| pending.hunt_session_id != hunt_session_id);
}

/// `hunt/<slug>-<short id>`: lowercase title, non-alphanumerics collapsed to dashes.
fn build_branch_slug(title: &str, id: Uuid) -> String {
    let mut slug = String::new();
    for character in title.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let short_id = &id.to_string()[..8];

    if slug.is_empty() {
        return short_id.to_string();
    }
    format!("{}-{short_id}", slug.chars().take(40).collect::<String>().trim_end_matches('-'))
}

/// Entries of a worktree directory for the project tree (`path` is relative; empty for the root).
#[tauri::command]
pub async fn list_dir(app: AppHandle, id: Uuid, path: String) -> Result<Vec<workspace::DirEntry>, String> {
    let (record, _) = session_file(&app, id, &path)?;
    workspace::list_dir(&record.worktree_path, &path)
}

/// Every project file of the worktree for the file search (⌘P / double shift).
#[tauri::command]
pub async fn list_files(app: AppHandle, id: Uuid) -> Result<Vec<String>, String> {
    let record = local_session(&app, id)?;
    git::list_files(&record.worktree_path).await
}

/// Text content of a worktree file for the built-in editor.
#[tauri::command]
pub async fn read_file(app: AppHandle, id: Uuid, path: String) -> Result<String, String> {
    let (record, _) = session_file(&app, id, &path)?;
    workspace::read_file(&record.worktree_path, &path)
}

/// Worktree files containing `word` as a whole word; candidates for the editor's usage search.
#[tauri::command]
pub async fn search_word(app: AppHandle, id: Uuid, word: String) -> Result<Vec<String>, String> {
    let record = local_session(&app, id)?;
    git::files_containing_word(&record.worktree_path, &word).await
}

/// Resolves the relative import specifiers of `from` to worktree paths (`None` where no file matches).
#[tauri::command]
pub async fn resolve_imports(app: AppHandle, id: Uuid, from: String, specifiers: Vec<String>) -> Result<Vec<Option<String>>, String> {
    let (record, _) = session_file(&app, id, &from)?;
    workspace::resolve_imports(&record.worktree_path, &from, &specifiers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::SessionConfigSelectOption;

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
    fn remote_system_prompt_appends_the_git_part_and_the_hunt_md_of_the_repository() {
        let with_token = remote_system_prompt("BASE", true, Some("\n# Preview\nStart the UIs.\n\n"));
        assert_eq!(
            with_token,
            format!("BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_PUSH_PROMPT}\n### The repository's HUNT.md\n# Preview\nStart the UIs.\n")
        );

        let without_token = remote_system_prompt("BASE", false, None);
        assert_eq!(without_token, format!("BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_LOCAL_PROMPT}"));
        assert_eq!(remote_system_prompt("BASE", false, Some(" \n")), without_token);
        assert!(REMOTE_PROMPT.contains("$HUNT_PREVIEW_URL_TEMPLATE` with `{port}`"));
        assert!(REMOTE_PROMPT.contains("tmux pipe-pane -o -t app:<name> 'cat >> ~/logs/<name>.log'\n```"));

        let poller = remote_system_prompt("", false, None);
        assert!(poller.starts_with("\n\n## Remote session\nThis session runs on a VM of its own. The user brings its commits back to their machine.\n\n"));
        assert!(poller.ends_with(
            "follows at the end when it has one.\n\n### Git\nThere is no GitHub token for this session, so pushing fails: commit locally and do not push.\n"
        ));
    }

    #[test]
    fn build_branch_slug_lowercases_and_collapses_separators() {
        let id = Uuid::parse_str("0123abcd-1111-2222-3333-444455556666").unwrap();
        assert_eq!(build_branch_slug("Fix the Login  Bug!", id), "fix-the-login-bug-0123abcd");
        assert_eq!(build_branch_slug("  ---  ", id), "0123abcd");
        assert_eq!(build_branch_slug("", id), "0123abcd");
        assert_eq!(build_branch_slug("Ärger mit Umlauten", id), "rger-mit-umlauten-0123abcd");

        let long = build_branch_slug(&"word ".repeat(20), id);
        assert_eq!(long, format!("{}-0123abcd", "word-".repeat(8).trim_end_matches('-')));
        assert!(!long.contains("--"));
    }

    #[test]
    fn file_context_block_embeds_the_file_text_and_skips_missing_files() {
        let dir = std::env::temp_dir().join(format!("hunt-file-context-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rule.md");
        std::fs::write(&file, "# Rule\n").unwrap();

        let block = file_context_block(&file).unwrap();
        match block {
            ContentBlock::Resource(resource) => match resource.resource {
                EmbeddedResourceResource::TextResourceContents(contents) => {
                    assert_eq!(contents.text, "# Rule\n");
                    assert_eq!(contents.uri, format!("file://{}", file.display()));
                }
                _ => panic!("expected text contents"),
            },
            _ => panic!("expected a resource block"),
        }
        assert!(file_context_block(&dir.join("missing.md")).is_none());
        assert!(file_context_block(&dir).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prompt_blocks_skips_blank_text_and_rejects_non_images() {
        let blocks = prompt_blocks("  hello  ", &[]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text(text) if text.text == "  hello  "));

        assert!(prompt_blocks("   \n", &[]).unwrap().is_empty());
        assert!(prompt_blocks("text", &["/tmp/notes.txt".to_string()]).is_err());
        assert!(prompt_blocks("text", &["/nowhere/missing.png".to_string()]).is_err());
    }

    #[test]
    fn prompt_blocks_attaches_images_after_the_text() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("shot.PNG");
        std::fs::write(&image, [1u8, 2, 3]).unwrap();
        let image = image.to_string_lossy().to_string();

        let blocks = prompt_blocks("look", &[image.clone()]).unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], ContentBlock::Text(_)));
        match &blocks[1] {
            ContentBlock::Image(content) => {
                assert_eq!(content.mime_type, "image/png");
                assert_eq!(content.data, "AQID");
                assert_eq!(content.uri.as_deref(), Some(format!("file://{image}").as_str()));
            }
            other => panic!("expected an image block, got {other:?}"),
        }
    }

    #[test]
    fn collect_files_below_lists_every_file_relative_to_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        std::fs::create_dir_all(worktree.join("src/app/nested")).unwrap();
        std::fs::write(worktree.join("src/app/a.ts"), "").unwrap();
        std::fs::write(worktree.join("src/app/nested/b.ts"), "").unwrap();
        std::fs::write(worktree.join("root.txt"), "").unwrap();

        let mut files = Vec::new();
        collect_files_below(&worktree.join("src"), worktree, &mut files);
        files.sort();
        assert_eq!(files, vec!["src/app/a.ts".to_string(), "src/app/nested/b.ts".to_string()]);

        let mut none = Vec::new();
        collect_files_below(&worktree.join("missing"), worktree, &mut none);
        assert!(none.is_empty());
    }
}
