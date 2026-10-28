import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listenTo } from "../ipc/events";
import type { DiffOpenRequest } from "./diff.types";
import { labelHash, openOrFocusWindow, type WindowDefaults } from "../ui/native-window.utils";

const DIFF_WINDOW_DEFAULTS: WindowDefaults = { width: 1400, height: 900, minWidth: 800, minHeight: 500, backgroundColor: "#272c35" };

/** Labels of windows booted ahead of time start with this; `keepDiffWindowWarm` drops the ones an earlier page load left behind. */
const SPARE_LABEL_PREFIX = "diff-spare-";

/**
 * Idle time after the main window mounts before the first spare boots, so it does not compete with the main window's
 * own start; longer than the editor window's 400 ms, which only debounces session switches (see ide/editor-window.utils.ts).
 */
const WARM_DELAY_MS = 1500;

/** Label of the window showing a file (`sessionId:path`); a window that was closed since simply fails the lookup. */
const shown = new Map<string, string>();
/** Windows whose page has not reported `diff:ready` yet, with the request to deliver once it does. */
const booting = new Map<string, { request: DiffOpenRequest | null }>();
/** The hidden window (booted or booting) that waits for the next file; null while none exists. */
let spareLabel: string | null = null;
let isListeningForReady = false;
let spareCounter = 0;

/** Label of a diff window opened for a file while no spare was available; the file is in the window's URL. */
export function diffWindowLabel(sessionId: string, path: string): string {
  return `diff-${sessionId}-${labelHash(path)}`;
}

/**
 * Opens the diff of `path` in a window of its own (see DiffWindow.tsx), opened from a diagram node, or brings the
 * open one to the front. The hidden window booted ahead of time (see `keepDiffWindowWarm`) takes the file as the
 * `diff:open` event and shows itself at once; without one a new window starts with the file in its URL. Either way
 * the next spare boots right away.
 */
export async function openDiffWindow(sessionId: string, path: string): Promise<void> {
  const key = `${sessionId}:${path}`;
  const existing = await WebviewWindow.getByLabel(shown.get(key) ?? diffWindowLabel(sessionId, path));
  if (existing) {
    await existing.setFocus();
    return;
  }
  const label = spareLabel;
  spareLabel = null;
  bootSpare();
  if (!label) {
    const own = diffWindowLabel(sessionId, path);
    shown.set(key, own);
    await openOrFocusWindow("diff", own, { url: `diff.html?${new URLSearchParams({ session: sessionId, path })}`, title: "Diff", ...DIFF_WINDOW_DEFAULTS });
    return;
  }
  shown.set(key, label);
  const request = { sessionId, path };
  const pending = booting.get(label);
  if (pending) {
    pending.request = request;
    return;
  }
  await emitTo(label, "diff:open", request);
}

/**
 * Boots a hidden diff window ahead of time, so a click on a changed file in the diagram only has to fill and show
 * it, after destroying the hidden spares an earlier load of this page left behind. Call once when the main window
 * mounts.
 */
export function keepDiffWindowWarm(): void {
  globalThis.setTimeout(() => void dropOrphanedSpares().then(bootSpare), WARM_DELAY_MS);
}

async function dropOrphanedSpares(): Promise<void> {
  for (const window of await WebviewWindow.getAll()) {
    if (!window.label.startsWith(SPARE_LABEL_PREFIX) || window.label === spareLabel) continue;
    const isVisible = await window.isVisible().catch(() => true);
    if (!isVisible) {
      await window.destroy().catch(() => {});
    }
  }
}

function bootSpare(): void {
  if (spareLabel) return;
  listenForReady();
  const label = `${SPARE_LABEL_PREFIX}${Date.now().toString(36)}-${++spareCounter}`;
  spareLabel = label;
  booting.set(label, { request: null });
  openOrFocusWindow("diff", label, { url: "diff.html", title: "Diff", ...DIFF_WINDOW_DEFAULTS })
    .then((window) => void window.once("tauri://destroyed", () => forget(label)))
    .catch(() => forget(label));
}

function forget(label: string): void {
  booting.delete(label);
  if (spareLabel === label) {
    spareLabel = null;
  }
}

function listenForReady(): void {
  if (isListeningForReady) return;
  isListeningForReady = true;
  void listenTo("diff:ready", ({ label }) => {
    const pending = booting.get(label);
    booting.delete(label);
    if (pending?.request) {
      void emitTo(label, "diff:open", pending.request);
    }
  });
}

/** The file a diff window was opened for, from its URL query (`?session=…&path=…`); a window booted ahead of time has none. */
export function parseDiffWindowUrl(search: string): DiffOpenRequest | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get("session");
  const path = params.get("path");
  if (!sessionId || !path) return null;
  return { sessionId, path };
}
