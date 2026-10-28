//! The commands of GitHub: a repository's open pull requests, issue titles and the account `gh` is logged in as, and
//! the review of the pull request a session reviews: its description, state and review threads, the drafted review
//! comments and replies, and submitting the review.

use std::path::Path;

use tauri::AppHandle;
use uuid::Uuid;

use super::{local_session, session_file};
use crate::github::{self, GithubViewer, PullRequest, PullRequestDetails, ReplyTarget, ReviewComment, ReviewEvent, ReviewThread};
use crate::session::review;
use crate::session::store::{self, announce_sessions_changed, SessionRecord};

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
