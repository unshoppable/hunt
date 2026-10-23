//! GitHub operations Hunt needs: the open pull requests of a repository with the review and check state GitHub's own
//! list shows, and the description and conversation of one of them. Everything shells out to the `gh` CLI so its
//! login, host and proxy configuration match the terminal.

use std::io::ErrorKind;
use std::path::Path;
use std::process::{Output, Stdio};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

/// An open pull request of the repository's GitHub remote, with the metadata GitHub's pull request list shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// GitHub login of the author; `ghost` for a deleted account.
    pub author: String,
    /// Branch the pull request merges from, as named on GitHub (without a remote prefix).
    pub head_ref_name: String,
    /// Branch the pull request merges into, as named on GitHub (without a remote prefix).
    pub base_ref_name: String,
    pub is_draft: bool,
    /// ISO 8601 timestamp of when the pull request was opened.
    pub created_at: String,
    /// ISO 8601 timestamp of the last change to the pull request.
    pub updated_at: String,
    pub url: String,
    /// `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; `None` when the repository requires no review.
    pub review_decision: Option<String>,
    /// The signed-in user's part in the review; `None` when they neither reviewed nor were asked to.
    pub viewer_review: Option<ViewerReview>,
    /// Conversation and review comments, as GitHub counts them in its list.
    pub comment_count: u64,
    /// Outcome of the status checks of the head commit; `None` when none ran.
    pub checks: Option<CheckSummary>,
    /// Task-list checkboxes in the description; `None` when there are none.
    pub tasks: Option<TaskCount>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub labels: Vec<Label>,
}

/// How the signed-in user stands to a pull request's review: asked for one, or the verdict of the latest review
/// they left. An outstanding request wins over an earlier review, as GitHub shows it.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ViewerReview {
    Requested,
    Approved,
    ChangesRequested,
    Commented,
}

/// Status checks of a commit by outcome; GitHub's list shows `passed` of the total.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

/// Task-list checkboxes of a Markdown body: `- [x]` is done, `- [ ]` is open.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCount {
    pub done: u32,
    pub total: u32,
}

/// A GitHub label; `color` is a hex triplet without `#`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Label {
    pub name: String,
    pub color: String,
}

/// The GraphQL response of `LIST_QUERY`, in GitHub's own shape.
#[derive(Deserialize)]
struct GqlResponse {
    #[serde(default)]
    data: Option<GqlData>,
}

