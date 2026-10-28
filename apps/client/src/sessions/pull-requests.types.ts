/** State of a pull request (mirror of `PullRequestState` in src-tauri/src/github/github.rs), for the sidebar's badge. */
export type PullRequestState = {
  /** `OPEN`, `CLOSED` or `MERGED`. */
  state: string;
  isDraft: boolean;
};

/** An open pull request of the repository's GitHub remote, with the metadata GitHub's pull request list shows. */
export type PullRequest = {
  number: number;
  title: string;
  /** GitHub login of the author; `ghost` for a deleted account. */
  author: string;
  /** The author's avatar image; empty for a deleted account. */
  authorAvatarUrl: string;
  /** Branch the pull request merges from, as named on GitHub (without a remote prefix). */
  headRefName: string;
  /** Branch the pull request merges into, as named on GitHub (without a remote prefix). */
  baseRefName: string;
  isDraft: boolean;
  /** ISO 8601 timestamp of when the pull request was opened. */
  createdAt: string;
  /** ISO 8601 timestamp of the last change to the pull request. */
  updatedAt: string;
  url: string;
  /** `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; `null` when the repository requires no review. */
  reviewDecision: string | null;
  /** The signed-in user's part in the review; `null` when they neither reviewed nor were asked to. */
  viewerReview: ViewerReview | null;
  /** Conversation and review comments, as GitHub counts them in its list. */
  commentCount: number;
  /** Outcome of the status checks of the head commit; `null` when none ran. */
  checks: CheckSummary | null;
  /** Task-list checkboxes in the description; `null` when there are none. */
  tasks: TaskCount | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: PullRequestLabel[];
};

/**
 * How the signed-in user stands to a pull request's review: asked for one, or the verdict of the latest review they
 * left. An outstanding request wins over an earlier review, as GitHub shows it.
 */
export type ViewerReview = "requested" | "approved" | "changesRequested" | "commented";

/** Status checks of a commit by outcome; GitHub's list shows `passed` of the total. */
export type CheckSummary = {
  passed: number;
  failed: number;
  pending: number;
};

/** Task-list checkboxes of a Markdown body: `- [x]` is done, `- [ ]` is open. */
export type TaskCount = {
  done: number;
  total: number;
};

/** A GitHub label; `color` is a hex triplet without `#`. */
export type PullRequestLabel = {
  name: string;
  color: string;
};
