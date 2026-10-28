/**
 * A review comment drafted in Hunt and not yet submitted, on lines `startLine..line` of the new version of `path`
 * (a single-line comment has `startLine === line`), or on the whole file when both are 0. Posted inline when the
 * lines lie in a hunk of the pull request's diff, on the file when the file is part of it, otherwise as a note in the
 * review summary. A reply carries the path and lines of what it answers and goes out with it.
 */
export type ReviewComment = {
  id: string;
  path: string;
  startLine: number;
  line: number;
  body: string;
  createdAt: string;
  /** What the comment answers; null for a comment that opens a thread. */
  replyTo: ReplyTarget | null;
};

/** What a drafted reply answers: a review thread on GitHub (its node ID) or a drafted comment that opens a thread. */
export type ReplyTarget = { kind: "thread" | "draft"; id: string };

/**
 * A review thread of the pull request on GitHub: comments on lines `startLine..line` of `side` of `path` (both 0 for a
 * thread on the whole file), oldest first; the first comment opened the thread, the others reply to it.
 */
export type ReviewThread = {
  id: string;
  path: string;
  side: DiffSide;
  startLine: number;
  line: number;
  isResolved: boolean;
  /** The commented code changed after the first comment; GitHub still maps the thread to `line`. */
  isOutdated: boolean;
  /** Whether the signed-in user may answer the thread, resolve it, or mark it as unresolved again. */
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  comments: ReviewThreadComment[];
};

/** Side of a pull request's diff: lines of `left` number the base version of a file, lines of `right` the new one. */
export type DiffSide = "left" | "right";

export type ReviewThreadComment = {
  id: string;
  /** GitHub login of the author; `ghost` for a deleted account. */
  author: string;
  /** Empty for a deleted account. */
  avatarUrl: string;
  body: string;
  createdAt: string;
  url: string;
};

/** The verdict of a submitted review, as `gh pr review` names it. */
export type ReviewEvent = "approve" | "requestChanges" | "comment";

/** A pull request with its description and conversation, as `gh pr view` reports it. */
export type PullRequestDetails = {
  number: number;
  title: string;
  /** Markdown description; empty when the author left it blank. */
  body: string;
  /** GitHub login of the author. */
  author: string;
  url: string;
  /** `OPEN`, `CLOSED` or `MERGED`. */
  state: string;
  isDraft: boolean;
  createdAt: string;
  headRefName: string;
  baseRefName: string;
  /** Conversation comments, oldest first. */
  comments: PullRequestComment[];
  /** Submitted reviews, oldest first. */
  reviews: PullRequestReview[];
};

export type PullRequestComment = {
  author: string;
  body: string;
  createdAt: string;
  url: string;
  /** Hidden on GitHub, e.g. as spam or off-topic. */
  isMinimized: boolean;
};

export type PullRequestReview = {
  author: string;
  /** Summary text of the review; empty for a bare approval. */
  body: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  submittedAt: string;
};

/** The GitHub account the `gh` CLI is logged in as. */
export type GithubViewer = {
  login: string;
  avatarUrl: string;
};