#[derive(Deserialize)]
struct GqlData {
    viewer: GhAuthor,
    /// `None` when the remote is not a GitHub repository the user can see.
    #[serde(default)]
    repository: Option<GqlRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlRepository {
    pull_requests: GqlNodes<GqlPullRequest>,
}

/// A GraphQL connection reduced to its nodes.
#[derive(Deserialize)]
struct GqlNodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPullRequest {
    number: u64,
    title: String,
    url: String,
    is_draft: bool,
    created_at: String,
    updated_at: String,
    head_ref_name: String,
    base_ref_name: String,
    /// `null` when GitHub reports no text.
    #[serde(default)]
    body: Option<String>,
    /// `null` for a deleted account.
    #[serde(default)]
    author: Option<GhAuthor>,
    additions: u64,
    deletions: u64,
    changed_files: u64,
    #[serde(default)]
    total_comments_count: Option<u64>,
    #[serde(default)]
    review_decision: Option<String>,
    labels: GqlNodes<Label>,
    /// The latest review of each reviewer.
    latest_reviews: GqlNodes<GqlLatestReview>,
    /// The latest approval, change request or dismissed review of each reviewer; a later comment review leaves it.
    latest_opinionated_reviews: GqlNodes<GqlLatestReview>,
    review_requests: GqlNodes<GqlReviewRequest>,
    /// Only the head commit is asked for.
    commits: GqlNodes<GqlCommitNode>,
}

#[derive(Deserialize)]
struct GqlLatestReview {
    #[serde(default)]
    author: Option<GhAuthor>,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlReviewRequest {
    #[serde(default)]
    requested_reviewer: Option<GqlReviewer>,
}

/// A requested reviewer; only users carry a login, a team is an empty object.
#[derive(Deserialize)]
struct GqlReviewer {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Deserialize)]
struct GqlCommitNode {
    commit: GqlCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlCommit {
    /// `null` when no check ran on the commit.
    #[serde(default)]
    status_check_rollup: Option<GqlRollup>,
}

#[derive(Deserialize)]
struct GqlRollup {
    contexts: GqlNodes<GqlCheck>,
}

/// One check of a commit: a check run carries `status` and `conclusion`, a commit status only `state`.
#[derive(Deserialize)]
struct GqlCheck {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
struct GhAuthor {
    login: String,
}

/// The pull request a session reviews, as stored with the session: enough to show it and to open it on GitHub.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestRef {
    pub number: u64,
    pub url: String,
}

/// A pull request with its description and conversation, as `gh pr view` reports it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetails {
    pub number: u64,
    pub title: String,
    /// Markdown description; empty when the author left it blank.
    pub body: String,
    /// GitHub login of the author.
    pub author: String,
    pub url: String,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub is_draft: bool,
    pub created_at: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    /// Conversation comments in the order GitHub lists them (oldest first).
    pub comments: Vec<PullRequestComment>,
    /// Submitted reviews in the order GitHub lists them (oldest first).
    pub reviews: Vec<PullRequestReview>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
    /// Hidden on GitHub, e.g. as spam or off-topic.
    pub is_minimized: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub author: String,
    /// Summary text of the review; empty for a bare approval.
    pub body: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`.
    pub state: String,
    pub submitted_at: String,
}

/// A review thread of a pull request: comments on lines `start_line..=line` of `side` of `path` (both 0 for a thread
/// on the whole file), oldest first; the first comment opened the thread, the others reply to it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    /// GraphQL node ID.
    pub id: String,
    pub path: String,
    pub side: DiffSide,
    pub start_line: u32,
    pub line: u32,
    pub is_resolved: bool,
    /// The commented code changed after the first comment; GitHub still maps the thread to `line`.
    pub is_outdated: bool,
    /// Whether the signed-in user may answer the thread, resolve it, or mark it as unresolved again.
    pub viewer_can_reply: bool,
    pub viewer_can_resolve: bool,
    pub viewer_can_unresolve: bool,
    pub comments: Vec<ReviewThreadComment>,
}

/// Side of a pull request's diff: lines of `Left` number the base version of a file, lines of `Right` the new one.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "UPPERCASE"))]
pub enum DiffSide {
    Left,
    Right,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadComment {
    /// GraphQL node ID.
    pub id: String,
    /// GitHub login of the author; `ghost` for a deleted account.
    pub author: String,
    /// Empty for a deleted account.
    pub avatar_url: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

/// State of a pull request, as `gh pr view --json state,isDraft` prints it (mirror of `PullRequestState` in src/ipc/types.ts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestState {
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub is_draft: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequestDetails {
    number: u64,
    title: String,
    /// `null` when GitHub reports no text.
    #[serde(default)]
    body: Option<String>,
    author: GhAuthor,
    url: String,
    state: String,
    is_draft: bool,
    created_at: String,
    head_ref_name: String,
    base_ref_name: String,
    #[serde(default)]
    comments: Vec<GhComment>,
    #[serde(default)]
    reviews: Vec<GhReview>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhComment {
    author: GhAuthor,
    /// `null` when GitHub reports no text.
    #[serde(default)]
    body: Option<String>,
    created_at: String,
    url: String,
    #[serde(default)]
    is_minimized: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReview {
    author: GhAuthor,
    /// `null` when GitHub reports no text.
    #[serde(default)]
    body: Option<String>,
    state: String,
    #[serde(default)]
    submitted_at: String,
}

/// The GraphQL response of `THREADS_QUERY`, in GitHub's own shape.
#[derive(Deserialize)]
struct GqlThreadsResponse {
    #[serde(default)]
    data: Option<GqlThreadsData>,
}

#[derive(Deserialize)]
struct GqlThreadsData {
    /// `None` when the remote is not a GitHub repository the user can see.
    #[serde(default)]
    repository: Option<GqlThreadsRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlThreadsRepository {
    #[serde(default)]
    pull_request: Option<GqlThreadsPullRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlThreadsPullRequest {
    review_threads: GqlNodes<GqlThread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlThread {
    id: String,
    path: String,
    /// `null` when GitHub can no longer map the thread to a line of the diff, and for a thread on the whole file.
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    start_line: Option<u32>,
    diff_side: DiffSide,
    /// `LINE` or `FILE`.
    subject_type: String,
    is_resolved: bool,
    is_outdated: bool,
    #[serde(default)]
    viewer_can_reply: bool,
    #[serde(default)]
    viewer_can_resolve: bool,
    #[serde(default)]
    viewer_can_unresolve: bool,
    comments: GqlNodes<GqlThreadComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlThreadComment {
    id: String,
    /// `null` for a deleted account.
    #[serde(default)]
    author: Option<GqlActor>,
    /// `null` when GitHub reports no text.
    #[serde(default)]
    body: Option<String>,
    created_at: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlActor {
    login: String,
    avatar_url: String,
}

/// Asks for the open pull requests and the signed-in user in one round trip; `gh` fills `owner` and `name` from the
/// repository's remote. The order is GitHub's default for its list: newest first.
const LIST_QUERY: &str = r#"query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft createdAt updatedAt headRefName baseRefName body
        author { login }
        additions deletions changedFiles totalCommentsCount reviewDecision
        labels(first: 20) { nodes { name color } }
        latestReviews(first: 100) { nodes { author { login } state } }
        latestOpinionatedReviews(first: 100) { nodes { author { login } state } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { status conclusion }
          ... on StatusContext { state }
        } } } } } }
      }
    }
  }
}"#;
const DETAIL_JSON_FIELDS: &str = "number,title,body,author,url,state,isDraft,createdAt,headRefName,baseRefName,comments,reviews";
/// Asks for the review threads of a pull request with their comments; `gh` fills `owner` and `name` from the
/// repository's remote.
const THREADS_QUERY: &str = r#"query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id path line startLine diffSide subjectType isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: 100) { nodes { id author { login avatarUrl(size: 64) } body createdAt url } }
        }
      }
    }
  }
}"#;

/// Runs `gh` with `args` in `repo` and returns its stdout; `what` names the operation in the error message.
async fn run_gh(repo: &Path, args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("gh").current_dir(repo).args(args).output().await.map_err(spawn_error)?;
    stdout_of(output, what)
}

/// Like `run_gh`, but feeds `input` to the standard input of `gh` (request bodies of `gh api --input -`).
async fn run_gh_with_input(repo: &Path, args: &[&str], input: &[u8], what: &str) -> Result<Vec<u8>, String> {
    let mut child = Command::new("gh")
        .current_dir(repo)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input).await.map_err(|error| format!("failed to {what}: {error}"))?;
    }
    let output = child.wait_with_output().await.map_err(|error| format!("failed to run gh: {error}"))?;
    stdout_of(output, what)
}

fn spawn_error(error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::NotFound => "failed to run gh: the GitHub CLI is not installed".to_string(),
        _ => format!("failed to run gh: {error}"),
    }
}

fn stdout_of(output: Output, what: &str) -> Result<Vec<u8>, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("failed to {what}: {stderr}"));
    }
    Ok(output.stdout)
}

/// The GitHub account `gh` is logged in as; serializes in camelCase for the frontend, parses `gh api user`'s snake_case.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubViewer {
    pub login: String,
    #[serde(rename(deserialize = "avatar_url"))]
    pub avatar_url: String,
}

/// The title of the issue or pull request `number` of the GitHub repository `owner`/`name`, looked up with `gh` from
/// `repo`, whose host and login it uses.
pub async fn issue_title(repo: &Path, owner: &str, name: &str, number: u64) -> Result<String, String> {
    for part in [owner, name] {
        let is_valid = !part.is_empty() && part.chars().all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character));
        if !is_valid {
            return Err(format!("failed to look up the issue: invalid repository name {owner}/{name}"));
        }
    }
    let endpoint = format!("repos/{owner}/{name}/issues/{number}");
    let stdout = run_gh(repo, &["api", &endpoint, "--jq", ".title"], "look up the issue").await?;
    let title = String::from_utf8_lossy(&stdout).trim().to_string();
    if title.is_empty() {
        return Err(format!("failed to look up the issue: #{number} of {owner}/{name} has no title"));
    }
    Ok(title)
}

/// The account `gh` is logged in as for the host of `repo`'s remote.
pub async fn viewer(repo: &Path) -> Result<GithubViewer, String> {
    let stdout = run_gh(repo, &["api", "user"], "look up the GitHub user").await?;
    parse_viewer(&stdout)
}

fn parse_viewer(json: &[u8]) -> Result<GithubViewer, String> {
    serde_json::from_slice(json).map_err(|error| format!("failed to parse the GitHub user: {error}"))
}

/// Open pull requests of the GitHub repository `repo` is a clone of, newest first, with the signed-in user's review
/// state worked out against `gh`'s account.
pub async fn list_open_pull_requests(repo: &Path) -> Result<Vec<PullRequest>, String> {
    let query = format!("query={LIST_QUERY}");
    let args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", &query];
    let stdout = run_gh(repo, &args, "list pull requests").await?;
    parse_pull_requests(&stdout)
}

/// The verdict a submitted review carries, as `gh pr review` names it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

impl ReviewEvent {
    fn gh_flag(self) -> &'static str {
        match self {
            ReviewEvent::Approve => "--approve",
            ReviewEvent::RequestChanges => "--request-changes",
            ReviewEvent::Comment => "--comment",
        }
    }

    /// The event name of the REST API (`POST /pulls/{number}/reviews`).
    fn api_name(self) -> &'static str {
        match self {
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
            ReviewEvent::Comment => "COMMENT",
        }
    }
}

/// A review comment drafted in Hunt and not yet submitted, anchored at lines `start_line..=line` of the new version
/// of `path` (a single-line comment has `start_line == line`), or at the whole file when both are 0. Stored with the
/// session until the review is submitted. A reply carries the path and lines of what it answers.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: Uuid,
    /// Worktree-relative path of the commented file.
    pub path: String,
    pub start_line: u32,
    pub line: u32,
    pub body: String,
    pub created_at: DateTime<Utc>,
    /// What the comment answers; `None` for a comment that opens a thread.
    #[serde(default)]
    pub reply_to: Option<ReplyTarget>,
}

impl ReviewComment {
    /// Whether the comment is on the whole file rather than on lines of it.
    pub fn is_on_file(&self) -> bool {
        self.line == 0
    }
}

/// What a drafted reply answers: a review thread on GitHub (its GraphQL node ID) or a drafted comment that opens a
/// thread. Serialized as `{ "kind": "thread" | "draft", "id": … }`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
pub enum ReplyTarget {
    Thread(String),
    Draft(Uuid),
}

/// A thread a review opens on lines `start_line..=line` of the new version of `path`, which must lie inside a hunk of
/// the pull request's diff, or on the whole file when both are 0, which must then be part of the diff. `replies`
/// answer its first comment, oldest first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewThread {
    pub path: String,
    pub start_line: u32,
    pub line: u32,
    pub body: String,
    pub replies: Vec<String>,
}

impl NewThread {
    /// Whether the REST API can create the thread with the review: a thread on lines without replies.
    fn is_plain_line_thread(&self) -> bool {
        self.line != 0 && self.replies.is_empty()
    }
}

/// A reply of a review to the review thread `thread_id` (a GraphQL node ID) already on GitHub.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadReply {
    pub thread_id: String,
    pub body: String,
}

/// Submits a review of pull request `number` with `body` as its summary. GitHub requires a body for a comment or a
/// change request; only an approval may leave it empty.
pub async fn submit_review(repo: &Path, number: u64, event: ReviewEvent, body: &str) -> Result<(), String> {
    if body.trim().is_empty() && event != ReviewEvent::Approve {
        return Err("failed to submit review: a comment or change request needs a body".into());
    }
    let number = number.to_string();
    run_gh(repo, &["pr", "review", &number, event.gh_flag(), "--body", body], "submit review").await?;
    Ok(())
}

/// Submits a review that opens `threads` and adds `replies` to threads already on GitHub, which `gh pr review` cannot
/// do; without either this is `submit_review`. With comments the summary may be empty, as in GitHub's own review dialog.
pub async fn submit_review_with_comments(
    repo: &Path,
    number: u64,
    event: ReviewEvent,
    body: &str,
    threads: &[NewThread],
    replies: &[ThreadReply],
) -> Result<(), String> {
    if threads.is_empty() && replies.is_empty() {
        return submit_review(repo, number, event, body).await;
    }
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews");
    let (plain, other): (Vec<&NewThread>, Vec<&NewThread>) = threads.iter().partition(|thread| thread.is_plain_line_thread());
    if other.is_empty() && replies.is_empty() {
        let payload = serde_json::to_vec(&review_payload(Some(event), body, &plain)).map_err(|error| format!("failed to submit review: {error}"))?;
        run_gh_with_input(repo, &["api", "--method", "POST", &endpoint, "--input", "-"], &payload, "submit review").await?;
        return Ok(());
    }
    // The REST API takes only line comments without replies with a review, so it only creates the review, pending;
    // GraphQL adds the other threads and the replies and submits it. GitHub allows one pending review per user and
    // pull request: a failure deletes it.
    let payload = serde_json::to_vec(&review_payload(None, "", &plain)).map_err(|error| format!("failed to submit review: {error}"))?;
    let stdout = run_gh_with_input(repo, &["api", "--method", "POST", &endpoint, "--input", "-"], &payload, "submit review").await?;
    let pending: CreatedReview = serde_json::from_slice(&stdout).map_err(|error| format!("failed to submit review: {error}"))?;
    let result = complete_pending_review(repo, &pending.node_id, event, body, &other, replies).await;
    if result.is_err() {
        let request = graphql_request(DELETE_REVIEW_MUTATION, serde_json::json!({ "review": pending.node_id }));
        if let Err(error) = run_graphql(repo, &request, "discard the pending review").await {
            eprintln!("{error}");
        }
    }
    result
}

/// The part of the REST API's answer to creating a review that GraphQL mutations address it by.
#[derive(Deserialize)]
struct CreatedReview {
    node_id: String,
}

/// Adds `threads` with their replies and the `replies` to existing threads to the pending review `review_id` (a
/// GraphQL node ID) and submits it.
async fn complete_pending_review(
    repo: &Path,
    review_id: &str,
    event: ReviewEvent,
    body: &str,
    threads: &[&NewThread],
    replies: &[ThreadReply],
) -> Result<(), String> {
    for thread in threads {
        let stdout = run_graphql(repo, &add_thread_request(review_id, thread), "add review thread").await?;
        let thread_id = parse_added_thread_id(&stdout)?;
        for reply in &thread.replies {
            run_graphql(repo, &add_reply_request(Some(review_id), &thread_id, reply), "add reply").await?;
        }
    }
    for reply in replies {
        run_graphql(repo, &add_reply_request(Some(review_id), &reply.thread_id, &reply.body), "add reply").await?;
    }
    run_graphql(repo, &submit_review_request(review_id, event, body), "submit review").await?;
    Ok(())
}

/// Posts `body` as a reply to the review thread `thread_id` (a GraphQL node ID) right away, outside of a review.
pub async fn reply_to_thread(repo: &Path, thread_id: &str, body: &str) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("failed to reply to review thread: the reply is empty".into());
    }
    run_graphql(repo, &add_reply_request(None, thread_id, body), "reply to review thread").await?;
    Ok(())
}

/// Marks the review thread `thread_id` (a GraphQL node ID) as resolved, or as unresolved again.
pub async fn set_thread_resolved(repo: &Path, thread_id: &str, is_resolved: bool) -> Result<(), String> {
    let (mutation, what) = if is_resolved {
        (RESOLVE_THREAD_MUTATION, "resolve review thread")
    } else {
        (UNRESOLVE_THREAD_MUTATION, "unresolve review thread")
    };
    run_graphql(repo, &graphql_request(mutation, serde_json::json!({ "thread": thread_id })), what).await?;
    Ok(())
}

const ADD_THREAD_MUTATION: &str = r#"mutation($review: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide, subjectType: $subjectType}) { thread { id } }
}"#;
const ADD_REPLY_MUTATION: &str = r#"mutation($review: ID, $thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body}) { comment { id } }
}"#;
const RESOLVE_THREAD_MUTATION: &str = r#"mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) { thread { id } }
}"#;
const UNRESOLVE_THREAD_MUTATION: &str = r#"mutation($thread: ID!) {
  unresolveReviewThread(input: {threadId: $thread}) { thread { id } }
}"#;
const SUBMIT_REVIEW_MUTATION: &str = r#"mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, body: $body}) { pullRequestReview { id } }
}"#;
const DELETE_REVIEW_MUTATION: &str = r#"mutation($review: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $review}) { clientMutationId }
}"#;

/// Adds `thread` to the pending review `review_id`: on its lines of the new side, or on the whole file. Variables a
/// thread does not need are left out, so GitHub treats them as absent.
fn add_thread_request(review_id: &str, thread: &NewThread) -> serde_json::Value {
    let mut variables = serde_json::json!({ "review": review_id, "path": thread.path, "body": thread.body });
    if thread.line == 0 {
        variables["subjectType"] = serde_json::json!("FILE");
    } else {
        variables["line"] = serde_json::json!(thread.line);
        variables["side"] = serde_json::json!("RIGHT");
        if thread.start_line < thread.line {
            variables["startLine"] = serde_json::json!(thread.start_line);
            variables["startSide"] = serde_json::json!("RIGHT");
        }
    }
    graphql_request(ADD_THREAD_MUTATION, variables)
}

/// Adds `body` as a reply to the review thread `thread_id`: to the pending review `review_id`, or posted right away
/// without one.
fn add_reply_request(review_id: Option<&str>, thread_id: &str, body: &str) -> serde_json::Value {
    let mut variables = serde_json::json!({ "thread": thread_id, "body": body });
    if let Some(review_id) = review_id {
        variables["review"] = serde_json::json!(review_id);
    }
    graphql_request(ADD_REPLY_MUTATION, variables)
}

/// The node ID of the thread in the answer to `ADD_THREAD_MUTATION`.
fn parse_added_thread_id(json: &[u8]) -> Result<String, String> {
    let response: serde_json::Value = serde_json::from_slice(json).map_err(|error| format!("failed to add review thread: {error}"))?;
    response["data"]["addPullRequestReviewThread"]["thread"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "failed to add review thread: GitHub returned no thread".to_string())
}

/// Request body of `gh api graphql --input -`.
fn graphql_request(query: &str, variables: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "query": query, "variables": variables })
}

/// Submits the pending review `review_id` with `event`; an empty summary is left out, as in `review_payload`.
fn submit_review_request(review_id: &str, event: ReviewEvent, body: &str) -> serde_json::Value {
    let mut variables = serde_json::json!({ "review": review_id, "event": event.api_name() });
    if !body.trim().is_empty() {
        variables["body"] = serde_json::json!(body);
    }
    graphql_request(SUBMIT_REVIEW_MUTATION, variables)
}

/// Sends the GraphQL `request` (see `graphql_request`); `gh` fails on errors in the response as well.
async fn run_graphql(repo: &Path, request: &serde_json::Value, what: &str) -> Result<Vec<u8>, String> {
    let input = serde_json::to_vec(request).map_err(|error| format!("failed to {what}: {error}"))?;
    run_gh_with_input(repo, &["api", "graphql", "--input", "-"], &input, what).await
}

/// Request body of `POST /pulls/{number}/reviews` with the line threads `comments` (see
/// `NewThread::is_plain_line_thread`): every comment sits on the new side (`RIGHT`); a multi-line one also names its
/// first line. Without an `event` the review stays pending. An empty summary is left out rather than sent as an empty
/// string.
fn review_payload(event: Option<ReviewEvent>, body: &str, comments: &[&NewThread]) -> serde_json::Value {
    let comments: Vec<serde_json::Value> = comments
        .iter()
        .map(|comment| {
            let mut value = serde_json::json!({ "path": comment.path, "line": comment.line, "side": "RIGHT", "body": comment.body });
            if comment.start_line < comment.line {
                value["start_line"] = serde_json::json!(comment.start_line);
                value["start_side"] = serde_json::json!("RIGHT");
            }
            value
        })
        .collect();
    let mut payload = serde_json::json!({ "comments": comments });
    if let Some(event) = event {
        payload["event"] = serde_json::json!(event.api_name());
    }
    if !body.trim().is_empty() {
        payload["body"] = serde_json::json!(body);
    }
    payload
}

/// Description and conversation of pull request `number` of the GitHub repository `repo` is a clone of.
pub async fn view_pull_request(repo: &Path, number: u64) -> Result<PullRequestDetails, String> {
    let number = number.to_string();
    let stdout = run_gh(repo, &["pr", "view", &number, "--json", DETAIL_JSON_FIELDS], "view pull request").await?;
    parse_pull_request_details(&stdout)
}

/// The state of pull request `number` with whether it is a draft; fetches only these two fields, for the sidebar's badge.
pub async fn pull_request_state(repo: &Path, number: u64) -> Result<PullRequestState, String> {
    let number = number.to_string();
    let stdout = run_gh(repo, &["pr", "view", &number, "--json", "state,isDraft"], "view pull request state").await?;
    serde_json::from_slice(&stdout).map_err(|error| format!("failed to parse pull request state: {error}"))
}

/// The pull request in the JSON `gh pr view --json` prints.
fn parse_pull_request_details(json: &[u8]) -> Result<PullRequestDetails, String> {
    let details: GhPullRequestDetails =
        serde_json::from_slice(json).map_err(|error| format!("failed to parse pull request: {error}"))?;
    Ok(PullRequestDetails {
        number: details.number,
        title: details.title,
        body: details.body.unwrap_or_default(),
        author: details.author.login,
        url: details.url,
        state: details.state,
        is_draft: details.is_draft,
        created_at: details.created_at,
        head_ref_name: details.head_ref_name,
        base_ref_name: details.base_ref_name,
        comments: details
            .comments
            .into_iter()
            .map(|comment| PullRequestComment {
                author: comment.author.login,
                body: comment.body.unwrap_or_default(),
                created_at: comment.created_at,
                url: comment.url,
                is_minimized: comment.is_minimized,
            })
            .collect(),
        reviews: details
            .reviews
            .into_iter()
            .map(|review| PullRequestReview {
                author: review.author.login,
                body: review.body.unwrap_or_default(),
                state: review.state,
                submitted_at: review.submitted_at,
            })
            .collect(),
    })
}

/// Review threads of pull request `number` of the GitHub repository `repo` is a clone of, in GitHub's order: the
/// first 100, each with its first 100 comments. A thread GitHub no longer maps to a line of the diff is left out.
pub async fn review_threads(repo: &Path, number: u64) -> Result<Vec<ReviewThread>, String> {
    let query = format!("query={THREADS_QUERY}");
    let number = format!("number={number}");
    let args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", &number, "-f", &query];
    let stdout = run_gh(repo, &args, "list review threads").await?;
    parse_review_threads(&stdout)
}

/// The review threads in the JSON `THREADS_QUERY` returns (see `review_threads`).
fn parse_review_threads(json: &[u8]) -> Result<Vec<ReviewThread>, String> {
    let response: GqlThreadsResponse = serde_json::from_slice(json).map_err(|error| format!("failed to parse review threads: {error}"))?;
    let repository = response
        .data
        .and_then(|data| data.repository)
        .ok_or("failed to list review threads: the remote is not a GitHub repository you can see")?;
    let pull_request = repository.pull_request.ok_or("failed to list review threads: the pull request does not exist")?;
    Ok(pull_request.review_threads.nodes.into_iter().filter_map(flatten_thread).collect())
}

/// The thread with its lines on `diff_side`; `None` for a line thread without a line and a thread without comments.
fn flatten_thread(thread: GqlThread) -> Option<ReviewThread> {
    let (start_line, line) = if thread.subject_type == "FILE" {
        (0, 0)
    } else {
        let line = thread.line?;
        (thread.start_line.unwrap_or(line).min(line), line)
    };
    let comments: Vec<ReviewThreadComment> = thread
        .comments
        .nodes
        .into_iter()
        .map(|comment| {
            let (author, avatar_url) =
                comment.author.map_or_else(|| ("ghost".into(), String::new()), |actor| (actor.login, actor.avatar_url));
            ReviewThreadComment {
                id: comment.id,
                author,
                avatar_url,
                body: comment.body.unwrap_or_default(),
                created_at: comment.created_at,
                url: comment.url,
            }
        })
        .collect();
    if comments.is_empty() {
        return None;
    }
    Some(ReviewThread {
        id: thread.id,
        path: thread.path,
        side: thread.diff_side,
        start_line,
        line,
        is_resolved: thread.is_resolved,
        is_outdated: thread.is_outdated,
        viewer_can_reply: thread.viewer_can_reply,
        viewer_can_resolve: thread.viewer_can_resolve,
        viewer_can_unresolve: thread.viewer_can_unresolve,
        comments,
    })
}

/// The pull requests in the JSON `LIST_QUERY` returns, in GitHub's order.
fn parse_pull_requests(json: &[u8]) -> Result<Vec<PullRequest>, String> {
    let response: GqlResponse =
        serde_json::from_slice(json).map_err(|error| format!("failed to parse pull requests: {error}"))?;
    let data = response.data.ok_or("failed to parse pull requests: the response carries no data")?;
    let repository = data.repository.ok_or("failed to list pull requests: the remote is not a GitHub repository you can see")?;
    let viewer = data.viewer.login;
    Ok(repository.pull_requests.nodes.into_iter().map(|pull_request| flatten_pull_request(pull_request, &viewer)).collect())
}

fn flatten_pull_request(pull_request: GqlPullRequest, viewer: &str) -> PullRequest {
    let viewer_review = viewer_review(&pull_request, viewer);
    let checks = pull_request
        .commits
        .nodes
        .first()
        .and_then(|node| node.commit.status_check_rollup.as_ref())
        .and_then(|rollup| summarize_checks(&rollup.contexts.nodes));
    PullRequest {
        number: pull_request.number,
        title: pull_request.title,
        author: pull_request.author.map(|author| author.login).unwrap_or_else(|| "ghost".to_string()),
        head_ref_name: pull_request.head_ref_name,
        base_ref_name: pull_request.base_ref_name,
        is_draft: pull_request.is_draft,
        created_at: pull_request.created_at,
        updated_at: pull_request.updated_at,
        url: pull_request.url,
        review_decision: pull_request.review_decision.filter(|decision| !decision.is_empty()),
        viewer_review,
        comment_count: pull_request.total_comments_count.unwrap_or_default(),
        checks,
        tasks: count_tasks(pull_request.body.as_deref().unwrap_or_default()),
        additions: pull_request.additions,
        deletions: pull_request.deletions,
        changed_files: pull_request.changed_files,
        labels: pull_request.labels.nodes,
    }
}

/// The signed-in user's part in the review: an outstanding request, else their latest approval or change request,
/// else a comment review. A comment review after an approval keeps the approval, like GitHub's list; a dismissed or
/// pending review counts as none.
fn viewer_review(pull_request: &GqlPullRequest, viewer: &str) -> Option<ViewerReview> {
    let is_requested = pull_request
        .review_requests
        .nodes
        .iter()
        .any(|request| request.requested_reviewer.as_ref().and_then(|reviewer| reviewer.login.as_deref()) == Some(viewer));
    if is_requested {
        return Some(ViewerReview::Requested);
    }
    match review_state(&pull_request.latest_opinionated_reviews, viewer) {
        Some("APPROVED") => Some(ViewerReview::Approved),
        Some("CHANGES_REQUESTED") => Some(ViewerReview::ChangesRequested),
        _ => (review_state(&pull_request.latest_reviews, viewer) == Some("COMMENTED")).then_some(ViewerReview::Commented),
    }
}

/// The state of `author`'s review among `reviews`; `None` when they wrote none.
fn review_state<'a>(reviews: &'a GqlNodes<GqlLatestReview>, author: &str) -> Option<&'a str> {
    reviews
        .nodes
        .iter()
        .find(|review| review.author.as_ref().map(|review_author| review_author.login.as_str()) == Some(author))
        .map(|review| review.state.as_str())
}

/// Buckets the checks of a commit by outcome the way GitHub's rollup does: a neutral or skipped run counts as
/// passed, an unfinished run or a pending status as pending, everything else as failed. `None` without checks.
fn summarize_checks(checks: &[GqlCheck]) -> Option<CheckSummary> {
    if checks.is_empty() {
        return None;
    }
    let mut summary = CheckSummary::default();
    for check in checks {
        let bucket = match (check.status.as_deref(), check.conclusion.as_deref(), check.state.as_deref()) {
            (Some(status), _, _) if status != "COMPLETED" => &mut summary.pending,
            (Some(_), Some("SUCCESS" | "NEUTRAL" | "SKIPPED"), _) => &mut summary.passed,
            (Some(_), _, _) => &mut summary.failed,
            (None, _, Some("SUCCESS")) => &mut summary.passed,
            (None, _, Some("PENDING" | "EXPECTED")) => &mut summary.pending,
            (None, _, _) => &mut summary.failed,
        };
        *bucket += 1;
    }
    Some(summary)
}

/// Counts the task-list checkboxes of a Markdown `body`: lines like `- [ ] todo` or `3. [x] done`; `None` when
/// there are none.
fn count_tasks(body: &str) -> Option<TaskCount> {
    let mut tasks = TaskCount::default();
    for line in body.lines() {
        let Some(rest) = strip_list_marker(line.trim_start()) else { continue };
        let Some(after) = ["[ ]", "[x]", "[X]"].iter().find_map(|checkbox| rest.strip_prefix(checkbox)) else { continue };
        if !after.is_empty() && !after.starts_with(char::is_whitespace) {
            continue;
        }
        tasks.total += 1;
        if !rest.starts_with("[ ]") {
            tasks.done += 1;
        }
    }
    (tasks.total > 0).then_some(tasks)
}

/// The text after a Markdown list marker (`-`, `*`, `+` or `1.`/`1)`) and the whitespace that follows it.
fn strip_list_marker(line: &str) -> Option<&str> {
    let rest = match line.strip_prefix(['-', '*', '+']) {
        Some(rest) => rest,
        None => {
            let digits = line.trim_start_matches(|character: char| character.is_ascii_digit());
            if digits.len() == line.len() {
                return None;
            }
            digits.strip_prefix(['.', ')'])?
        }
    };
    let after_marker = rest.trim_start();
    if after_marker.len() == rest.len() {
        return None;
    }
    Some(after_marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(path: &str, start_line: u32, line: u32, body: &str) -> NewThread {
        NewThread { path: path.into(), start_line, line, body: body.into(), replies: Vec::new() }
    }

    #[test]
    fn review_payload_names_the_event_and_puts_every_comment_on_the_new_side() {
        let payload = review_payload(Some(ReviewEvent::RequestChanges), "Please fix", &[&thread("src/a.ts", 12, 12, "typo")]);
        assert_eq!(payload["event"], "REQUEST_CHANGES");
        assert_eq!(payload["body"], "Please fix");
        assert_eq!(payload["comments"][0]["path"], "src/a.ts");
        assert_eq!(payload["comments"][0]["line"], 12);
        assert_eq!(payload["comments"][0]["side"], "RIGHT");
        assert_eq!(payload["comments"][0]["body"], "typo");
        assert!(payload["comments"][0].get("start_line").is_none());
    }

    #[test]
    fn review_payload_adds_the_start_line_of_a_multi_line_comment_and_omits_an_empty_body() {
        let payload = review_payload(Some(ReviewEvent::Comment), "  ", &[&thread("src/a.ts", 3, 5, "extract")]);
        assert_eq!(payload["event"], "COMMENT");
        assert!(payload.get("body").is_none());
        assert_eq!(payload["comments"][0]["start_line"], 3);
        assert_eq!(payload["comments"][0]["start_side"], "RIGHT");
        assert_eq!(payload["comments"][0]["line"], 5);
        assert_eq!(review_payload(Some(ReviewEvent::Approve), "", &[])["event"], "APPROVE");
    }

    #[test]
    fn review_payload_without_an_event_leaves_the_review_pending() {
        let payload = review_payload(None, "", &[&thread("src/a.ts", 3, 3, "rename")]);
        assert!(payload.get("event").is_none());
        assert!(payload.get("body").is_none());
        assert_eq!(payload["comments"][0]["line"], 3);
    }

    #[test]
    fn submit_review_request_names_the_pending_review_and_the_event_and_omits_an_empty_body() {
        let request = submit_review_request("PRR_1", ReviewEvent::RequestChanges, "Please fix");
        assert!(request["query"].as_str().unwrap().contains("submitPullRequestReview"));
        assert_eq!(request["variables"], serde_json::json!({ "review": "PRR_1", "event": "REQUEST_CHANGES", "body": "Please fix" }));
        let request = submit_review_request("PRR_1", ReviewEvent::Comment, " ");
        assert_eq!(request["variables"], serde_json::json!({ "review": "PRR_1", "event": "COMMENT" }));
    }

    #[test]
    fn only_a_line_thread_without_replies_goes_through_the_rest_api() {
        assert!(thread("src/a.ts", 3, 3, "rename").is_plain_line_thread());
        assert!(!thread("src/a.ts", 0, 0, "split").is_plain_line_thread());
        let answered = NewThread { replies: vec!["and this".into()], ..thread("src/a.ts", 3, 3, "rename") };
        assert!(!answered.is_plain_line_thread());
    }

    #[test]
    fn add_thread_request_puts_lines_on_the_new_side_and_a_file_thread_on_the_file() {
        let request = add_thread_request("PRR_1", &thread("src/a.ts", 12, 12, "typo"));
        assert!(request["query"].as_str().unwrap().contains("addPullRequestReviewThread"));
        assert_eq!(request["variables"], serde_json::json!({ "review": "PRR_1", "path": "src/a.ts", "body": "typo", "line": 12, "side": "RIGHT" }));
        let request = add_thread_request("PRR_1", &thread("src/a.ts", 3, 5, "extract"));
        assert_eq!(
            request["variables"],
            serde_json::json!({ "review": "PRR_1", "path": "src/a.ts", "body": "extract", "line": 5, "side": "RIGHT", "startLine": 3, "startSide": "RIGHT" })
        );
        let request = add_thread_request("PRR_1", &thread("src/a.ts", 0, 0, "split"));
        assert_eq!(request["variables"], serde_json::json!({ "review": "PRR_1", "path": "src/a.ts", "body": "split", "subjectType": "FILE" }));
    }

    #[test]
    fn add_reply_request_names_the_pending_review_only_when_there_is_one() {
        let request = add_reply_request(Some("PRR_1"), "PRRT_1", "Agreed");
        assert!(request["query"].as_str().unwrap().contains("addPullRequestReviewThreadReply"));
        assert_eq!(request["variables"], serde_json::json!({ "review": "PRR_1", "thread": "PRRT_1", "body": "Agreed" }));
        let request = add_reply_request(None, "PRRT_1", "Agreed");
        assert_eq!(request["variables"], serde_json::json!({ "thread": "PRRT_1", "body": "Agreed" }));
    }

    #[test]
    fn parse_added_thread_id_reads_the_new_thread_or_fails() {
        assert_eq!(parse_added_thread_id(br#"{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_9"}}}}"#).unwrap(), "PRRT_9");
        let error = parse_added_thread_id(br#"{"data":{"addPullRequestReviewThread":{"thread":null}}}"#).unwrap_err();
        assert_eq!(error, "failed to add review thread: GitHub returned no thread");
    }

    #[test]
    fn review_comment_reads_drafts_without_a_reply_target_and_round_trips_one() {
        let json = r#"{"id":"6f9619ff-8b86-d011-b42d-00cf4fc964ff","path":"a.ts","startLine":1,"line":1,"body":"x","createdAt":"2026-10-12T10:00:00Z"}"#;
        let draft: ReviewComment = serde_json::from_str(json).unwrap();
        assert_eq!(draft.reply_to, None);
        let reply = ReviewComment { reply_to: Some(ReplyTarget::Thread("PRRT_1".into())), ..draft.clone() };
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["replyTo"], serde_json::json!({ "kind": "thread", "id": "PRRT_1" }));
        let parent = Uuid::new_v4();
        let reply = ReviewComment { reply_to: Some(ReplyTarget::Draft(parent)), ..draft };
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["replyTo"], serde_json::json!({ "kind": "draft", "id": parent.to_string() }));
        let back: ReviewComment = serde_json::from_value(value).unwrap();
        assert_eq!(back.reply_to, Some(ReplyTarget::Draft(parent)));
    }

    /// A list response with one pull request as seen by `viewer`; `latest_reviews`, `opinionated_reviews` and
    /// `review_requests` are the nodes of the respective connections.
    fn list_json(viewer: &str, latest_reviews: &str, opinionated_reviews: &str, review_requests: &str) -> Vec<u8> {
        format!(
            r#"{{"data":{{"viewer":{{"login":"{viewer}"}},"repository":{{"pullRequests":{{"nodes":[{{
                "number":261,"title":"export all reports","url":"https://github.com/o/r/pull/261","isDraft":false,
                "createdAt":"2026-09-01T08:00:00Z","updatedAt":"2026-09-11T12:56:54Z","headRefName":"fixes/csv-export",
                "baseRefName":"main","body":null,"author":{{"login":"alice"}},"additions":10,"deletions":2,"changedFiles":3,
                "totalCommentsCount":11,"reviewDecision":null,"labels":{{"nodes":[]}},"latestReviews":{{"nodes":[{latest_reviews}]}},
                "latestOpinionatedReviews":{{"nodes":[{opinionated_reviews}]}},"reviewRequests":{{"nodes":[{review_requests}]}},"commits":{{"nodes":[{{"commit":{{"statusCheckRollup":null}}}}]}}
            }}]}}}}}}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn parse_pull_requests_flattens_the_author_and_keeps_the_order() {
        let json = br#"{"data":{"viewer":{"login":"carol"},"repository":{"pullRequests":{"nodes":[
            {"number":261,"title":"export all reports","url":"https://github.com/o/r/pull/261","isDraft":false,
             "createdAt":"2026-09-01T08:00:00Z","updatedAt":"2026-09-11T12:56:54Z",
             "headRefName":"fixes/csv-export","baseRefName":"main",
             "body":"- [x] export\n- [ ] import\n1. [ ] docs\n-[ ] not a task\n- [ ]neither","author":{"login":"alice"},
             "additions":562,"deletions":291,"changedFiles":13,"totalCommentsCount":11,"reviewDecision":"APPROVED",
             "labels":{"nodes":[{"name":"bug","color":"d73a4a"}]},
             "latestReviews":{"nodes":[{"author":{"login":"carol"},"state":"APPROVED"}]},
             "latestOpinionatedReviews":{"nodes":[{"author":{"login":"carol"},"state":"APPROVED"}]},
             "reviewRequests":{"nodes":[{"requestedReviewer":{"login":"bob"}},{"requestedReviewer":{}}]},
             "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
               {"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"COMPLETED","conclusion":"SKIPPED"},
               {"status":"COMPLETED","conclusion":"FAILURE"},{"status":"IN_PROGRESS","conclusion":null},
               {"state":"SUCCESS"},{"state":"PENDING"},{"state":"ERROR"}]}}}}]}},
            {"number":258,"title":"Feat/hyphens","url":"https://github.com/o/r/pull/258","isDraft":true,
             "createdAt":"2026-07-01T08:00:00Z","updatedAt":"2026-07-13T21:08:33Z","headRefName":"feat/hyphens","baseRefName":"develop",
             "body":"","author":null,"additions":0,"deletions":0,"changedFiles":0,"totalCommentsCount":0,"reviewDecision":"",
             "labels":{"nodes":[]},"latestReviews":{"nodes":[]},"latestOpinionatedReviews":{"nodes":[]},"reviewRequests":{"nodes":[]},
             "commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}
        ]}}}}"#;
        let pull_requests = parse_pull_requests(json).unwrap();
        assert_eq!(pull_requests.len(), 2);
        let first = &pull_requests[0];
        assert_eq!(first.number, 261);
        assert_eq!(first.author, "alice");
        assert_eq!(first.head_ref_name, "fixes/csv-export");
        assert_eq!(first.base_ref_name, "main");
        assert!(!first.is_draft);
        assert_eq!(first.created_at, "2026-09-01T08:00:00Z");
        assert_eq!(first.review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(first.viewer_review, Some(ViewerReview::Approved));
        assert_eq!(first.comment_count, 11);
        assert_eq!(first.checks, Some(CheckSummary { passed: 3, failed: 2, pending: 2 }));
        assert_eq!(first.tasks, Some(TaskCount { done: 1, total: 3 }));
        assert_eq!((first.additions, first.deletions, first.changed_files), (562, 291, 13));
        assert_eq!(first.labels, vec![Label { name: "bug".into(), color: "d73a4a".into() }]);
        let second = &pull_requests[1];
        assert_eq!(second.number, 258);
        assert!(second.is_draft);
        assert_eq!(second.author, "ghost");
        assert_eq!(second.url, "https://github.com/o/r/pull/258");
        assert_eq!(second.review_decision, None);
        assert_eq!(second.viewer_review, None);
        assert_eq!(second.checks, None);
        assert_eq!(second.tasks, None);
    }

    #[test]
    fn viewer_review_prefers_an_outstanding_request_over_an_earlier_review() {
        let viewer_review = |latest_reviews: &str, opinionated_reviews: &str, review_requests: &str| {
            parse_pull_requests(&list_json("carol", latest_reviews, opinionated_reviews, review_requests)).unwrap()[0].viewer_review
        };
        let commented = r#"{"author":{"login":"carol"},"state":"COMMENTED"}"#;
        let approved = r#"{"author":{"login":"carol"},"state":"APPROVED"}"#;
        assert_eq!(viewer_review(commented, approved, r#"{"requestedReviewer":{"login":"carol"}}"#), Some(ViewerReview::Requested));
        let other_requests = r#"{"requestedReviewer":{"login":"bob"}},{"requestedReviewer":{}}"#;
        assert_eq!(viewer_review(commented, "", other_requests), Some(ViewerReview::Commented));
        let changes = r#"{"author":{"login":"carol"},"state":"CHANGES_REQUESTED"}"#;
        assert_eq!(viewer_review(changes, changes, ""), Some(ViewerReview::ChangesRequested));
        let dismissed = r#"{"author":{"login":"carol"},"state":"DISMISSED"}"#;
        assert_eq!(viewer_review(dismissed, dismissed, ""), None);
        let approved_by_bob = r#"{"author":{"login":"bob"},"state":"APPROVED"}"#;
        assert_eq!(viewer_review(approved_by_bob, approved_by_bob, ""), None);
        assert_eq!(viewer_review("", "", ""), None);
    }

    #[test]
    fn viewer_review_keeps_an_approval_that_a_later_comment_review_follows() {
        let commented = r#"{"author":{"login":"carol"},"state":"COMMENTED"}"#;
        let approved = r#"{"author":{"login":"carol"},"state":"APPROVED"}"#;
        let pull_requests = parse_pull_requests(&list_json("carol", commented, approved, "")).unwrap();
        assert_eq!(pull_requests[0].viewer_review, Some(ViewerReview::Approved));
        let dismissed = r#"{"author":{"login":"carol"},"state":"DISMISSED"}"#;
        let pull_requests = parse_pull_requests(&list_json("carol", commented, dismissed, "")).unwrap();
        assert_eq!(pull_requests[0].viewer_review, Some(ViewerReview::Commented));
    }

    #[test]
    fn parse_pull_requests_rejects_a_repository_gh_cannot_see() {
        let json = br#"{"data":{"viewer":{"login":"carol"},"repository":null}}"#;
        assert!(parse_pull_requests(json).unwrap_err().contains("not a GitHub repository"));
    }

    #[test]
    fn parse_pull_request_details_flattens_authors_and_keeps_comments_and_reviews() {
        let json = br#"{"author":{"is_bot":true,"login":"app/github-actions"},"baseRefName":"trunk","body":"Bumps **Go**.",
            "comments":[{"author":{"login":"alice"},"body":"Looks fine","createdAt":"2026-10-09T10:07:25Z","isMinimized":false,
                         "url":"https://github.com/o/r/pull/14632#issuecomment-1"}],
            "createdAt":"2026-10-09T09:55:50Z","headRefName":"bump-go-1.27.2","isDraft":false,"number":14632,
            "reviews":[{"author":{"login":"bob"},"body":"","state":"APPROVED","submittedAt":"2026-10-09T10:07:57Z"}],
            "state":"MERGED","title":"Bump Go to 1.27.2","url":"https://github.com/o/r/pull/14632"}"#;
        let details = parse_pull_request_details(json).unwrap();
        assert_eq!(details.number, 14632);
        assert_eq!(details.author, "app/github-actions");
        assert_eq!(details.body, "Bumps **Go**.");
        assert_eq!(details.state, "MERGED");
        assert_eq!(details.comments.len(), 1);
        assert_eq!(details.comments[0].author, "alice");
        assert!(!details.comments[0].is_minimized);
        assert_eq!(details.reviews.len(), 1);
        assert_eq!(details.reviews[0].state, "APPROVED");
        assert_eq!(details.reviews[0].body, "");
    }

    #[test]
    fn parse_pull_request_details_accepts_a_missing_body_and_conversation() {
        let json = br#"{"author":{"login":"alice"},"baseRefName":"main","body":null,"createdAt":"2026-10-09T09:55:50Z",
            "headRefName":"feat","isDraft":true,"number":1,"state":"OPEN","title":"Feat","url":"https://github.com/o/r/pull/1"}"#;
        let details = parse_pull_request_details(json).unwrap();
        assert_eq!(details.body, "");
        assert!(details.comments.is_empty());
        assert!(details.reviews.is_empty());
    }

    #[test]
    fn parse_viewer_reads_the_login_and_avatar() {
        let json = br#"{"login":"carol","id":1,"avatar_url":"https://avatars.githubusercontent.com/u/1?v=4","type":"User"}"#;
        let viewer = parse_viewer(json).unwrap();
        assert_eq!(viewer, GithubViewer { login: "carol".into(), avatar_url: "https://avatars.githubusercontent.com/u/1?v=4".into() });
        assert_eq!(serde_json::to_string(&viewer).unwrap(), r#"{"login":"carol","avatarUrl":"https://avatars.githubusercontent.com/u/1?v=4"}"#);
    }

    #[test]
    fn parse_review_threads_reads_lines_sides_and_replies_and_drops_unmapped_threads() {
        let json = br#"{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
          {"id":"T1","path":"src/a.ts","line":46,"startLine":39,"diffSide":"RIGHT","subjectType":"LINE","isResolved":false,"isOutdated":false,
           "viewerCanReply":true,"viewerCanResolve":true,"viewerCanUnresolve":false,
           "comments":{"nodes":[
             {"id":"C1","author":{"login":"carol","avatarUrl":"https://avatars/carol"},"body":"Why?","createdAt":"2026-10-01T10:00:00Z","url":"u1"},
             {"id":"C2","author":null,"body":null,"createdAt":"2026-10-02T10:00:00Z","url":"u2"}]}},
          {"id":"T2","path":"src/a.ts","line":12,"startLine":null,"diffSide":"LEFT","subjectType":"LINE","isResolved":true,"isOutdated":true,
           "comments":{"nodes":[{"id":"C3","author":{"login":"dave","avatarUrl":"https://avatars/dave"},"body":"Gone","createdAt":"2026-10-03T10:00:00Z","url":"u3"}]}},
          {"id":"T3","path":"src/b.ts","line":null,"startLine":null,"diffSide":"RIGHT","subjectType":"FILE","isResolved":false,"isOutdated":false,
           "comments":{"nodes":[{"id":"C4","author":{"login":"carol","avatarUrl":"https://avatars/carol"},"body":"File","createdAt":"2026-10-04T10:00:00Z","url":"u4"}]}},
          {"id":"T4","path":"src/b.ts","line":null,"startLine":null,"diffSide":"RIGHT","subjectType":"LINE","isResolved":false,"isOutdated":true,
           "comments":{"nodes":[{"id":"C5","author":{"login":"carol","avatarUrl":"https://avatars/carol"},"body":"Old","createdAt":"2026-10-05T10:00:00Z","url":"u5"}]}}
        ]}}}}}"#;
        let threads = parse_review_threads(json).unwrap();
        let spans: Vec<_> = threads.iter().map(|thread| (thread.id.as_str(), thread.side, thread.start_line, thread.line)).collect();
        assert_eq!(spans, [("T1", DiffSide::Right, 39, 46), ("T2", DiffSide::Left, 12, 12), ("T3", DiffSide::Right, 0, 0)]);
        assert_eq!(threads[0].comments[1].author, "ghost");
        assert_eq!(threads[0].comments[1].avatar_url, "");
        assert_eq!(threads[0].comments[1].body, "");
        assert!(threads[1].is_resolved && threads[1].is_outdated);
        assert!(threads[0].viewer_can_reply && threads[0].viewer_can_resolve && !threads[0].viewer_can_unresolve);
        assert!(!threads[1].viewer_can_reply);
        let json = serde_json::to_value(&threads[1]).unwrap();
        assert_eq!(json["side"], "left");
        assert_eq!(json["startLine"], 12);
        assert_eq!(json["comments"][0]["avatarUrl"], "https://avatars/dave");
        assert_eq!(json["viewerCanResolve"], false);
    }

    #[test]
    fn parse_review_threads_rejects_a_missing_pull_request() {
        let json = br#"{"data":{"repository":{"pullRequest":null}}}"#;
        assert_eq!(parse_review_threads(json).unwrap_err(), "failed to list review threads: the pull request does not exist");
    }

    #[test]
    fn parse_pull_requests_rejects_malformed_output() {
        assert!(parse_pull_requests(b"not json").unwrap_err().starts_with("failed to parse pull requests"));
    }
}
