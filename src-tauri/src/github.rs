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
/// of `path` (a single-line comment has `start_line == line`). Stored with the session until the review is submitted.
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
}

/// An inline comment of a review as the GitHub API takes it: on lines `start_line..=line` of the new version of
/// `path`, which must lie inside a hunk of the pull request's diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineComment {
    pub path: String,
    pub start_line: u32,
    pub line: u32,
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

/// Submits a review with inline `comments` through the REST API, which `gh pr review` cannot do; without comments
/// this is `submit_review`. With comments the summary may be empty, as in GitHub's own review dialog.
pub async fn submit_review_with_comments(repo: &Path, number: u64, event: ReviewEvent, body: &str, comments: &[InlineComment]) -> Result<(), String> {
    if comments.is_empty() {
        return submit_review(repo, number, event, body).await;
    }
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews");
    let payload = serde_json::to_vec(&review_payload(event, body, comments)).map_err(|error| format!("failed to submit review: {error}"))?;
    run_gh_with_input(repo, &["api", "--method", "POST", &endpoint, "--input", "-"], &payload, "submit review").await?;
    Ok(())
}

/// Request body of `POST /pulls/{number}/reviews`: every comment sits on the new side (`RIGHT`); a multi-line one
/// also names its first line. An empty summary is left out rather than sent as an empty string.
fn review_payload(event: ReviewEvent, body: &str, comments: &[InlineComment]) -> serde_json::Value {
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
    let mut payload = serde_json::json!({ "event": event.api_name(), "comments": comments });
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

/// The signed-in user's part in the review: an outstanding request, else the verdict of their latest review. A
/// dismissed or pending review counts as none.
fn viewer_review(pull_request: &GqlPullRequest, viewer: &str) -> Option<ViewerReview> {
    let is_requested = pull_request
        .review_requests
        .nodes
        .iter()
        .any(|request| request.requested_reviewer.as_ref().and_then(|reviewer| reviewer.login.as_deref()) == Some(viewer));
    if is_requested {
        return Some(ViewerReview::Requested);
    }
    let review = pull_request
        .latest_reviews
        .nodes
        .iter()
        .find(|review| review.author.as_ref().map(|author| author.login.as_str()) == Some(viewer))?;
    match review.state.as_str() {
        "APPROVED" => Some(ViewerReview::Approved),
        "CHANGES_REQUESTED" => Some(ViewerReview::ChangesRequested),
        "COMMENTED" => Some(ViewerReview::Commented),
        _ => None,
    }
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

    fn inline(path: &str, start_line: u32, line: u32, body: &str) -> InlineComment {
        InlineComment { path: path.into(), start_line, line, body: body.into() }
    }

    #[test]
    fn review_payload_names_the_event_and_puts_every_comment_on_the_new_side() {
        let payload = review_payload(ReviewEvent::RequestChanges, "Please fix", &[inline("src/a.ts", 12, 12, "typo")]);
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
        let payload = review_payload(ReviewEvent::Comment, "  ", &[inline("src/a.ts", 3, 5, "extract")]);
        assert_eq!(payload["event"], "COMMENT");
        assert!(payload.get("body").is_none());
        assert_eq!(payload["comments"][0]["start_line"], 3);
        assert_eq!(payload["comments"][0]["start_side"], "RIGHT");
        assert_eq!(payload["comments"][0]["line"], 5);
        assert_eq!(review_payload(ReviewEvent::Approve, "", &[])["event"], "APPROVE");
    }

    /// A list response with one pull request as seen by `viewer`; `latest_reviews` and `review_requests` are the
    /// nodes of the respective connections.
    fn list_json(viewer: &str, latest_reviews: &str, review_requests: &str) -> Vec<u8> {
        format!(
            r#"{{"data":{{"viewer":{{"login":"{viewer}"}},"repository":{{"pullRequests":{{"nodes":[{{
                "number":261,"title":"export all reports","url":"https://github.com/o/r/pull/261","isDraft":false,
                "createdAt":"2026-09-01T08:00:00Z","updatedAt":"2026-09-11T12:56:54Z","headRefName":"fixes/csv-export",
                "baseRefName":"main","body":null,"author":{{"login":"alice"}},"additions":10,"deletions":2,"changedFiles":3,
                "totalCommentsCount":11,"reviewDecision":null,"labels":{{"nodes":[]}},"latestReviews":{{"nodes":[{latest_reviews}]}},
                "reviewRequests":{{"nodes":[{review_requests}]}},"commits":{{"nodes":[{{"commit":{{"statusCheckRollup":null}}}}]}}
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
             "reviewRequests":{"nodes":[{"requestedReviewer":{"login":"bob"}},{"requestedReviewer":{}}]},
             "commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
               {"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"COMPLETED","conclusion":"SKIPPED"},
               {"status":"COMPLETED","conclusion":"FAILURE"},{"status":"IN_PROGRESS","conclusion":null},
               {"state":"SUCCESS"},{"state":"PENDING"},{"state":"ERROR"}]}}}}]}},
            {"number":258,"title":"Feat/hyphens","url":"https://github.com/o/r/pull/258","isDraft":true,
             "createdAt":"2026-07-01T08:00:00Z","updatedAt":"2026-07-13T21:08:33Z","headRefName":"feat/hyphens","baseRefName":"develop",
             "body":"","author":null,"additions":0,"deletions":0,"changedFiles":0,"totalCommentsCount":0,"reviewDecision":"",
             "labels":{"nodes":[]},"latestReviews":{"nodes":[]},"reviewRequests":{"nodes":[]},
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
        let viewer_review = |latest_reviews: &str, review_requests: &str| {
            parse_pull_requests(&list_json("carol", latest_reviews, review_requests)).unwrap()[0].viewer_review
        };
        let commented = r#"{"author":{"login":"carol"},"state":"COMMENTED"}"#;
        assert_eq!(viewer_review(commented, r#"{"requestedReviewer":{"login":"carol"}}"#), Some(ViewerReview::Requested));
        let other_requests = r#"{"requestedReviewer":{"login":"bob"}},{"requestedReviewer":{}}"#;
        assert_eq!(viewer_review(commented, other_requests), Some(ViewerReview::Commented));
        let changes = r#"{"author":{"login":"carol"},"state":"CHANGES_REQUESTED"}"#;
        assert_eq!(viewer_review(changes, ""), Some(ViewerReview::ChangesRequested));
        assert_eq!(viewer_review(r#"{"author":{"login":"carol"},"state":"DISMISSED"}"#, ""), None);
        assert_eq!(viewer_review(r#"{"author":{"login":"bob"},"state":"APPROVED"}"#, ""), None);
        assert_eq!(viewer_review("", ""), None);
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
    fn parse_pull_requests_rejects_malformed_output() {
        assert!(parse_pull_requests(b"not json").unwrap_err().starts_with("failed to parse pull requests"));
    }
}
