import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listenTo } from "../ipc/events";
import type { EditorOpenRequest } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { createWindow, type WindowDefaults } from "../ui/nativeWindow";

const EDITOR_WINDOW_DEFAULTS: WindowDefaults = { width: 1400, height: 900, minWidth: 900, minHeight: 600, backgroundColor: "#272c35" };

/** Label of the editor window of a session; one window per session. */
export function editorWindowLabel(sessionId: string): string {
  return `editor-${sessionId}`;
}

/** Idle time after a session becomes active before its editor window boots; flicking through sessions boots nothing. */
const WARM_DELAY_MS = 400;

type BootingWindow = {
  window: Promise<WebviewWindow>;
  /** Requests that arrived while the page was loading; delivered on `editor:ready`. */
  queued: EditorOpenRequest[];
};

/** Windows created by this window whose page has not reported `editor:ready` yet. */
const booting = new Map<string, BootingWindow>();
/** Windows booted ahead of time (hidden) that no request reached yet; they go when their session is left. */
const warm = new Set<string>();
let isListeningForReady = false;
let warmTimer: number | undefined;

/**
 * Opens `request` in the session's editor window (see EditorWindow.tsx): an existing window gets the request as
 * the `editor:open` event and shows itself, a window still booting gets it once it is ready, otherwise a new one
 * starts with the request in its URL.
 */
export async function openInEditorWindow(sessionId: string, request: EditorOpenRequest): Promise<void> {
  const label = editorWindowLabel(sessionId);
  warm.delete(label);
  const pending = booting.get(label);
  if (pending) {
    pending.queued.push(request);
    return;
  }
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await emitTo(label, "editor:open", request);
    return;
  }
  await createEditorWindow(sessionId, request);
}

/**
 * Boots the active session's editor window hidden so the first ⌘click only has to show it, and destroys the windows
 * warmed for other sessions that nothing opened. Call whenever the active session changes.
 */
export function keepEditorWindowWarm(sessionId: string | null): void {
  globalThis.clearTimeout(warmTimer);
  if (!sessionId) return;
  warmTimer = globalThis.setTimeout(() => {
    void dropWarmWindowsExcept(editorWindowLabel(sessionId));
    const hasSession = useHuntStore.getState().sessions.some((session) => session.id === sessionId);
    if (hasSession) {
      void warmEditorWindow(sessionId);
    }
  }, WARM_DELAY_MS);
}

async function warmEditorWindow(sessionId: string): Promise<void> {
  const label = editorWindowLabel(sessionId);
  if (booting.has(label) || (await WebviewWindow.getByLabel(label))) return;
  warm.add(label);
  await createEditorWindow(sessionId, null);
}

async function dropWarmWindowsExcept(keptLabel: string): Promise<void> {
  for (const label of [...warm]) {
    if (label === keptLabel) continue;
    warm.delete(label);
    const pending = booting.get(label);
    booting.delete(label);
    const window = await (pending?.window ?? WebviewWindow.getByLabel(label)).catch(() => null);
    // A window that another window's request has filled and shown meanwhile is in use (it may hold unsaved edits) and stays.
    if (!window || (await window.isVisible().catch(() => true))) continue;
    await window.destroy().catch(() => {});
  }
}

function listenForReady(): void {
  if (isListeningForReady) return;
  isListeningForReady = true;
  void listenTo("editor:ready", ({ label }) => {
    const pending = booting.get(label);
    booting.delete(label);
    for (const request of pending?.queued ?? []) {
      void emitTo(label, "editor:open", request);
    }
  });
}

/**
 * Creates the session's editor window, hidden until its page has rendered and has something to show (see
 * EditorWindow.tsx), with the main window's chrome and remembered bounds (see ui/nativeWindow.ts). Resolves once the
 * native window exists.
 */
async function createEditorWindow(sessionId: string, request: EditorOpenRequest | null): Promise<void> {
  listenForReady();
  const label = editorWindowLabel(sessionId);
  const title = useHuntStore.getState().sessions.find((session) => session.id === sessionId)?.title ?? "Editor";
  const created = createWindow("editor", label, { url: `editor.html?${editorWindowQuery(sessionId, request)}`, title: `${title} – Editor`, ...EDITOR_WINDOW_DEFAULTS });
  booting.set(label, { window: created, queued: [] });
  // A window that dies before it is ready (its session was removed) or never came up must not swallow later requests.
  const forget = () => {
    booting.delete(label);
    warm.delete(label);
  };
  void created.then((window) => void window.once("tauri://destroyed", forget), forget);
  await created;
}

function editorWindowQuery(sessionId: string, request: EditorOpenRequest | null): string {
  const params = new URLSearchParams({ session: sessionId });
  if (!request) return params.toString();
  params.set("path", request.path);
  if (request.line) {
    params.set("line", String(request.line));
  }
  if (request.column) {
    params.set("column", String(request.column));
  }
  if (request.inRightSplit) {
    params.set("split", "right");
  }
  return params.toString();
}

/**
 * The session and the file an editor window was opened for, from its URL query
 * (`?session=…&path=…&line=…&column=…&split=right`); a warmed window has no file and waits for `editor:open`.
 */
export function parseEditorWindowUrl(search: string): { sessionId: string; request: EditorOpenRequest | null } {
  const params = new URLSearchParams(search);
  const sessionId = params.get("session");
  if (!sessionId) throw new Error("The editor window needs a session id in its URL.");
  const path = params.get("path");
  if (!path) return { sessionId, request: null };
  return {
    sessionId,
    request: {
      path,
      line: Number(params.get("line")) || undefined,
      column: Number(params.get("column")) || undefined,
      inRightSplit: params.get("split") === "right" || undefined,
    },
  };
}
