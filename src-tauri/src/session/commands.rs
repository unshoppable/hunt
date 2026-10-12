//! Tauri commands of the session domain: the backend surface the React UI talks to. Domain modules own their
//! thin commands themselves: `lsp_request`, `lsp_notify` and `lsp_cancel` live in `lsp.rs`, `set_ai_language` in
//! `preferences.rs`.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, ContentChunk, EmbeddedResource, EmbeddedResourceResource, ImageContent, Meta,
    PromptRequest, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest, TextContent,
    TextResourceContents,
};
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::acp::{connect, publish_update, LiveHandles, PermissionRegistry, SessionRegistry, SessionStart};
use crate::git::{self, ChangedFile, FileDiff, Shelf};
use crate::github::{self, GithubViewer, PullRequest, PullRequestDetails, PullRequestRef, ReviewComment, ReviewEvent};
use crate::graph::{self, WatcherRegistry};
use crate::ide;
use crate::lsp::{self, LspRegistry};
use crate::screenshots::{self, Screenshot};
use crate::session::attribution;
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

/// Submits a review of the pull request the session reviews: `body` is its summary comment, the session's drafted
/// review comments go with it (inline where GitHub takes them, as notes in the summary otherwise) and are cleared
/// once GitHub accepted the review.
#[tauri::command]
pub async fn submit_pull_request_review(app: AppHandle, id: Uuid, event: ReviewEvent, body: String) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
    let Some(pull_request) = record.pull_request.clone() else {
        return Err("failed to submit review: the session does not review a pull request".into());
    };
    let review_id = review_session_id(&record);
    let drafts = store::find_session(&app, review_id)?.review_comments;
    let (body, inline) = review::prepare(&record, &drafts, &body).await?;
    github::submit_review_with_comments(&record.repo_path, pull_request.number, event, &body, &inline).await?;
    if !drafts.is_empty() {
        store::update_session(&app, review_id, |review| review.review_comments.clear())?;
        announce_sessions_changed(&app);
    }
    Ok(())
}

/// Drafts a review comment on lines `start_line..=line` of the new version of `path` for the session's pull
/// request; it shows under the line in every code view until the review is submitted.
#[tauri::command]
pub async fn add_review_comment(app: AppHandle, id: Uuid, path: String, start_line: u32, line: u32, body: String) -> Result<ReviewComment, String> {
    let (record, _) = session_file(&app, id, &path)?;
    if record.pull_request.is_none() {
        return Err("failed to add review comment: the session does not review a pull request".into());
    }
    if start_line == 0 || line < start_line {
        return Err(format!("failed to add review comment: lines {start_line}-{line} are not a line range"));
    }
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("failed to add review comment: the comment is empty".into());
    }
    let comment = ReviewComment { id: Uuid::new_v4(), path, start_line, line, body, created_at: chrono::Utc::now() };
    let stored = comment.clone();
    store::update_session(&app, review_session_id(&record), |review| review.review_comments.push(stored))?
        .ok_or_else(|| "failed to add review comment: the session no longer exists".to_string())?;
    announce_sessions_changed(&app);
    Ok(comment)
}

/// Replaces the text of the drafted review comment `comment_id`.
#[tauri::command]
pub async fn update_review_comment(app: AppHandle, id: Uuid, comment_id: Uuid, body: String) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
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

/// Discards the drafted review comment `comment_id`.
#[tauri::command]
pub async fn delete_review_comment(app: AppHandle, id: Uuid, comment_id: Uuid) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
    store::update_session(&app, review_session_id(&record), |review| review.review_comments.retain(|comment| comment.id != comment_id))?;
    announce_sessions_changed(&app);
    Ok(())
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
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: worktree_path }).await?;
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
    let parent = store::find_session(&app, parent_id)?;
    let record = SessionRecord::sub_session(id, title, &parent, selection);
    store::upsert_session(&app, record.clone())?;
    announce_sessions_changed(&app);
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: parent.worktree_path }).await?;
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
    dependencies::ensure(&app, record.repo_path.clone(), record.worktree_path.clone());

    let start = match &record.acp_session_id {
        Some(acp_session_id) => SessionStart::Load { cwd: record.worktree_path.clone(), acp_session_id: acp_session_id.clone() },
        None => SessionStart::New { cwd: record.worktree_path.clone() },
    };
    let activated = activate(&app, &registry, &watchers, record, start).await;
    registry.end_start(id).await;
    activated
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
    drop_pending_permissions(&permissions, id);
    let finished = registry.live.lock().await.remove(&id).and_then(|mut live| live.shutdown());
    // The ended agent task clears the registries on its way out; the new agent registers only after that.
    if let Some(finished) = finished {
        let _ = finished.await;
    }
    if !registry.claim_start(id).await {
        return Err("failed to clear session: its agent was started again meanwhile".into());
    }
    let start = SessionStart::New { cwd: record.worktree_path.clone() };
    let activated = activate(&app, &registry, &watchers, record, start).await;
    registry.end_start(id).await;
    activated
}

