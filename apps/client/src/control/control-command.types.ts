/**
 * A `hunt-client` command for the session `sessionId`, which the main window runs and answers under `requestId` (mirror
 * of `ControlCommandEvent` in src-tauri/src/session/commands/control.rs). `command` is the JSON the agent passed,
 * unchecked; `parseControlCommand` (control-command.utils.ts) reads it.
 */
export type ControlCommandEvent = { requestId: string; sessionId: string; command: unknown };
