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
  /** Where the session works: a worktree Hunt created and owns, or the repository's own checkout. */
  workspace: Workspace;
  /**
   * Set when the session's worktree works on a branch that existed before the session (a reviewed pull request's),
   * which deleting the session keeps; otherwise Hunt created the branch and deletes it with the worktree.
   */
  keepsBranch: boolean;
  /** Set while the session is handed off to a VM: its agent runs there and the local worktree waits for its retrieval. */
  remote: RemoteTarget | null;
  /**
   * The session VM a failed handoff left behind (also set while a handoff runs); the next handoff reuses it and
   * deleting the session deletes it.
   */
  leftoverVm: VmRef | null;
  /** Progress of preparing the worktree's `node_modules`; `null` when nothing was or is being prepared. */
  dependencies: DependencyStatus | null;
};

/** What the preparation of a worktree's `node_modules` (clone from the repository, else install) is doing or ended with. */
export type DependencyStatus = { phase: "running" | "ready" | "failed"; message: string };

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

/**
 * Where a session works: `worktree` is a worktree created and deleted with the session, on a new
 * `feat/general/<slug>-<id>` branch off the base branch or, for a pull request review, on the pull request's branch;
 * `checkout` is the repository's own checkout on whatever branch it has, which Hunt leaves alone.
 */
export type Workspace = "worktree" | "checkout";

/** A Compute Engine VM: a session's own VM or the gateway. */
export type VmRef = { project: string; zone: string; instance: string };

/**
 * How Hunt reaches the gateway, from Settings → Remote VM (mirror of `VmSettings` in src-tauri/src/remote/mod.rs): the
 * backend finds the VM of `project` labelled `hunt-role=gateway`, whose API provisions, starts and deletes the session
 * VMs.
 */
export type VmSettings = { project: string };

/**
 * Who started a remote session on its VM: `handoff` is this Mac, whose local worktree waits for the session; `desktop`
 * is another person's Hunt and `swf` the gateway's poller for a GitHub issue, whose VMs this Mac adopted.
 */
export type RemoteOrigin = "handoff" | "desktop" | "swf";

/** Where a session handed off to a VM runs (mirror of `RemoteTarget` in src-tauri/src/remote/mod.rs). */
export type RemoteTarget = {
  /** The session's own VM, `vm-hunt-s-<short>`. */
  vm: VmRef;
  /**
   * The session's worktree on the VM; tool calls of its agent name files below this path. Empty for an adopted session
   * until Hunt first reached its VM.
   */
  worktreePath: string;
  /** `<owner>/<repo>` of the repository on the VM. */
  repo: string;
  branch: string;
  /** The commit the local branch had at the handoff; empty for an adopted session. */
  handoffHead: string;
  /** When the session went to its VM; for an adopted session when this Mac adopted it. */
  handedOffAt: string;
  /** The permission mode the session had locally, which the retrieval restores; null for older handoffs. */
  localMode: string | null;
  /** When the agent last worked on the session (a prompt Hunt sent or a turn that ended); null until the first one. */
  lastActiveAt: string | null;
  /** When Hunt last asked whether to retrieve or delete the idle session and the user chose to wait. */
  cleanupAskedAt: string | null;
  /** The preview domain the session was handed off with, which its URLs use; null for older handoffs. */
  previewDomain: string | null;
  origin: RemoteOrigin;
  /** The GitHub issue a `swf` session works on. */
  issue: number | null;
};

/**
 * The changes of a remote session on its VM (mirror of `RemoteChanges` in src-tauri/src/remote/diff.rs): the commit
 * they are compared against (the merge base with the handoff head or the default branch) and the changed files, sorted
 * by path. While the VM is off, `base` is null and `files` is empty.
 */
export type RemoteChanges = { vmRunning: boolean; base: string | null; files: ChangedFile[] };

/** A step of a handoff, a retrieval or a connect to a remote session that takes long enough to show. */
export type RemoteStep =
  | "startingVm"
  | "creatingVm"
  | "waitingForVm"
  | "connecting"
  | "installingRuntime"
  | "transferringCode"
  | "installingDependencies"
  | "startingAgent"
  | "stoppingAgent"
  | "retrievingCode";

/**
 * The preview of a remote session (mirror of `PreviewStatus` in src-tauri/src/remote/preview.rs). Hunt builds the URLs
 * from the session ID and its preview domain; the VM reports only ports. While the VM is off, `main` is null, `listening`
 * is empty and `mainResponds` is false.
 */
export type PreviewStatus = {
  vmRunning: boolean;
  /** `https://<short>.<domain>`, which serves the main port. */
  mainUrl: string;
  /** The main port the repository's hunt.json names; null without one. */
  main: number | null;
  /** The ports something listens on, each at `https://<short>-<port>.<domain>`. */
  listening: PreviewPort[];
  /** Whether the main port answers HTTP on the VM. */
  mainResponds: boolean;
};

