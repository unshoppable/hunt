import type { StoredBrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import type { SelectionContext } from "../editor/selection-context.types";
import type { ReviewComment } from "../review/review.types";
import type { RemoteTarget, VmRef } from "./remote/remote-session.types";

export type SessionView = {
  id: string;
  title: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  /** The ref the session was created from; where its push lands is `pushTarget`. */
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
  /** Set while the session is handed off to a VM: its agent runs there, and Hunt syncs its files with the local worktree. */
  remote: RemoteTarget | null;
  /**
   * The session VM a failed handoff left behind (also set while a handoff runs); the next handoff reuses it and
   * deleting the session deletes it.
   */
  leftoverVm: VmRef | null;
  /** Progress of preparing the worktree's `node_modules`; `null` when nothing was or is being prepared. */
  dependencies: DependencyStatus | null;
  /** Whether the session's worktree exists here; a remote session adopted from its VM gets one with its first sync. */
  hasLocalWorktree: boolean;
  /**
   * The branch on `origin` a push of the session lands on: the one its branch tracks, else a branch of its own name, as a
   * plain `git push` in the worktree does; a poller session's own branch. `null` without a local worktree.
   */
  pushTarget: string | null;
};

/** What the preparation of a worktree's `node_modules` (clone from the repository, else install) is doing or ended with. */
export type DependencyStatus = { phase: "running" | "ready" | "failed"; message: string };

/**
 * Where a session works: `worktree` is a worktree created and deleted with the session, on a new
 * `feat/general/<slug>-<id>` branch off the base branch or, for a pull request review, on the pull request's branch;
 * `checkout` is the repository's own checkout on whatever branch it has, which Hunt leaves alone.
 */
export type Workspace = "worktree" | "checkout";

/**
 * How a session ends (mirror of `Ending` in src-tauri/src/session/commands/sessions.rs): `stop` only stops its agent, `delete`
 * removes it with its sub chats, worktree, branch and, for a remote session, its VM; `forget` removes everything this
 * Mac keeps of it but leaves a remote session's VM for the others working on it and for a later adoption.
 */
export type SessionEnding = "stop" | "delete" | "forget";

/**
 * An annotation a person made with the review widget on a preview page of a remote session's VM, delivered once through
 * its status channel, or in the Chrome of a local session (mirror of `AnnotationEvent` in
 * src-tauri/src/session/relay_watch.rs).
 */
export type AnnotationEvent = { huntSessionId: string; annotation: StoredBrowserAnnotation };

/** The pull request a session reviews: enough to show it and to open it on GitHub. */
export type PullRequestRef = {
  number: number;
  url: string;
};

/** Sent after a tool call changed files in `worktreePath`; every session of that worktree reloads its changes. */
export type AttributionEvent = { worktreePath: string };
/** Files in `worktreePath` changed outside Hunt (an editor, a terminal, another agent) or its `HEAD` moved; every session of that worktree reloads its changes. */
export type WorktreeChangedEvent = { worktreePath: string };
/** Result of the background summarizer after a finished turn; `title` is the (possibly unchanged) session title. */
export type SummaryEvent = { huntSessionId: string; title: string; summary: string[] };
