//! Tauri commands of the session domain: the backend surface the React UI talks to. Domain modules own their
//! thin commands themselves: `lsp_request`, `lsp_notify` and `lsp_cancel` live in `lsp.rs`, `set_ai_language` in
//! `preferences.rs`.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, ContentChunk, EmbeddedResource, EmbeddedResourceResource, ImageContent, Meta,
    PromptRequest, SessionConfigId, SessionConfigKind, SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectOptions,
    SessionId, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest, TextContent,
    TextResourceContents,
};
use agent_client_protocol::{Agent, ConnectionTo};
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::accounts;
use crate::acp::{
    connect, publish_update, system_prompt_append, AgentTransport, LiveHandles, PermissionRegistry, SessionRegistry,
    SessionStart,
};
use crate::git::{self, ChangedFile, FileDiff, Shelf};
use crate::github::{self, GithubViewer, PullRequest, PullRequestDetails, PullRequestRef, ReplyTarget, ReviewComment, ReviewEvent, ReviewThread};
use crate::github_token;
use crate::private_files;
use crate::graph::{self, WatcherRegistry};
use crate::ide;
use crate::lsp::{self, LspRegistry};
use crate::remote::api::{validate_remote_secret_name, validate_remote_secret_value, GatewayApi, RemoteSecretSummary};
use crate::remote::preview::PreviewStatus;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::terminal::{Terminal, TerminalEvent, TerminalRegistry, TerminalSize, TerminalTarget, TmuxWindow};
use crate::remote::sync::Direction;
use crate::remote::{self, claude_dir, Progress, RemoteStep, RemoteTarget, Reporter, VmRef, VmSettings};
use crate::screenshots::{self, Screenshot};
use crate::session::attribution::{self, FileVersion};
use crate::session::dependencies::{self, DependencyRegistry, DependencyStatus, Install};
use crate::session::link::{self, Link};
use crate::session::related;
use crate::session::review;
use crate::session::store::{self, announce_sessions_changed, SelectionContext, SessionRecord, Workspace};
use crate::session::summary;
use crate::session::sync;
use crate::workspace;

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
}

