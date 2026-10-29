import type { Machine } from "../terminal/terminal.types";

/** A check the worktree's hunt.json declares (mirror of `CheckDefinition` in src-tauri/src/checks/checks.rs). */
export type CheckDefinition = { name: string; command: string; cwd: string | null };

export type CheckState = "running" | "passed" | "failed" | "cancelled";

/**
 * The last run of a check (mirror of `CheckRunView` in src-tauri/src/checks/checks.rs): `exitCode` is `null` while it runs,
 * after a signal or when it could not start; `window` is the tmux window it runs in, `null` until that opened and when it
 * could not start; `error` says why it could not start or could not be followed to its end.
 */
export type CheckRun = {
  name: string;
  run: number;
  state: CheckState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  window: { id: string; machine: Machine } | null;
  error: string | null;
};

/**
 * The checks of a session (mirror of `ChecksStatus` in src-tauri/src/session/commands/checks.rs): those of the worktree's
 * hunt.json, or none and `problem` when its `checks` section is malformed; the last run of each, and in `outdated` the
 * names of those whose run started on another state of the worktree.
 */
export type ChecksStatus = { definitions: CheckDefinition[]; problem: string | null; runs: CheckRun[]; outdated: string[] };
