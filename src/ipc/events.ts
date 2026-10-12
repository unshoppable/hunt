import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AttributionEvent, ClosedEvent, DiffOpenRequest, EditorOpenRequest, GraphChangedEvent, LspDiagnosticsEvent, LspExitedEvent, PermissionEvent, SummaryEvent, UpdateEvent } from "./types";

type EventPayloads = {
  "acp:update": UpdateEvent;
  "acp:permission": PermissionEvent;
  "acp:closed": ClosedEvent;
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