impl SessionView {
    fn new(app: &AppHandle, record: SessionRecord, is_live: bool) -> Self {
        let dependencies = app.state::<DependencyRegistry>().status(&record.worktree_path);
        let has_local_worktree = record.worktree_path.is_dir();
        SessionView { record, is_live, dependencies, has_local_worktree }
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
    // Oldest first, so that a new session joins the end of the sidebar and the marks of the existing ones stay put.
    sessions.sort_by(|left, right| left.record.created_at.cmp(&right.record.created_at));
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

/// The title of the issue or pull request `number` of the GitHub repository `owner`/`name`, as `gh` sees it from
/// `repo_path`.
#[tauri::command]
pub async fn issue_title(repo_path: String, owner: String, name: String, number: u64) -> Result<String, String> {
    github::issue_title(Path::new(&repo_path), &owner, &name, number).await
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

/// State of the pull request the session reviews, for the sidebar's badge.
#[tauri::command]
pub async fn pull_request_state(app: AppHandle, session_id: Uuid) -> Result<github::PullRequestState, String> {
    let record = store::find_session(&app, session_id)?;
    let Some(pull_request) = record.pull_request else {
        return Err("failed to view pull request state: the session does not review one".into());
    };
    github::pull_request_state(&record.repo_path, pull_request.number).await
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
/// then the pull request's target branch, whose merge base with the base becomes the diff base, and the worktree works
/// on the pull request's own branch `pull_request_branch` rather than a new one, with `base_ref` naming that branch
/// locally or on a remote (`origin/<branch>`).
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
    pull_request_branch: Option<String>,
    workspace: Workspace,
) -> Result<SessionView, String> {
    ensure_new_id(&app, id)?;
    let repo_path = PathBuf::from(repo_path);
    let (worktree_path, branch, base_ref) = match workspace {
        Workspace::Worktree => {
            let branch = pull_request_branch.clone().unwrap_or_else(|| worktree_branch_name(&title, id));
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

    let mut keeps_branch = false;
    if workspace == Workspace::Worktree {
        if pull_request_branch.is_some() {
            keeps_branch = !git::worktree_add_on_branch(&repo_path, &branch, &worktree_path, &base_ref).await?;
        } else {
            git::worktree_add(&repo_path, &branch, &worktree_path, &base_commit).await?;
        }
        private_files::copy_into_worktree(&repo_path, &worktree_path).await?;
        dependencies::ensure(&app, repo_path.clone(), worktree_path.clone(), Install::Updating);
    }

    let mut record = SessionRecord::new(id, title, repo_path, worktree_path.clone(), branch, base_ref, base_commit);
    record.pull_request = pull_request;
    record.diff_base = diff_base;
    record.workspace = workspace;
    record.keeps_branch = keeps_branch;
    store::upsert_session(&app, record.clone())?;
    announce_sessions_changed(&app);
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: worktree_path }, AgentTransport::Local).await?;
    announce_sessions_changed(&app);
    Ok(view)
}

/// Starts the sub session `id` of `parent_id`: a fresh agent session in the parent's worktree, listed under the
/// parent in the UI, which picks the id so it can list the session before this returns. A sub chat opened from the
/// diff passes the `selection`, which goes into the system prompt. The sub session of a remote session runs on this
/// Mac as well, in the session's local worktree, which the session's file sync keeps in step with the VM.
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
    let parent = store::find_session(&app, parent_id)?;
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
    if record.worktree_path.is_dir() {
        dependencies::ensure(&app, record.repo_path.clone(), record.worktree_path.clone(), install_for(&app, &record));
    }
    if record.remote.is_some() {
        let activated = activate_remote(&app, &registry, &watchers, record).await;
        registry.end_start(id).await;
        finish_progress(&app, id);
        return activated;
    }

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
    // Fetched before anything stops: without a token the remote conversation keeps running as it is. A poller session's
    // relay keeps the tokens stored on its VM and takes this Mac's only where it stores none, so it needs no Claude
    // account selected.
    let token_input = match &record.remote {
        Some(target) => {
            let claude_token = if target.origin.keeps_vm_tokens() {
                accounts::active_token(&app).await?.unwrap_or_default()
            } else {
                remote_claude_token(&app, "clear session").await?
            };
            remote::token_input(&claude_token, github_token::read().await?.as_deref())
        }
        None => remote::token_input("", None),
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
            // The chat shows the connect's steps, which take a while even on a running VM.
            let instance = target.vm.instance.clone();
            let Some((ssh, target)) = start_remote_relay(&app, id, target, &progress_reporter(&app, id)).await? else {
                return Err(format!("failed to clear session: its VM {instance} no longer exists; send a prompt to continue the session here"));
            };
            let id_text = id.to_string();
            let mut args = vec!["clear", &id_text];
            args.extend(target.origin.relay_token_args());
            let status = remote::hunt_ctl_with_input(&ssh, &args, token_input.as_bytes()).await?;
            let acp_session_id = status["acpSessionId"].as_str().map(str::to_string).ok_or("failed to clear session: the relay reports no new session")?;
            store::update_session(&app, id, |stored| stored.acp_session_id = Some(acp_session_id))?
                .ok_or_else(|| "failed to clear session: the session was closed meanwhile".to_string())?;
            open_remote_relay(&app, &registry, &watchers, id, ssh, target).await
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
    let record = worktree_session(&app, id)?;
    let install = install_for(&app, &record);
    dependencies::ensure(&app, record.repo_path, record.worktree_path, install);
    announce_sessions_changed(&app);
    Ok(())
}

/// Connects the agent of `record` with `start` (its selection, if any, goes into the system prompt), stores the
/// ACP session ID it got, registers the live session and starts watching its worktree for the diagram; a remote
/// session starts syncing its files. The store may change while the agent starts (attribution, summary, or the session
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
    let status = remote::hunt_ctl(&ssh, &["wait", &id.to_string(), "--timeout", "180"]).await?;
    if let Some(at) = remote::relay_activity(&status, chrono::Utc::now()) {
        note_remote_activity(app, id, at);
    }
    // An adopted session's record learned its worktree on the VM meanwhile.
    let record = store::find_session(app, id)?;
    let acp_session_id = relay_conversation(&status, &record, "failed to connect the remote session")?;
    let ssh_args = ssh.stream_args(&relay_command(RELAY_SOCKET));
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
    let Some((ssh, vm)) = remote::start_session_vm(&gateway, id, &target.vm, &ssh_dir()?, progress).await? else {
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
    progress.step(RemoteStep::StartingAgent);
    // A running relay keeps its tokens, so it stays reachable with the local login selected.
    let token_input = local_token_input(app).await?;
    let id_text = id.to_string();
    let mut args = vec!["start", &id_text];
    args.extend(target.origin.relay_token_args());
    remote::hunt_ctl_with_input(&ssh, &args, token_input.as_bytes()).await?;
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
    let retrieved = remote::retrieve::Retrieved { acp_session_id: None, branch: None };
    finish_retrieval(app, registry, watchers, id, &target, retrieved, VmEnd::Delete).await?;
    Err(format!(
        "the VM {instance} of the session no longer exists; the session continues here with the files of its local worktree and the \
         conversation as of the agent's last finished turn, and can be handed off again"
    ))
}

/// The conversation a relay serves according to its `status`, else the one `record` knows; fails with `what` without
/// either.
fn relay_conversation(status: &serde_json::Value, record: &SessionRecord, what: &str) -> Result<String, String> {
    status["acpSessionId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| record.acp_session_id.clone())
        .ok_or_else(|| format!("{what}: its relay reports no conversation"))
}

/// The command that streams the ACP connection to the relay at `socket` (a `socat` address) as the user `agent`.
fn relay_command(socket: &str) -> String {
    remote::shell_command("sudo", &["-n", "-u", "agent", "socat", "-", socket])
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

/// The tokens for `hunt-ctl start` of a session: the Claude account selected now (empty with the local login) and the
/// keychain's GitHub token. A poller session's relay takes them only where its VM stores none (`relay_token_args`).
async fn local_token_input(app: &AppHandle) -> Result<String, String> {
    let claude_token = accounts::active_token(app).await?.unwrap_or_default();
    Ok(remote::token_input(&claude_token, github_token::read().await?.as_deref()))
}

/// The preview of the remote session `id`: the services of its repository's hunt.json with their state and URLs, and the
/// other ports that listen on its VM. A VM that is off has none; it is not started. A connected session proves a running
/// VM, so only an unconnected one asks the gateway.
#[tauri::command]
pub async fn preview_status(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid) -> Result<PreviewStatus, String> {
    let target = store::find_session(&app, id)?.remote.ok_or("failed to read the preview: the session runs locally")?;
    let domain = target
        .preview_domain
        .as_deref()
        .ok_or("failed to read the preview: the session was handed off without a preview domain; bring it back and hand it off again")?;
    let is_connected = registry.live.lock().await.contains_key(&id);
    if !is_connected && !gateway_api("read the preview").await?.is_vm_running(id).await? {
        return Ok(remote::preview::stopped_status());
    }
    let ssh = remote::ssh::Ssh::open(&target.vm, &ssh_dir()?).await?;
    let status = remote::hunt_ctl(&ssh, &["preview-status", &id.to_string()]).await?;
    remote::preview::parse_status(&status, id, domain)
}

/// The session VMs the gateway of the remote settings lists, running or not (see `remote::adoption::list_session_vms`),
/// for the start view's list of remote sessions.
#[tauri::command]
pub async fn list_session_vms() -> Result<Vec<remote::adoption::AdoptableSession>, String> {
    let gateway = gateway_api("list the remote sessions").await?;
    let listed = gateway.list_sessions().await?;
    let hello = gateway.hello();
    Ok(remote::adoption::list_session_vms(&listed, &hello.project, &hello.zone))
}

/// The remote secrets the gateway of `settings` keeps for every session VM, as names and hints.
#[tauri::command]
pub async fn list_remote_secrets(settings: VmSettings) -> Result<Vec<RemoteSecretSummary>, String> {
    gateway_of(&settings).await?.list_remote_secrets().await
}

/// Creates the remote secret `name` with `value` or replaces its value; session VMs get it when their session starts or
/// is handed off.
#[tauri::command]
pub async fn set_remote_secret(settings: VmSettings, name: String, value: String) -> Result<(), String> {
    validate_remote_secret_name(&name).map_err(|error| format!("failed to save the remote secret: {error}"))?;
    validate_remote_secret_value(&value).map_err(|error| format!("failed to save the remote secret {name}: {error}"))?;
    gateway_of(&settings).await?.set_remote_secret(&name, &value).await
}

/// Deletes the remote secret `name`; returns whether it existed.
#[tauri::command]
pub async fn delete_remote_secret(settings: VmSettings, name: String) -> Result<bool, String> {
    validate_remote_secret_name(&name).map_err(|error| format!("failed to delete the remote secret: {error}"))?;
    gateway_of(&settings).await?.delete_remote_secret(&name).await
}

/// Adopts the sessions of `ids` the gateway of `settings` lists that no local session knows (see `remote::adoption`):
/// each becomes a remote session of this Mac in the local checkout of its repository, found among `repo_paths` and the
/// repositories of the stored sessions, or without one when none matches. With or without `ids`, adopted sessions still
/// without a checkout get another chance to find one, and the remote sessions this Mac already has take the agent state
/// the listing reports for them. VMs this Mac deletes or deleted are left out. Returns the IDs of the new sessions.
#[tauri::command]
pub async fn adopt_session_vms(app: AppHandle, settings: VmSettings, repo_paths: Vec<String>, ids: Vec<Uuid>) -> Result<Vec<Uuid>, String> {
    settings.validate()?;
    let gateway = GatewayApi::open(&remote::gateway_vm(&settings).await?, &ssh_dir()?).await?;
    let preview_domain = gateway.preview_domain()?;
    let listed = gateway.list_sessions().await?;
    let sessions = store::load_sessions(&app)?;
    let mut known: HashSet<Uuid> = sessions.iter().map(|session| session.id).collect();
    known.extend(deleted_session_vms(&app));
    let hello = gateway.hello();
    let remote_targets: HashMap<Uuid, &RemoteTarget> = sessions.iter().filter_map(|session| Some((session.id, session.remote.as_ref()?))).collect();
    let listed_vms = remote::adoption::list_session_vms(&listed, &hello.project, &hello.zone);
    let agent_updates = remote::adoption::agent_updates(&listed_vms, &remote_targets);
    for (id, agent) in agent_updates.iter().cloned() {
        store::update_session(&app, id, |stored| {
            if let Some(target) = stored.remote.as_mut() {
                target.agent = agent;
            }
        })?;
    }
    // A VM the gateway moved to another zone keeps its name; the stored session follows it there.
    let vm_updates = remote::adoption::vm_updates(&listed_vms, &remote_targets);
    for (id, vm) in vm_updates.iter().cloned() {
        store::update_session(&app, id, |stored| {
            if let Some(target) = stored.remote.as_mut() {
                target.vm = vm;
            }
        })?;
    }
    let mut has_changed = !agent_updates.is_empty() || !vm_updates.is_empty();
    let adoptable: Vec<_> = remote::adoption::sessions_to_adopt(&listed, &hello.project, &hello.zone, &known)
        .into_iter()
        .filter(|session| ids.contains(&session.id))
        .collect();
    let without_checkout: Vec<&SessionRecord> = sessions
        .iter()
        .filter(|session| session.remote.as_ref().is_some_and(RemoteTarget::is_adopted) && session.repo_path.as_os_str().is_empty())
        .collect();
    if adoptable.is_empty() && without_checkout.is_empty() {
        if has_changed {
            announce_sessions_changed(&app);
        }
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
    has_changed |= !adopted.is_empty();
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

/// Opens the terminal `terminal_id` with `cols` × `rows` cells showing `process` on the VM of the remote session `id`.
/// The caller picks the ID so it can listen before the first output arrives: `terminal:output` and finally
/// `terminal:exit` go to the calling window only, which owns the terminal. A VM that is off is not started.
#[tauri::command]
pub async fn open_terminal(
    app: AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, SessionRegistry>,
    terminals: State<'_, TerminalRegistry>,
    id: Uuid,
    terminal_id: Uuid,
    process: TerminalTarget,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let target = running_remote(&app, &registry, id, "open the terminal").await?;
    let args = remote::terminal::attach_args(&target, &process, terminal_id, &ssh_dir()?).await?;
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

/// The windows of the tmux session `app` on the VM of the remote session `id`, in their order. A VM that is off has
/// none; it is not started.
#[tauri::command]
pub async fn terminal_windows(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid) -> Result<Vec<TmuxWindow>, String> {
    let (target, is_running) = remote_vm_state(&app, &registry, id, "list the terminal windows").await?;
    if !is_running {
        return Ok(Vec::new());
    }
    remote::terminal::list_windows(&Ssh::open(&target.vm, &ssh_dir()?).await?).await
}

/// Starts a shell in a new tmux window on the VM of the remote session `id` and returns the window's ID.
#[tauri::command]
pub async fn open_shell_window(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid) -> Result<String, String> {
    let target = running_remote(&app, &registry, id, "open a shell").await?;
    remote::terminal::open_shell_window(&Ssh::open(&target.vm, &ssh_dir()?).await?).await
}

/// Ends the tmux window `window_id` on the VM of the remote session `id` and the processes in it.
#[tauri::command]
pub async fn close_terminal_window(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, window_id: String) -> Result<(), String> {
    let target = running_remote(&app, &registry, id, "close the terminal window").await?;
    remote::terminal::kill_window(&Ssh::open(&target.vm, &ssh_dir()?).await?, &window_id).await
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

/// Ends the terminal `terminal_id`; the process it shows keeps running.
#[tauri::command]
pub fn close_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid) {
    terminals.close(terminal_id);
}

/// What Hunt tells the agent of a remote session on top of its usual system prompt addition, whatever the repository.
const REMOTE_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/prompts/remote.system-prompt.md"));

/// The Git part of `REMOTE_PROMPT` when Hunt hands the user's GitHub token to the agent on the VM.
const REMOTE_GIT_PUSH_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/prompts/git-push.system-prompt.md"));

/// The Git part of `REMOTE_PROMPT` without a GitHub token.
const REMOTE_GIT_LOCAL_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/prompts/git-local.system-prompt.md"));

/// What Hunt appends to the system prompt of a remote session: `base`, the usual addition, then `REMOTE_PROMPT`, the Git
/// part that fits whether the agent has the user's GitHub token, the section on the repository's services that
/// `hunt-ctl session-config` writes (`services_prompt`, skipped when empty) and the repository's hunt.agent.md under
/// a heading of its own. The gateway's poller (`apps/gateway/src/swfPlan.ts`) composes the prompt of its sessions the
/// same way, with an empty `base` and the shared question part and its swf workflow before the services.
fn remote_system_prompt(base: &str, has_github_token: bool, services_prompt: &str, agent_md: Option<&str>) -> String {
    let git_prompt = if has_github_token { REMOTE_GIT_PUSH_PROMPT } else { REMOTE_GIT_LOCAL_PROMPT };
    let mut prompt = format!("{base}\n\n{REMOTE_PROMPT}\n{git_prompt}");
    let services_prompt = services_prompt.trim();
    if !services_prompt.is_empty() {
        prompt.push_str(&format!("\n{services_prompt}\n"));
    }
    if let Some(text) = agent_md.map(str::trim).filter(|text| !text.is_empty()) {
        prompt.push_str(&format!("\n### The repository's hunt.agent.md\n{text}\n"));
    }
    prompt
}

/// Brings up the VM the session `id` moves to while its agent still works here (see `remote::handoff::prepare`), so the
/// handoff after the agent's turn finds it ready. The session and its agent stay as they are; the VM stays on failure,
/// for the handoff to retry.
#[tauri::command]
pub async fn prepare_hand_off(app: AppHandle, id: Uuid, settings: VmSettings) -> Result<(), String> {
    let record = local_session(&app, id)?;
    ensure_hand_off_allowed(&record)?;
    settings.validate()?;
    let prepared = async {
        let gateway = remote::gateway_vm(&settings).await?;
        store::update_session(&app, id, |stored| stored.leftover_vm = Some(gateway.session_vm(id)))?;
        let ssh_dir = ssh_dir()?;
        let request = remote::handoff::VmRequest {
            hunt_session_id: id,
            title: &record.title,
            worktree: &record.worktree_path,
            gateway: &gateway,
            machine_type: settings.machine_type.as_deref(),
            ssh_dir: &ssh_dir,
        };
        remote::handoff::prepare(&request, &progress_reporter(&app, id)).await
    }
    .await;
    finish_progress(&app, id);
    prepared
}

/// Moves the session `id` to a VM of its own, which the gateway of `settings` provisions: its agent stops here, its
/// branch, uncommitted work, transcript and the private files its hunt.json names go to the VM, and the chat
/// continues with the agent there. Its sub chats stay on this Mac: their agents stop while the worktree moves and start
/// again once they are opened. On failure the session stays local, its agent starts again and the VM stays for the next
/// attempt.
#[tauri::command]
pub async fn hand_off_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
    settings: VmSettings,
) -> Result<SessionView, String> {
    let record = local_session(&app, id)?;
    ensure_hand_off_allowed(&record)?;
    settings.validate()?;
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
    // The sub chats' agents stop while the worktree moves, and their starts stay claimed until the handoff ended, so that
    // opening one meanwhile waits until the worktree settled.
    let child_ids: Vec<Uuid> = store::load_sessions(&app)?.into_iter().filter(|session| session.parent_id == Some(id)).map(|session| session.id).collect();
    let mut claimed_children: Vec<Uuid> = Vec::new();
    for child_id in child_ids {
        stop_agent_and_wait(&app, &registry, &watchers, &permissions, child_id).await;
        if !registry.claim_start(child_id).await {
            end_starts(&registry, claimed_children.into_iter()).await;
            return Err("failed to hand off the session: one of its sub chats was started again meanwhile".into());
        }
        claimed_children.push(child_id);
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    if !registry.claim_start(id).await {
        end_starts(&registry, claimed_children.into_iter()).await;
        return Err("failed to hand off the session: its agent was started again meanwhile".into());
    }

    let handed_off = async {
        let gateway = remote::gateway_vm(&settings).await?;
        store::update_session(&app, id, |stored| stored.leftover_vm = Some(gateway.session_vm(id)))?;
        let context_prompt = record.selection.as_ref().map(SelectionContext::to_system_prompt);
        let local_agent_md = remote::read_agent_md(&record.worktree_path)?;
        let base_prompt = system_prompt_append(&app, id, context_prompt);
        let has_github_token = github_token.is_some();
        let system_prompt = |services_prompt: &str, agent_md: Option<&str>| {
            remote_system_prompt(&base_prompt, has_github_token, services_prompt, agent_md.or(local_agent_md.as_deref()))
        };
        let token_input = remote::token_input(&claude_token, github_token.as_deref());
        let (ssh_dir, claude_dir) = (ssh_dir()?, claude_dir()?);
        let memory_base = memory_base_path(&app, id)?;
        let request = remote::handoff::HandoffRequest {
            hunt_session_id: id,
            title: &record.title,
            worktree: &record.worktree_path,
            acp_session_id: record.acp_session_id.as_deref(),
            gateway: &gateway,
            machine_type: settings.machine_type.as_deref(),
            ssh_dir: &ssh_dir,
            claude_dir: &claude_dir,
            memory_base: &memory_base,
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
            // The first sync takes the VM's files as they are after the handoff.
            sync::forget(&app, id);
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
    // The sub chats start again here when they are opened next.
    end_starts(&registry, claimed_children.into_iter()).await;
    finish_progress(&app, id);
    announce_sessions_changed(&app);
    activated
}

/// Gives back the starts of the agents of `ids` claimed with `SessionRegistry::claim_start`.
async fn end_starts(registry: &SessionRegistry, ids: impl Iterator<Item = Uuid>) {
    for id in ids {
        registry.end_start(id).await;
    }
}

/// Rejects sessions that cannot run on a VM: sub sessions, which run here in their session's worktree, sessions in the
/// repository's own checkout, and pull request reviews.
fn ensure_hand_off_allowed(record: &SessionRecord) -> Result<(), String> {
    if record.parent_id.is_some() {
        return Err("failed to hand off the session: a sub session runs here in its session's worktree".into());
    }
    if record.workspace != Workspace::Worktree {
        return Err("failed to hand off the session: sessions in the repository's own checkout stay local".into());
    }
    if record.pull_request.is_some() {
        return Err("failed to hand off the session: pull request reviews stay local".into());
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
    ensure_retrievable(&store::find_session(&app, id)?)?;
    // The sub chats' agents stop while the worktree comes back and start again once they are opened.
    for child in store::load_sessions(&app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent_and_wait(&app, &registry, &watchers, &permissions, child.id).await;
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    // The first sync of an adopted session may have created its local worktree meanwhile.
    let record = store::find_session(&app, id)?;
    ensure_retrievable(&record)?;
    let target = record.remote.clone().ok_or("failed to retrieve the session: it runs locally")?;
    let adopted_into = (target.is_adopted() && !record.worktree_path.is_dir()).then_some(record.repo_path.as_path());
    if !registry.claim_start(id).await {
        return Err("failed to retrieve the session: its agent was started again meanwhile".into());
    }

    let activated = async {
        let (ssh_dir, claude_dir) = (ssh_dir()?, claude_dir()?);
        let memory_base = memory_base_path(&app, id)?;
        let sync_manifest = sync::manifest_path(&app, id)?;
        let sync_base_ref = target.start_ref(id);
        let local_ids = store::sub_chat_acp_ids(&app, id)?;
        let gateway = gateway_vm("retrieve the session").await?;
        let request = remote::retrieve::RetrieveRequest {
            hunt_session_id: id,
            worktree: &record.worktree_path,
            target: &target,
            gateway: &gateway,
            ssh_dir: &ssh_dir,
            claude_dir: &claude_dir,
            memory_base: &memory_base,
            sync_manifest: &sync_manifest,
            sync_base_ref: &sync_base_ref,
            adopted_into,
            local_ids: &local_ids,
        };
        let retrieved = remote::retrieve::retrieve(request, &progress_reporter(&app, id)).await?;
        finish_retrieval(&app, &registry, &watchers, id, &target, retrieved, VmEnd::Delete).await
    }
    .await;
    registry.end_start(id).await;
    finish_progress(&app, id);
    announce_sessions_changed(&app);
    activated
}

/// Continues the remote session `id` here while its VM cannot be reached (Settings → Remote VM unreachable, or offline):
/// the session becomes local with the files of its local worktree as the last sync left them and the conversation as of
/// the agent's last finished turn, and this Mac is the only side that writes. What the agent did on the VM since is
/// saved as `refs/hunt/<id>/abandoned` once the VM can be reached, and the VM is deleted then.
#[tauri::command]
pub async fn continue_locally(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    let target = record.remote.clone().ok_or("failed to continue the session here: it runs here already")?;
    if record.parent_id.is_some() {
        return Err("failed to continue the session here: continue its remote session instead".into());
    }
    if sync::has_channel(&app, id) {
        return Err("failed to continue the session here: it is connected to its VM; bring it back instead".into());
    }
    if !record.worktree_path.is_dir() {
        return Err("failed to continue the session here: nothing of it is on this Mac yet".into());
    }
    for child in store::load_sessions(&app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent_and_wait(&app, &registry, &watchers, &permissions, child.id).await;
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    if !registry.claim_start(id).await {
        return Err("failed to continue the session here: its agent was started again meanwhile".into());
    }
    remote::sync::clear_staging(&record.worktree_path);
    let retrieved = remote::retrieve::Retrieved { acp_session_id: None, branch: None };
    let continued = finish_retrieval(&app, &registry, &watchers, id, &target, retrieved, VmEnd::PreserveAndDelete).await;
    registry.end_start(id).await;
    announce_sessions_changed(&app);
    continued
}

/// Whether the local worktree of the remote session `id`, or of the remote session whose sub chat `id` is, may change
/// (`session::link`); `None` for a local session.
#[tauri::command]
pub async fn remote_link(app: AppHandle, id: Uuid) -> Result<Option<Link>, String> {
    Ok(link::current(&app, id).await)
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
    retrieved: remote::retrieve::Retrieved,
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
    remote::retrieve::restore_mode(&claude_dir()?, &record.worktree_path, target.restored_mode(), &acp_session_ids)
        .map_err(|error| format!("failed to restore the permission mode of the retrieved session's transcript: {error}"))
}

/// Refuses to bring back `record` when it runs locally, or when it is an adopted session without a local worktree and
/// there is no local checkout of its repository to create one in.
fn ensure_retrievable(record: &SessionRecord) -> Result<(), String> {
    let target = record.remote.as_ref().ok_or("failed to retrieve the session: it runs locally")?;
    if target.is_adopted() && !record.worktree_path.is_dir() && record.repo_path.as_os_str().is_empty() {
        return Err(format!(
            "failed to bring back the session: there is no local checkout of {}; start a session in one, then refresh the remote sessions",
            target.repo
        ));
    }
    Ok(())
}

/// How the dependencies of `record`'s worktree install: without touching the lockfile while its files sync with a VM.
fn install_for(app: &AppHandle, record: &SessionRecord) -> Install {
    if remote_host(app, record).is_some() {
        Install::Frozen
    } else {
        Install::Updating
    }
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

/// Whether this app run started the deletions that failed before; they wait for the first remote settings.
static HAS_STARTED_PENDING_CLEANUPS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Takes the remote settings from the main window, at its start and on every change; `None` while they are incomplete.
/// Commands on stored remote sessions reach the gateway of these settings. Invalid settings count as none.
#[tauri::command]
pub fn set_remote_settings(app: AppHandle, settings: Option<VmSettings>) -> Result<(), String> {
    let validated = settings.as_ref().map_or(Ok(()), VmSettings::validate);
    let settings = settings.filter(|_| validated.is_ok());
    let is_set = settings.is_some();
    *REMOTE_SETTINGS.lock().unwrap() = settings;
    if is_set && !HAS_STARTED_PENDING_CLEANUPS.swap(true, std::sync::atomic::Ordering::SeqCst) {
        run_pending_cleanups(&app);
    }
    validated
}

/// The gateway of the remote settings; fails with `what` (the action) while there are none.
async fn gateway_vm(what: &str) -> Result<VmRef, String> {
    let settings = REMOTE_SETTINGS
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| format!("failed to {what}: set the project under Settings → Remote VM"))?;
    remote::gateway_vm(&settings).await
}

/// The gateway API of the remote settings, for `what` (the action).
pub(crate) async fn gateway_api(what: &str) -> Result<GatewayApi, String> {
    GatewayApi::open(&gateway_vm(what).await?, &ssh_dir()?).await
}

/// The gateway API of the project in `settings`, which the calling window passes along with the call.
async fn gateway_of(settings: &VmSettings) -> Result<GatewayApi, String> {
    settings.validate()?;
    GatewayApi::open(&remote::gateway_vm(settings).await?, &ssh_dir()?).await
}

/// A session VM whose deletion failed, e.g. while the Mac was offline; Hunt deletes it through the gateway at its next
/// start. Entries of older releases name the VM all sessions shared and are dropped.
#[derive(Clone, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PendingCleanup {
    vm: VmRef,
    hunt_session_id: Uuid,
    /// Set when the session continued here without reaching its VM: what the agent left there is saved first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preserve: Option<Preserve>,
}

/// Where the state a VM is deleted with goes first: the local worktree its snapshot is fetched into, from the session's
/// worktree on the VM.
#[derive(Clone, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Preserve {
    worktree: PathBuf,
    remote_worktree: String,
}

/// How often a cleanup that saves the VM's state first is tried again while Hunt runs.
const PRESERVE_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

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

/// Forgets what this Mac keeps for the remote session `id` on `target` (the base of its memory merge) and, with
/// `delete_vm`, deletes its VM. Failures are only logged.
async fn forget_remote(app: &AppHandle, target: &RemoteTarget, id: Uuid, delete_vm: bool) {
    if let Ok(path) = memory_base_path(app, id) {
        let _ = std::fs::remove_file(path);
    }
    link::forget(app, id);
    if delete_vm {
        delete_session_vm(app, &target.vm, id).await;
    }
}

/// Deletes the VM of session `id` on `target` once it can be reached, after saving what its agent left there into the
/// local `worktree` (`remote::retrieve::preserve`); until then it is tried every `PRESERVE_RETRY` and at each start of
/// Hunt.
fn preserve_and_delete_vm(app: &AppHandle, target: &RemoteTarget, id: Uuid, worktree: &Path) {
    let preserve = Preserve { worktree: worktree.to_path_buf(), remote_worktree: target.worktree_path.display().to_string() };
    let cleanup = PendingCleanup { vm: target.vm.clone(), hunt_session_id: id, preserve: Some(preserve) };
    change_pending_cleanups(app, |cleanups| {
        if !cleanups.contains(&cleanup) {
            cleanups.push(cleanup.clone());
        }
    });
    DELETED_SESSION_VMS.lock().unwrap().push(id);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match run_cleanup(&cleanup).await {
                Ok(()) => {
                    change_pending_cleanups(&app, |pending| pending.retain(|other| *other != cleanup));
                    return;
                }
                Err(error) => eprintln!("saving and deleting the VM {} of session {id} failed, retrying: {error}", cleanup.vm.instance),
            }
            tokio::time::sleep(PRESERVE_RETRY).await;
            let is_pending = pending_cleanups_path(&app).is_ok_and(|path| {
                let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
                read_pending_cleanups(&path).contains(&cleanup)
            });
            if !is_pending {
                return;
            }
        }
    });
}

/// Deletes the VM of `cleanup` through the gateway, saving its state first when the cleanup asks for it; a VM that no
/// longer exists counts as done.
async fn run_cleanup(cleanup: &PendingCleanup) -> Result<(), String> {
    let id = cleanup.hunt_session_id;
    if let Some(preserve) = &cleanup.preserve {
        let gateway = gateway_vm("save the session's VM").await?;
        if let Some((ssh, _)) = remote::start_session_vm(&gateway, id, &cleanup.vm, &ssh_dir()?, &|_| {}).await? {
            let saved = remote::retrieve::preserve(&ssh, id, &preserve.worktree, &preserve.remote_worktree).await?;
            eprintln!("saved what session {id} left on its VM {} as {saved}", cleanup.vm.instance);
        }
    }
    gateway_api("delete the session's VM").await?.delete_vm(id).await
}

/// Sessions whose VM this run of Hunt asked the gateway to delete. The VM stays listed while it shuts down, and an
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
    let deleted = async { gateway_api("delete the session's VM").await?.delete_vm(id).await }.await;
    if let Err(error) = deleted {
        eprintln!("deleting the VM {} of session {id} failed, retrying at the next start: {error}", vm.instance);
        let cleanup = PendingCleanup { vm: vm.clone(), hunt_session_id: id, preserve: None };
        change_pending_cleanups(app, |cleanups| {
            if !cleanups.contains(&cleanup) {
                cleanups.push(cleanup);
            }
        });
    }
}

/// Deletes the session VMs whose deletion failed before through the gateway, in the background; `set_remote_settings`
/// runs it once per app run.
fn run_pending_cleanups(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(path) = pending_cleanups_path(&app) else { return };
        let cleanups = {
            let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
            read_pending_cleanups(&path)
        };
        if cleanups.is_empty() {
            return;
        }
        let gateway = match gateway_api("delete the session VMs left over").await {
            Ok(gateway) => gateway,
            Err(error) => {
                eprintln!("deleting the session VMs left over failed, retrying at the next start: {error}");
                return;
            }
        };
        for cleanup in cleanups {
            let id = cleanup.hunt_session_id;
            let is_done = if !remote::vm::is_session_vm(&cleanup.vm, id) {
                eprintln!("dropping the cleanup of session {id} on the shared VM {}", cleanup.vm.instance);
                true
            } else if cleanup.preserve.is_some() {
                match run_cleanup(&cleanup).await {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("saving and deleting the VM {} of session {id} failed again, retrying at the next start: {error}", cleanup.vm.instance);
                        false
                    }
                }
            } else {
                match gateway.delete_vm(id).await {
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
    sync::stop_and_wait(app, id).await;
}

/// How `close_session` ends a session (mirror of `SessionEnding` in src/ipc/types.ts).
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Ending {
    /// Only the agent stops; the session stays listed.
    Stop,
    /// The session goes with its sub chats, worktree, branch and, for a remote session, its VM.
    Delete,
    /// Like `Delete`, but a remote session's VM stays for the other people working on it and for a later adoption.
    Forget,
}

#[tauri::command]
pub async fn close_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    lsp: State<'_, LspRegistry>,
    id: Uuid,
    ending: Ending,
) -> Result<(), String> {
    let result = end_session(&app, &registry, &watchers, &permissions, &lsp, id, ending).await;
    announce_sessions_changed(&app);
    result
}

/// Stops the agent of `id` and, unless `ending` is `Stop`, deletes the session record together with its sub chats,
/// worktree and branch; a session in the repository's own checkout only loses its records. A remote session's VM
/// goes only with `Delete`.
async fn end_session(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    permissions: &PermissionRegistry,
    lsp: &LspRegistry,
    id: Uuid,
    ending: Ending,
) -> Result<(), String> {
    stop_agent(app, registry, watchers, permissions, id).await;
    if ending == Ending::Stop {
        return Ok(());
    }

    let record = store::find_session(app, id)?;
    // A sub chat only owns its record; the worktree belongs to its parent.
    if record.parent_id.is_some() {
        return store::remove_session(app, id);
    }

    for child in store::load_sessions(app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent(app, registry, watchers, permissions, child.id).await;
        store::remove_session(app, child.id)?;
    }
    if let Some(target) = &record.remote {
        sync::stop_and_wait(app, id).await;
        forget_remote(app, target, id, ending == Ending::Delete).await;
        sync::forget(app, id);
        // An adopted session that never synced has nothing here but its record.
        if target.is_adopted() && !record.worktree_path.is_dir() {
            return store::remove_session(app, id);
        }
    } else if let Some(leftover) = &record.leftover_vm {
        if ending == Ending::Delete {
            delete_session_vm(app, leftover, id).await;
        }
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
        delete_created_branch(&record).await;
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

/// Deletes the branch of the worktree session `record` when Hunt created it; a branch that existed before the session (a
/// reviewed pull request's) stays. A failure is only logged.
async fn delete_created_branch(record: &SessionRecord) {
    if record.keeps_branch {
        return;
    }
    if let Err(error) = git::delete_branch(&record.repo_path, &record.branch).await {
        eprintln!("deleting branch {} of session {} failed: {error}", record.branch, record.id);
    }
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

/// Ends the agent process of `id` (if any) and drops everything bound to it.
async fn stop_agent(app: &AppHandle, registry: &SessionRegistry, watchers: &WatcherRegistry, permissions: &PermissionRegistry, id: Uuid) {
    drop_pending_permissions(permissions, id);
    if let Some(mut live) = registry.live.lock().await.remove(&id) {
        live.shutdown();
    }
    graph::unwatch(watchers, id);
    attribution::forget_session(app, id);
    sync::detach(app, id);
}

/// Sends one user turn (the text plus the image files in `images`) and resolves with the stop reason once the
/// agent finished. A sub chat about writing a file (a selection with a task) gets the file's current content
/// ahead of the text, so the agent always sees the version on disk; a remote session's local edits reach its VM
/// first. The finished turn is handed to the background summarizer, which refreshes the session's summary and title.
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
    if let Some(selection) = record.selection.as_ref().filter(|selection| selection.task.is_some()) {
        if let Ok(target) = worktree_file(&record, &selection.path) {
            // The agent on a VM knows the file by its path there; the local copy holds the same content once synced.
            let shown_as = match &record.remote {
                Some(host) => host.worktree_path.join(&selection.path),
                None => target.clone(),
            };
            if let Some(block) = file_context_block(&target, &shown_as) {
                blocks.insert(0, block);
            }
        }
    }
    // The agent on a VM sees the files saved here before it reads the prompt.
    sync::flush(&app, id).await;
    run_turn(&app, &registry, id, blocks, None).await
}

/// The current text of the file at `target` as an embedded resource block, which the agent receives as a context
/// block tagged with the URI of `shown_as` (the path the agent knows the file by); none when there is no readable file
/// there (yet).
fn file_context_block(target: &Path, shown_as: &Path) -> Option<ContentBlock> {
    let text = std::fs::read_to_string(target).ok()?;
    let uri = format!("file://{}", shown_as.display());
    Some(ContentBlock::Resource(EmbeddedResource::new(EmbeddedResourceResource::TextResourceContents(TextResourceContents::new(text, uri)))))
}

/// Asks the agent to rewrite the diagram of `diagram_type` with its standard prompt, extended by the user's free-text
/// `instructions` for this one run. The turn runs with the agent config values `model` and `effort` from the diagram
/// settings; afterwards the agent gets back the model and effort the chat showed before. The turn is recorded as
/// hidden, so the chat shows neither the prompt text nor the agent's output, and it leaves the session summary alone.
/// The agent of a remote session diffs against the session's diff base as a commit, which its VM has too; the local
/// edits, the schema and the diagram as the user edited it go there before the turn and the diagram comes back after
/// it.
#[tauri::command]
pub async fn refresh_graph(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    diagram_type: graph::DiagramType,
    instructions: String,
    model: String,
    effort: String,
) -> Result<String, String> {
    let record = worktree_session(&app, id)?;
    let is_remote = record.remote.is_some();
    let diff_base = if is_remote { git::rev_parse(&record.worktree_path, record.diff_base()).await? } else { record.diff_base().to_string() };
    if is_remote {
        sync::flush(&app, id).await;
        let mut pushed = vec![diagram_type.schema_path().to_string()];
        if graph::diagram_path(&record.worktree_path, diagram_type).exists() {
            pushed.push(diagram_type.path());
        }
        sync::copy_files(&app, id, Direction::Push, &pushed).await?;
    }
    let prompt = graph::refresh_prompt(diagram_type, &crate::preferences::ai_language(&app), &diff_base, instructions.trim());
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
    if is_remote {
        sync::copy_files(&app, id, Direction::Pull, &[diagram_type.path()]).await?;
    }
    Ok(stop_reason)
}

/// Agent config options a diagram refresh switches for its turn.
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

    related::set_turn(app, id, true);
    let response = connection.send_request(PromptRequest::new(acp_session_id, blocks)).block_task().await;
    related::set_turn(app, id, false);
    let response = response.map_err(|error| format!("failed to send the prompt: {error}"))?;

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

/// The image files among `paths`, e.g. files dropped into the chat, as attachments; other files are left out.
#[tauri::command]
pub fn image_files(paths: Vec<String>) -> Vec<Screenshot> {
    screenshots::image_files(&paths)
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
    let record = worktree_session(&app, id)?;
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
    let record = worktree_session(&app, id)?;
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
fn worktree_session(app: &AppHandle, id: Uuid) -> Result<SessionRecord, String> {
    let record = store::find_session(app, id)?;
    if record.remote.is_some() && !record.worktree_path.is_dir() {
        return Err(format!("failed to use the worktree of session {id}: it has no local worktree yet; it gets one once Hunt reached its VM"));
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
    link::ensure_writable(&app, id, &format!("save {path}"))?;
    let (record, target) = session_file(&app, id, &path)?;
    attribution::record_write(&app, &record.worktree_path, id, || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, content).map_err(|error| format!("failed to write {path}: {error}"))
    })
    .await?;
    store::add_touched_files(&app, id, std::slice::from_ref(&path))?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

/// Moves the file at `from` to `to` inside the session's worktree, creating `to`'s folders; both paths must be
/// relative and must not leave the worktree, and nothing may exist at `to` yet. Both count as the session's own
/// changes, like an edit by its agent.
#[tauri::command]
pub async fn move_path(app: AppHandle, id: Uuid, from: String, to: String) -> Result<(), String> {
    link::ensure_writable(&app, id, &format!("move {from}"))?;
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
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

/// Deletes the file or folder (recursively) at `path` inside the session's worktree; `path` must be relative and
/// must not leave the worktree. The deleted files count as the session's own changes, like an edit by its agent.
#[tauri::command]
pub async fn delete_path(app: AppHandle, id: Uuid, path: String) -> Result<(), String> {
    link::ensure_writable(&app, id, &format!("delete {path}"))?;
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
    sync::note_local_change(&app, id);
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
    link::ensure_writable(&app, id, &format!("revert {path}"))?;
    let (record, _) = session_file(&app, id, &path)?;
    git::revert_file(&record.worktree_path, record.diff_base(), &path).await?;
    store::forget_touched_files(&app, &record.worktree_path, std::slice::from_ref(&path))?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn shelve_files(app: AppHandle, id: Uuid, paths: Vec<String>, name: String) -> Result<(), String> {
    link::ensure_writable(&app, id, "shelve the files")?;
    let record = worktree_session(&app, id)?;
    git::shelve_files(&record.worktree_path, &paths, &name).await?;
    store::forget_touched_files(&app, &record.worktree_path, &paths)?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn list_shelves(app: AppHandle, id: Uuid) -> Result<Vec<Shelf>, String> {
    let record = worktree_session(&app, id)?;
    git::list_shelves(&record.worktree_path, &record.branch).await
}

/// Restores a shelf into the worktree; `keep` leaves the shelf in place instead of dropping it.
#[tauri::command]
pub async fn unshelve(app: AppHandle, id: Uuid, reference: String, keep: bool) -> Result<(), String> {
    link::ensure_writable(&app, id, "unshelve the files")?;
    let record = worktree_session(&app, id)?;
    git::unshelve(&record.worktree_path, &reference, keep).await?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn drop_shelf(app: AppHandle, id: Uuid, reference: String) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    git::drop_shelf(&record.worktree_path, &reference).await
}

/// Commits exactly `paths` with `message` on the session's current branch: here, or on the VM of a remote session, whose
/// local branch then follows to the new commit.
#[tauri::command]
pub async fn commit_files(app: AppHandle, id: Uuid, paths: Vec<String>, message: String) -> Result<(), String> {
    link::ensure_writable(&app, id, "commit")?;
    let record = worktree_session(&app, id)?;
    match remote_host(&app, &record) {
        None => git::commit_files(&record.worktree_path, &paths, &message).await?,
        Some((owner, _)) => commit_on_vm(&app, owner, &record.worktree_path, &paths, &message).await?,
    }
    store::forget_touched_files(&app, &record.worktree_path, &paths)
}

/// Commits `paths` of the remote session `id` on its VM (`remote::commit`) while no sync of it runs, after one sent the
/// local edits there; refuses when one of the files could not reach the VM. The local branch then follows the VM's new
/// commit (`sync::follow_head`).
async fn commit_on_vm(app: &AppHandle, id: Uuid, worktree: &Path, paths: &[String], message: &str) -> Result<(), String> {
    sync::exclusive(app, id, |outcome| async move {
        let unsynced: Vec<&String> = outcome
            .iter()
            .flat_map(|outcome| &outcome.conflicts)
            .filter(|line| paths.iter().any(|path| line.starts_with(&format!("{path}: "))))
            .collect();
        if !unsynced.is_empty() {
            let lines = unsynced.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n");
            return Err(format!("failed to commit on the VM: these files did not reach it:\n{lines}"));
        }
        let target = store::find_session(app, id)?.remote.ok_or("failed to commit on the VM: the session runs locally now")?;
        let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
        remote::commit::commit(&ssh, id, worktree, paths, message).await?;
        sync::follow_head(app, id, &ssh, &target, worktree).await?;
        Ok(())
    })
    .await
}

/// Pushes the session's commits from here, with this Mac's Git credentials, to the branch on `origin` the session was
/// created from (`push_target`), after a rebase onto that branch when it moved on; the session's own branch never
/// reaches `origin`. A remote session's local branch first catches up with the commit its VM has checked out, and the
/// rebase runs on the VM (`push_followed`). Only a poller session's branch is pushed from its VM under its own name with
/// the poller's stored token, so that the push shows the poller's GitHub App like the rest of what its agent does on
/// GitHub.
#[tauri::command]
pub async fn push_branch(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let Some((owner, target)) = remote_host(&app, &record) else {
        return git::push_branch(&record.worktree_path, &push_target(&record, None)).await;
    };
    if target.origin.keeps_vm_tokens() {
        let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
        remote::commit::push_stored(&ssh, owner).await?;
        // The local remote-tracking ref learns about the VM's push, so `unpushed_commit_count` stops offering one.
        if let Err(error) = git::fetch_branch(&record.worktree_path, &target.branch).await {
            eprintln!("failed to fetch the pushed branch {} of session {id}: {error}", target.branch);
        }
        return Ok(());
    }
    push_followed(&app, owner, &record.worktree_path, &push_target(&record, Some(&target))).await
}

/// The branch on `origin` a push of the session `record`, which runs on the VM `remote` when any, lands on: the branch
/// the session was created from, named without its remote when the base was `origin/<branch>`, except for a poller
/// session, whose VM pushes its branch under its own name.
fn push_target(record: &SessionRecord, remote: Option<&RemoteTarget>) -> String {
    if remote.is_some_and(|target| target.origin.keeps_vm_tokens()) {
        return record.branch.clone();
    }
    record.base_ref.strip_prefix("origin/").unwrap_or(&record.base_ref).to_string()
}

/// Number of commits `push_branch` would publish, counted in the session's local worktree against the branch the push
/// lands on, as fetched last; a remote session's local branch follows its VM's commits.
#[tauri::command]
pub async fn unpushed_commit_count(app: AppHandle, id: Uuid) -> Result<u32, String> {
    let record = worktree_session(&app, id)?;
    let remote = remote_host(&app, &record).map(|(_, target)| target);
    git::unpushed_commit_count(&record.worktree_path, &push_target(&record, remote.as_ref())).await
}

/// Pushes the commits of the remote session `id`, checked out in its local worktree `worktree`, to the branch `target`
/// on `origin` from here, while no sync of the session runs: the local branch catches up with the VM's commit
/// (`sync::follow_head`); when `origin/<target>` moved on, the branch is rebased onto it here, with the local Git
/// identity, and the VM's branch moves to the rebased commit (`remote::commit::move_vm_head`), which the local branch
/// follows from then on; then `HEAD` is pushed. A local branch that holds a commit the VM lacks fails the push with the
/// message of the follow.
async fn push_followed(app: &AppHandle, id: Uuid, worktree: &Path, target: &str) -> Result<(), String> {
    sync::exclusive(app, id, |_| async move {
        let remote = store::find_session(app, id)?.remote.ok_or("failed to push: the session runs locally now")?;
        let ssh = Ssh::open(&remote.vm, &ssh_dir()?).await?;
        sync::follow_head(app, id, &ssh, &remote, worktree).await?;
        git::fetch_branch(worktree, target).await?;
        if git::is_behind_origin(worktree, target).await {
            git::rebase_onto_origin(worktree, target).await?;
            let head = remote::commit::move_vm_head(&ssh, id, &remote, worktree).await?;
            store::update_session(app, id, |stored| {
                if let Some(remote) = stored.remote.as_mut() {
                    remote.handoff_head = head;
                }
            })?;
        }
        git::push_head(worktree, target).await
    })
    .await
}

#[tauri::command]
pub async fn open_worktree_in_webstorm(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
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
    let record = worktree_session(&app, id)?;
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

/// The session's diagram file of `diagram_type`, or `None` while the agent has not written it.
#[tauri::command]
pub async fn read_graph(app: AppHandle, id: Uuid, diagram_type: graph::DiagramType) -> Result<Option<serde_json::Value>, String> {
    let record = worktree_session(&app, id)?;
    graph::read_graph(&record.worktree_path, diagram_type)
}

/// Writes the diagram of `diagram_type` the user edited in the Architecture tab; `content` is the whole file. A remote
/// session gets the file onto its VM with the next diagram refresh, which pushes it before the agent's turn.
#[tauri::command]
pub async fn write_graph(app: AppHandle, id: Uuid, diagram_type: graph::DiagramType, content: String) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    graph::write_graph(&record.worktree_path, diagram_type, &content)
}

/// When the session's diagram of `diagram_type` was generated and whether files of its worktree changed since.
#[tauri::command]
pub async fn graph_status(app: AppHandle, id: Uuid, diagram_type: graph::DiagramType) -> Result<graph::GraphStatus, String> {
    let record = worktree_session(&app, id)?;
    let changed_at = store::worktree_changed_at(&app, &record.worktree_path)?;
    graph::status(&record.worktree_path, diagram_type, changed_at)
}

fn drop_pending_permissions(permissions: &PermissionRegistry, hunt_session_id: Uuid) {
    permissions.0.lock().unwrap().retain(|_, pending| pending.hunt_session_id != hunt_session_id);
}

/// The branch of a worktree session, `feat/general/<slug>-<short id>`: the title lowercased, non-alphanumerics
/// collapsed to dashes and cut to 40 characters.
fn worktree_branch_name(title: &str, id: Uuid) -> String {
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
        return git::session_branch(short_id);
    }
    git::session_branch(&format!("{}-{short_id}", slug.chars().take(40).collect::<String>().trim_end_matches('-')))
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
    let record = worktree_session(&app, id)?;
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
    let record = worktree_session(&app, id)?;
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

    #[test]
    fn remote_system_prompt_appends_the_git_part_the_services_and_the_agent_md_of_the_repository() {
        let services = "\n### The repository's services\n- `api`: port 3000\n\n";
        let with_token = remote_system_prompt("BASE", true, services, Some("\n# Services\nStart api.\n\n"));
        assert_eq!(
            with_token,
            format!(
                "BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_PUSH_PROMPT}\n### The repository's services\n- `api`: port 3000\n\n\
                 ### The repository's hunt.agent.md\n# Services\nStart api.\n"
            )
        );
        let services_only = remote_system_prompt("BASE", true, services, None);
        assert_eq!(
            services_only,
            format!("BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_PUSH_PROMPT}\n### The repository's services\n- `api`: port 3000\n")
        );

        let without_token = remote_system_prompt("BASE", false, "", None);
        assert_eq!(without_token, format!("BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_LOCAL_PROMPT}"));
        assert_eq!(remote_system_prompt("BASE", false, " \n", Some(" \n")), without_token);
        assert!(REMOTE_PROMPT.contains("the section \"The repository's services\" below"));
        assert!(REMOTE_PROMPT.contains("```sh\nsudo -n hunt-ctl service start <name>…\n```"));
        assert!(REMOTE_PROMPT.contains("$HUNT_PREVIEW_URL_TEMPLATE` with `{port}`"));
        assert!(REMOTE_PROMPT.contains("tmux pipe-pane -o -t app:<name> 'cat >> ~/logs/<name>.log'\n```"));

        let poller = remote_system_prompt("", false, "", None);
        assert!(poller.starts_with("\n\n## Remote session\nThis session runs on a VM of its own. The user brings its commits back to their machine.\n\n"));
        assert!(poller.ends_with(
            "The repository's hunt.agent.md, its instructions for Hunt sessions, follows at the end when it has one.\n\n\
             ### Git\nThere is no GitHub token for this session, so pushing fails: commit locally and do not push.\n"
        ));
    }

    #[test]
    fn worktree_branch_name_is_a_feat_general_branch_with_a_lowercase_collapsed_slug() {
        let id = Uuid::parse_str("0123abcd-1111-2222-3333-444455556666").unwrap();
        assert_eq!(worktree_branch_name("Fix the Login  Bug!", id), "feat/general/fix-the-login-bug-0123abcd");
        assert_eq!(worktree_branch_name("#527 Multilingual emails", id), "feat/general/527-multilingual-emails-0123abcd");
        assert_eq!(worktree_branch_name("  ---  ", id), "feat/general/0123abcd");
        assert_eq!(worktree_branch_name("", id), "feat/general/0123abcd");
        assert_eq!(worktree_branch_name("Ärger mit Umlauten", id), "feat/general/rger-mit-umlauten-0123abcd");

        let long = worktree_branch_name(&"word ".repeat(20), id);
        assert_eq!(long, format!("feat/general/{}-0123abcd", "word-".repeat(8).trim_end_matches('-')));
        assert!(!long.contains("--"));
    }

    #[tokio::test]
    async fn deleting_a_session_deletes_only_the_branch_hunt_created() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::run_git(&repo, &["init", "-q", "-b", "main"]).await.unwrap();
        git::run_git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init"]).await.unwrap();
        git::run_git(&repo, &["branch", "fix/sentry/admin-ui-errors"]).await.unwrap();

        let created = dir.path().join("created");
        git::worktree_add(&repo, "feat/general/x-0123abcd", &created, "main").await.unwrap();
        let review = dir.path().join("review");
        let is_created = git::worktree_add_on_branch(&repo, "fix/sentry/admin-ui-errors", &review, "origin/fix/sentry/admin-ui-errors").await.unwrap();
        let session = |worktree: &Path, branch: &str| {
            SessionRecord::new(Uuid::new_v4(), "x".into(), repo.clone(), worktree.to_path_buf(), branch.into(), "main".into(), String::new())
        };
        let mut review_session = session(&review, "fix/sentry/admin-ui-errors");
        review_session.keeps_branch = !is_created;

        for record in [session(&created, "feat/general/x-0123abcd"), review_session] {
            git::worktree_remove(&repo, &record.worktree_path).await.unwrap();
            delete_created_branch(&record).await;
        }
        assert!(!git::local_branch_exists(&repo, "feat/general/x-0123abcd").await);
        assert!(git::local_branch_exists(&repo, "fix/sentry/admin-ui-errors").await);
    }

    #[test]
    fn file_context_block_embeds_the_file_text_and_skips_missing_files() {
        let dir = std::env::temp_dir().join(format!("hunt-file-context-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rule.md");
        std::fs::write(&file, "# Rule\n").unwrap();
        let on_vm = Path::new("/home/agent/app/rule.md");

        let block = file_context_block(&file, on_vm).unwrap();
        match block {
            ContentBlock::Resource(resource) => match resource.resource {
                EmbeddedResourceResource::TextResourceContents(contents) => {
                    assert_eq!(contents.text, "# Rule\n");
                    assert_eq!(contents.uri, "file:///home/agent/app/rule.md");
                }
                _ => panic!("expected text contents"),
            },
            _ => panic!("expected a resource block"),
        }
        assert!(file_context_block(&dir.join("missing.md"), on_vm).is_none());
        assert!(file_context_block(&dir, on_vm).is_none());
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
