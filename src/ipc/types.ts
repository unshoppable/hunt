import type {
  AvailableCommand,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type SessionView = {
  id: string;
  title: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  acpSessionId: string | null;
  createdAt: string;
  isLive: boolean;
  /** Set for a sub chat: the top-level session whose worktree it shares. */
  parentId: string | null;
  /** The diff selection a sub chat was opened from. */
  selection: SelectionContext | null;
  /** Short bullet points of what happened in the session so far, written by the background summarizer. */
  summary: string[];
  /** Worktree-relative paths whose uncommitted changes this session's tool calls produced. */
  touchedFiles: string[];
  /**
   * When this session last changed files in its worktree: an agent edit, a save in a Hunt pane, or a revert,
   * commit, shelve or unshelve. The component diagram counts as outdated once it predates this.
   */
  worktreeChangedAt: string | null;
  /** The pull request this session reviews, when it was started from one; sub sessions share their parent's. */
  pullRequest: PullRequestRef | null;
  /** Commit the changelist and the diffs compare the worktree against; `null` means `HEAD`. A pull request review uses its merge base. */
  diffBase: string | null;
  /** Review comments drafted for the pull request and not yet submitted; a sub session drafts into its parent's list. */
  reviewComments: ReviewComment[];
};

/**
 * A review comment drafted in Hunt and not yet submitted, on lines `startLine..line` of the new version of `path`
 * (a single-line comment has `startLine === line`). Posted inline when the lines lie in a hunk of the pull request's
 * diff, otherwise as a note in the review summary.
 */
export type ReviewComment = {
  id: string;
  path: string;
  startLine: number;
  line: number;
  body: string;
  createdAt: string;
};

/** The pull request a session reviews: enough to show it and to open it on GitHub. */
export type PullRequestRef = {
  number: number;
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

/** An open pull request of the repository's GitHub remote, with the metadata GitHub's pull request list shows. */
export type PullRequest = {
  number: number;
  title: string;
  /** GitHub login of the author; `ghost` for a deleted account. */
  author: string;
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

/** Lines selected in the working-tree version of a changed file; line numbers are 1-based and inclusive. */
export type SelectionContext = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** What the sub chat is for when it was not opened from a code selection (see guardrails); replaces the default framing. */
  task?: string;
};

export type ChangedFile = {
  path: string;
  /** Single-letter git status: A, M, D, R, or ? for untracked. */
  status: string;
};

/** A changed file of the worktree plus the ids of the sessions sharing it whose tool calls touched the file. */
export type ChangedFileView = ChangedFile & {
  /** Empty when the change was made outside the agents, for example in an IDE or by restoring a shelf. */
  touchedBy: string[];
};

/** A named set of changes parked in `git stash`, scoped to the session's branch. */
export type Shelf = {
  /** Stash reference such as `stash@{0}`; valid until the stash list changes. */
  reference: string;
  name: string;
  createdAt: string;
  files: ChangedFile[];
};

export type FileDiff = {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  unified: string;
};

/** One entry of a worktree directory listing. */
export type DirEntry = { name: string; isDir: boolean };

/** Added and removed lines of one uncommitted change; an untracked file counts every line as added. */
export type ChangeStat = { path: string; added: number; removed: number };

/** How much a human should review a file, 4 being the most: interfaces, data models, auth, payments, central abstractions. */
export type ReviewLevel = 1 | 2 | 3 | 4;

/**
 * One file of the component diagram; the worktree-relative `path` identifies the node. `review` is the agent's rating of
 * the file's review relevance and `reviewReason` the one-sentence criterion behind it.
 */
export type GraphNode = { path: string; description?: string; review?: ReviewLevel; reviewReason?: string };

/**
 * `source` depends on `target` (both node paths). `label` names what the dependency is for in one to three words
 * (`business logic`, `types only`), `description` says in a few sentences how `source` uses `target` and what for.
 */
export type GraphEdge = { source: string; target: string; label: string; description?: string };

/** The validated content of `.hunt/graph.json` (see src-tauri/src/graph.schema.json). */
export type ArchitectureGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Age of the diagram: when `.hunt/graph.json` was last written, and whether session files changed since. */
export type GraphStatus = { generatedAt: string | null; isOutdated: boolean };

/** `_meta` Hunt attaches to the chunks of a user turn it sent itself; the chat shows `label` instead of the text. `harness` is the key older transcripts used. */
export type HuntChunkMeta = { hunt?: HiddenChunk; harness?: HiddenChunk };
type HiddenChunk = { hidden?: boolean; label?: string };

export type UpdateEvent = { huntSessionId: string; notification: SessionNotification };
export type PermissionEvent = { huntSessionId: string; requestId: string; request: RequestPermissionRequest };
export type ClosedEvent = { huntSessionId: string; error: string | null };
export type GraphChangedEvent = { huntSessionId: string };
/** Sent after a tool call changed files in `worktreePath`; every session of that worktree reloads its changes. */
export type AttributionEvent = { worktreePath: string };
/** Result of the background summarizer after a finished turn; `title` is the (possibly unchanged) session title. */
export type SummaryEvent = { huntSessionId: string; title: string; summary: string[] };

export type ToolCallView = {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  terminalOutput?: string;
};

export type ChatItem =
  | { kind: "user"; id: string; text: string; images: string[] }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; toolCall: ToolCallView }
  /** A turn Hunt sent on the user's behalf, shown as a status line. */
  | { kind: "status"; id: string; text: string };

export type PendingPermission = {
  requestId: string;
  toolCall: RequestPermissionRequest["toolCall"];
  options: PermissionOption[];
};

export type { AvailableCommand, PlanEntry, SessionNotification };

/** Diagnostics the language server pushed for one document of `worktreePath` (LSP `publishDiagnostics` params). */
export type LspDiagnosticsEvent = { worktreePath: string; uri: string; diagnostics: unknown };
/** The language server process of `worktreePath` ended; the next request starts a new one. */
export type LspExitedEvent = { worktreePath: string };

/** A file to show in an editor window, with an optional 1-based caret position. */
export type EditorOpenRequest = { path: string; line?: number; column?: number; inRightSplit?: boolean };

/** A changed file of a session to show in a diff window (see graph/diffWindows.ts). */
export type DiffOpenRequest = { sessionId: string; path: string };

/** An image file in the macOS screenshot folder. */
export type Screenshot = {
  name: string;
  /** Absolute path. */
  path: string;
  /** Last modification as unix milliseconds. */
  modifiedAt: number;
};
