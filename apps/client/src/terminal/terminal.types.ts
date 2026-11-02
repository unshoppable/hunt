/** Where a tmux window runs: on the session VM or in the family's tmux server on this Mac (mirror of `Machine` in src-tauri/src/terminal/tmux.rs). */
export type Machine = "vm" | "desktop";

/** What a terminal shows: the log of a hunt.json service on the VM, read-only, or a window of the tmux session `app` on `machine`. */
export type TerminalTarget = { kind: "service"; name: string } | { kind: "window"; id: string; machine: Machine };

/**
 * A window of the tmux session `app` (mirror of `TmuxWindow` in src-tauri/src/terminal/tmux.rs); `id` is tmux's window ID such
 * as `@3`, which never repeats on its server. A window Hunt opened for a package.json script names it in `script`, one
 * for a hunt.json check of the Checks tab in `check`, one for a hunt.json service in `service`; all stay after their program ended, `isDead` with its `exitCode`
 * (null when a signal ended it). `owner` is the Hunt session
 * the window belongs to: the one whose Terminal tab opened it or last ran its script, or whose agent created it; every
 * window on a VM belongs to the session that runs there; null when nobody recorded one.
 */
export type TmuxWindow = {
  id: string;
  name: string;
  script: string | null;
  check: string | null;
  /** The hunt.json service a service window of a local session runs. */
  service: string | null;
  isDead: boolean;
  exitCode: number | null;
  owner: string | null;
};

/** The state of a hunt.json service of a local session (mirror of `ServiceState` in src-tauri/src/services/services.rs). */
export type LocalServiceState = "stopped" | "running" | "ended";

/**
 * A hunt.json service of a local session (mirror of `ServiceView` in src-tauri/src/services/services.rs): its window of the
 * family's tmux server, if one runs or ran it, the worktree-relative log of that window and whether its port accepts
 * connections on this Mac.
 */
export type LocalService = {
  name: string;
  command: string;
  port: number | null;
  state: LocalServiceState;
  exitCode: number | null;
  windowId: string | null;
  log: string | null;
  isListening: boolean;
};

/** The services of a local session's hunt.json; none and `problem` when its `services` section is malformed. */
export type LocalServicesStatus = { services: LocalService[]; problem: string | null };

/** Runs the package.json script `script` of the worktree folder `directory` (`""`: the worktree) in the Terminal tab of the session `sessionId`. */
export type ScriptRunRequest = { sessionId: string; directory: string; script: string };

/** A chunk of a terminal's output: base64 of its bytes, which may end inside a UTF-8 or an escape sequence. */
export type TerminalOutputEvent = { id: string; data: string };

/** The end of a terminal's program; `code` is `null` when a signal ended it. */
export type TerminalExitEvent = { id: string; code: number | null };
