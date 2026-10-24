import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  AttributionEvent,
  CheckOutputEvent,
  ClosedEvent,
  DiffOpenRequest,
  DocumentChangedEvent,
  DocumentDirtyEvent,
  EditorOpenRequest,
  GraphChangedEvent,
  LspDiagnosticsEvent,
  LspExitedEvent,
  MessageTimesEvent,
  PermissionEvent,
  PermissionWithdrawnEvent,
  RelayActivityEvent,
  RemoteLinkEvent,
  RemoteProgressEvent,
  RemoteSyncEvent,
  ReplayEvent,
  ScriptRunRequest,
  SummaryEvent,
  TerminalExitEvent,
  TerminalOutputEvent,
  UpdateEvent,
} from "./types";

type EventPayloads = {
  "acp:update": UpdateEvent;
  "acp:replay": ReplayEvent;
  "acp:permission": PermissionEvent;
  "acp:permission-withdrawn": PermissionWithdrawnEvent;
  "acp:closed": ClosedEvent;
  "acp:message-times": MessageTimesEvent;
  /** A handoff, retrieval or connect of a remote session moved on to another step, or ended. */
  "remote:progress": RemoteProgressEvent;
  /** A sync of a remote session's files with its VM started or ended. */
  "remote:sync": RemoteSyncEvent;
  /** Whether the local worktree of a remote session may change changed (see `RemoteLink`). */
  "remote:link": RemoteLinkEvent;
  /** The relay of a remote session reported another activity through its status channel, or its VM stopped mid-turn. */
  "remote:relay": RelayActivityEvent;
  "graph:changed": GraphChangedEvent;
  "session:summary": SummaryEvent;
  "attribution:changed": AttributionEvent;
  /** The backend added or removed sessions; every window reloads its list. */
  "sessions:changed": undefined;
  /** The backend added, removed or switched the Claude account (see settings/SettingsWindow.tsx). */
  "accounts:changed": undefined;
  /** Sent by the main window to a session's editor window (see ide/editorWindows.ts). */
  "editor:open": EditorOpenRequest;
  /** Sent by an editor window to every window once it takes `editor:open` events. */
  "editor:ready": { label: string };
  /** Sent by a secondary window to the main window to show a session there (see sessions/showSession.ts). */
  "session:show": { sessionId: string };
  /** Sent by the main window to a diff window booted ahead of time (see graph/diffWindows.ts). */
  "diff:open": DiffOpenRequest;
  /** Sent by a diff window to every window once it takes `diff:open` events and knows the sessions. */
  "diff:ready": { label: string };
  /** Sent by the window whose settings store changed (see app/bootstrap.ts); `source` is its label. */
  "settings:changed": { source: string };
  /** Sent by the main window to the open settings window (see settings/openSettingsWindow.ts) to switch its page. */
  "settings:show-page": { page: "updates" };
  "lsp:diagnostics": LspDiagnosticsEvent;
  "lsp:exited": LspExitedEvent;
  "document:changed": DocumentChangedEvent;
  "document:dirty": DocumentDirtyEvent;
  /** Output of a terminal, sent only to the window that opened it (see terminal/TerminalPanel.tsx). */
  "terminal:output": TerminalOutputEvent;
  /** The end of a terminal's program, sent only to the window that opened it. */
  "terminal:exit": TerminalExitEvent;
  /** A check of the session started, ended or was cancelled; sent to the main window (see checks/ChecksPanel.tsx). */
  "checks:changed": { sessionId: string };
  /** Output of a check's run, sent to the main window. */
  "checks:output": CheckOutputEvent;
  /** Sent by any window to the main window to run a package.json script in its Terminal tab (see terminal/scriptRuns.ts). */
  "terminal:run-script": ScriptRunRequest;
};

/**
 * Subscribes to `name` from every window, or with `target` (a window label) only to events sent to that window by
 * `emitTo(label, …)` and to broadcasts by `emit(…)`; without `target` a window also receives events addressed to others.
 */
export function listenTo<Name extends keyof EventPayloads>(
  name: Name,
  handler: (payload: EventPayloads[Name]) => void,
  options: { target?: string } = {},
): Promise<UnlistenFn> {
  return listen<EventPayloads[Name]>(name, (event) => handler(event.payload), options.target ? { target: options.target } : undefined);
}

/**
 * A native file drag over this window. `enter` and `drop` carry the dragged files' absolute paths, `over` only the
 * cursor; `position` is in CSS pixels relative to the viewport, so it compares to `getBoundingClientRect()`.
 */
export type FileDragEvent =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/**
 * Subscribes to native file drags over this window. Tauri takes file drops before the webview sees them, so this is
 * the only way the page learns about dropped files; the HTML `drop` event never carries them.
 */
export function listenToFileDrag(handler: (event: FileDragEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      handler({ type: "leave" });
      return;
    }
    const logical = payload.position.toLogical(window.devicePixelRatio);
    const position = { x: logical.x, y: logical.y };
    if (payload.type === "over") {
      handler({ type: "over", position });
    } else {
      handler({ type: payload.type, paths: payload.paths, position });
    }
  });
}
