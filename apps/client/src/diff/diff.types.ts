import type { ChangedFile } from "../common/changes/changed-file.types";

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

/**
 * What the changelist and its diffs compare the worktree against (mirrors `Comparison` in `session/commands/changes.rs`):
 * `diffBase` is the session's diff base (`HEAD`, or the merge base of a pull request under review), `pushTarget` the
 * commit `HEAD` shares with the branch its push lands on, so the list holds what a push would publish plus the
 * uncommitted changes.
 */
export type Comparison = "diffBase" | "pushTarget";

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

/** Added and removed lines of one uncommitted change; an untracked file counts every line as added. */
export type ChangeStat = { path: string; added: number; removed: number };

/** A changed file of a session to show in a diff window (see diff/diff-window.utils.ts). */
export type DiffOpenRequest = { sessionId: string; path: string };