/// Prepares the worktree's `node_modules` again, after a failed attempt or for a session created before Hunt did
/// this; the result shows up in the session list.
#[tauri::command]
pub async fn prepare_dependencies(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
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
) -> Result<SessionView, String> {
    let id = record.id;
    let context_prompt = record.selection.as_ref().map(SelectionContext::to_system_prompt);
    let mut live = connect(app.clone(), id, start, context_prompt).await?;
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

    // Every start renews the exclude entry, so repositories of older sessions learn the diagram folder's current name.
    if let Err(error) = git::exclude_hunt_dir(&record.worktree_path).await {
        eprintln!("excluding the diagram folder in the worktree of session {id} failed: {error}");
    }
    if let Err(error) = graph::watch(app, watchers, id, &record.worktree_path) {
        eprintln!("watching the graph of session {id} failed: {error}");
    }
    Ok(SessionView::new(app, record, true))
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
    // A sub chat only owns its record; the worktree belongs to its parent.
    if record.parent_id.is_some() {
        return store::remove_session(app, id);
    }

    for child in store::load_sessions(app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent(app, registry, watchers, permissions, child.id).await;
        store::remove_session(app, child.id)?;
    }
    if record.workspace == Workspace::Checkout {
        return store::remove_session(app, id);
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
    store::remove_session(app, id)?;
    removal
}

/// Tells every window that the stored sessions changed in a way the sidebar must reload: a session was added
/// or removed, or its title or state changed.
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
    if let Some(selection) = record.selection.as_ref().filter(|selection| selection.task.is_some()) {
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

/// Asks the agent to rewrite the component diagram with the standard prompt. The turn is recorded as hidden,
/// so the chat shows a status line instead of the prompt text, and it leaves the session summary alone.
#[tauri::command]
pub async fn refresh_graph(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid) -> Result<String, String> {
    let blocks = vec![ContentBlock::Text(TextContent::new(graph::refresh_prompt(&crate::preferences::ai_language(&app))))];
    run_turn(&app, &registry, id, blocks, Some(graph::hidden_turn_meta(GRAPH_TURN_LABEL))).await
}

/// Status line the chat shows for a diagram refresh turn; the frontend matches the same string.
const GRAPH_TURN_LABEL: &str = "Updating the component diagram";

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
    let LiveHandles { connection, acp_session_id, .. } = live_session(&registry, id).await?;

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

    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(acp_session_id.clone(), config_id, value.as_str()))
        .block_task()
        .await
        .map_err(|error| format!("failed to set the session config option: {error}"))?;

    let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(response.config_options));
    publish_update(&app, id, &history, SessionNotification::new(acp_session_id, update));
    Ok(())
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
    let record = store::find_session(&app, id)?;
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
    let record = store::find_session(&app, id)?;
    git::change_stats(&record.worktree_path, record.diff_base()).await
}

#[tauri::command]
pub async fn read_file_diff(app: AppHandle, id: Uuid, path: String) -> Result<FileDiff, String> {
    let (record, _) = session_file(&app, id, &path)?;
    git::file_diff(&record.worktree_path, record.diff_base(), &path).await
}

/// The stored record of `id` and the absolute location of the worktree-relative `path` in its worktree. Every
/// command that takes a path from the UI resolves it here: absolute paths and `..` segments are rejected.
fn session_file(app: &AppHandle, id: Uuid, path: &str) -> Result<(SessionRecord, PathBuf), String> {
    let record = store::find_session(app, id)?;
    let target = worktree_file(&record, path)?;
    Ok((record, target))
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
    let (_, target) = session_file(&app, id, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&target, content).map_err(|error| format!("failed to write {path}: {error}"))?;
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
    let record = store::find_session(&app, id)?;
    git::shelve_files(&record.worktree_path, &paths, &name).await?;
    store::forget_touched_files(&app, &record.worktree_path, &paths)?;
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn list_shelves(app: AppHandle, id: Uuid) -> Result<Vec<Shelf>, String> {
    let record = store::find_session(&app, id)?;
    git::list_shelves(&record.worktree_path, &record.branch).await
}

/// Restores a shelf into the worktree; `keep` leaves the shelf in place instead of dropping it.
#[tauri::command]
pub async fn unshelve(app: AppHandle, id: Uuid, reference: String, keep: bool) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
    git::unshelve(&record.worktree_path, &reference, keep).await?;
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn drop_shelf(app: AppHandle, id: Uuid, reference: String) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
    git::drop_shelf(&record.worktree_path, &reference).await
}

#[tauri::command]
pub async fn open_worktree_in_webstorm(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = store::find_session(&app, id)?;
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
    let record = store::find_session(&app, id)?;
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
    let record = store::find_session(&app, id)?;
    graph::read_graph(&record.worktree_path)
}

/// When the session's diagram was generated and whether files of its worktree changed since.
#[tauri::command]
pub async fn graph_status(app: AppHandle, id: Uuid) -> Result<graph::GraphStatus, String> {
    let record = store::find_session(&app, id)?;
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
    let record = store::find_session(&app, id)?;
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
    let record = store::find_session(&app, id)?;
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