export type PreviewPort = { port: number; url: string };

/**
 * The step a remote operation on a session is at; `null` once it ended. `detail` is the gateway's last log line about
 * the step, e.g. why the VM does not answer yet; `null` until it sends one.
 */
export type RemoteProgressEvent = { huntSessionId: string; step: RemoteStep | null; detail: string | null };

/** A chunk of a terminal's output: base64 of its bytes, which may end inside a UTF-8 or an escape sequence. */
export type TerminalOutputEvent = { id: string; data: string };

/** The end of a terminal's program; `code` is `null` when a signal ended it. */
export type TerminalExitEvent = { id: string; code: number | null };

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

/**
 * One version of a file in the worktree's edit log: its content (`null` when the file did not exist) and the session
 * whose tool call produced it (`null` for the oldest version and for changes made between tool calls).
 */
export type FileVersion = { sessionId: string | null; content: string | null };

/** One entry of a worktree directory listing. */
export type DirEntry = { name: string; isDir: boolean };

/** Added and removed lines of one uncommitted change; an untracked file counts every line as added. */
export type ChangeStat = { path: string; added: number; removed: number };

/** How much a human should review a file, 4 being the most: its relevance (reuse, architecture, business logic) weighed with how drastic its change is. */
export type ReviewLevel = 1 | 2 | 3 | 4;

/**
 * One file of the component diagram; the worktree-relative `path` identifies the node. `review` is the agent's rating of
 * the file's review relevance and `reviewReason` the one-sentence criterion behind it.
 */
export type GraphNode = { path: string; review?: ReviewLevel; reviewReason?: string };

/**
 * `source` depends on `target` (both node paths). `label` states how `source` uses `target` in one or two verbs and a
 * noun (`calls business logic`, `uses types`), `description` says in a few sentences how and what for. Both come
 * from the agent; an edge read from an import statement has neither.
 */
export type GraphEdge = { source: string; target: string; label?: string; description?: string };

/** The validated content of `.hunt/graph.json` (see src-tauri/src/graph.schema.json). */
export type ArchitectureGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Age of the diagram: when `.hunt/graph.json` was last written, and whether session files changed since. */
export type GraphStatus = { generatedAt: string | null; isOutdated: boolean };

/** `_meta` Hunt attaches to the chunks of a user turn it sent itself; the chat shows `label` instead of the text. `harness` is the key older transcripts used. */
export type HuntChunkMeta = { hunt?: HiddenChunk; harness?: HiddenChunk };
type HiddenChunk = { hidden?: boolean };

export type UpdateEvent = { huntSessionId: string; notification: SessionNotification };
export type PermissionEvent = { huntSessionId: string; requestId: string; request: RequestPermissionRequest };
/** The agent withdrew the permission request `requestId`; a remote session's relay does so when another client answered it. */
export type PermissionWithdrawnEvent = { huntSessionId: string; requestId: string };
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

/**
 * An entry of the chat. The `images` of a message are URLs it shows: asset URLs of screenshots the user attached, or
 * `data:` URLs of image blocks that `imageDataUrl` (chat/imageData.ts) accepted.
 */
export type ChatItem =
  | { kind: "user"; id: string; text: string; images: string[] }
  | { kind: "agent"; id: string; text: string; images: string[] }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; toolCall: ToolCallView };

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

/**
 * A file to show in an editor window, with an optional 1-based caret position. With `definitionOf` (the name
 * ⌘clicked at the position, e.g. in a diff) the window shows that name's declaration instead, or nothing when the
 * language server knows none inside the worktree.
 */
export type EditorOpenRequest = { path: string; line?: number; column?: number; inRightSplit?: boolean; definitionOf?: string };

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

/** The claude.ai plan limits in display order: 5-hour, weekly, weekly per model; empty without plan limits (API key). */
export type PlanUsage = { subscriptionType: string | null; windows: UsageWindow[] };

export type UsageWindow = {
  /** `5h`, `Week` or a model name such as `Fable`. */
  label: string;
  /** Percentage of the window used, 0–100. */
  utilization: number;
  /** ISO 8601 time the window resets. */
  resetsAt: string | null;
};

/** A Claude account Hunt can start Claude Code with: an OAuth token from `claude setup-token`, kept in the keychain. */
export type ClaudeAccount = { id: string; email: string };

/** The token accounts in the order they were added and the one in use; `activeId` null uses the local login. */
export type ClaudeAccounts = { accounts: ClaudeAccount[]; activeId: string | null };

/** Whether the GitHub token of remote sessions is stored; `hint` holds its last four characters. */
export type GithubTokenStatus = { saved: boolean; hint: string | null };
