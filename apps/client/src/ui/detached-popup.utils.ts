import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { listenTo } from "../ipc/events";
import type { ScreenRect } from "./popup.types";
import { useSettingsStore } from "../settings/settings.store";
import { createPopupWindow } from "./native-window.utils";
import { fitIntoWorkArea, popupBounds, type PopupAnchor } from "./popup-placement.utils";
import { POPUP_WINDOW_BACKGROUND, POPUP_WINDOWS, popupWindowLabel, type PopupKind } from "./popup-protocol.utils";

/** Popup windows this window is creating, until their page reports `popup:ready`. */
const booting = new Map<string, Promise<void>>();

/** Delay after the main window mounted before the popup windows boot, after the editor, guardrails and settings windows. */
const WARM_DELAY_MS = 2000;

/** The order the popup windows boot in: the kinds a shortcut opens first, since a shortcut is expected to answer at once. */
const WARM_ORDER: readonly PopupKind[] = ["findInFiles", "fileSearch", "usages", "subChat", "renamePreview", "image", "screenshots"];

/** Whether this window is creating the popup window `label` and waits for its `popup:ready`. */
export function isPopupWindowBooting(label: string): boolean {
  return booting.has(label);
}

/**
 * Brings this host window to the front, then runs `open`, which opens what was picked in a popup window; a window that
 * `open` shows in turn (the editor window) thus ends up in front of the host.
 */
export function openInHostWindow(open: () => void): void {
  void getCurrentWindow()
    .setFocus()
    .catch((reason) => console.error(`failed to focus the host window: ${reason}`))
    .then(open);
}

/** The bounds of the popup window of `kind` at `anchor`: the popup's remembered size, kept inside a display's work area. */
export async function popupWindowBounds(kind: PopupKind, anchor: PopupAnchor): Promise<ScreenRect> {
  const host = getCurrentWindow();
  const [scaleFactor, position, size, monitors] = await Promise.all([host.scaleFactor(), host.innerPosition(), host.innerSize(), availableMonitors()]);
  const pagePosition = position.toLogical(scaleFactor);
  const pageSize = size.toLogical(scaleFactor);
  const page = { x: pagePosition.x, y: pagePosition.y, width: pageSize.width, height: pageSize.height };
  const areas = monitors.map((monitor) => {
    const areaPosition = monitor.workArea.position.toLogical(monitor.scaleFactor);
    const areaSize = monitor.workArea.size.toLogical(monitor.scaleFactor);
    return { x: areaPosition.x, y: areaPosition.y, width: areaSize.width, height: areaSize.height };
  });
  return fitIntoWorkArea(popupBounds(anchor, page, useSettingsStore.getState().popupSizes[kind]), areas);
}

/**
 * Boots the popup window of every kind the user keeps in a window of its own hidden, one after another, so the first
 * ⇧⌘F or ⌘P after a start only has to show it instead of waiting for its page to load (seconds under the dev server).
 * Call once when the main window mounts; a kind put into a window later boots when it is first shown.
 */
export function keepPopupWindowsWarm(): void {
  globalThis.setTimeout(() => {
    void (async () => {
      const detached = useSettingsStore.getState().detachedPopups;
      for (const kind of WARM_ORDER) {
        if (!detached[kind]) continue;
        try {
          await ensurePopupWindow(kind, await popupWindowBounds(kind, "top"));
        } catch (reason) {
          console.error(`failed to warm the ${kind} popup window: ${reason}`);
        }
      }
    })();
  }, WARM_DELAY_MS);
}

/**
 * Resolves once the popup window of `kind` exists and takes `popup:show`: a missing one is created hidden at `bounds`
 * and resolves when its page reports `popup:ready`; it rejects when the window could not be created or went before.
 */
export async function ensurePopupWindow(kind: PopupKind, bounds: ScreenRect): Promise<void> {
  const label = popupWindowLabel(kind);
  const pending = booting.get(label);
  if (pending) return pending;
  if (await WebviewWindow.getByLabel(label)) return;
  let readySubscription: Promise<() => void> | undefined;
  const booted = new Promise<void>((resolve, reject) => {
    readySubscription = listenTo("popup:ready", (event) => {
      if (event.label === label) {
        resolve();
      }
    });
    const { title, minWidth, minHeight } = POPUP_WINDOWS[kind];
    createPopupWindow(label, { url: `popup.html?kind=${kind}`, title, ...bounds, minWidth, minHeight, backgroundColor: POPUP_WINDOW_BACKGROUND })
      .then((created) => created.once("tauri://destroyed", () => reject(new Error(`the ${kind} popup window went before it was ready`))))
      .catch(reject);
  }).finally(() => {
    booting.delete(label);
    void readySubscription?.then((unlisten) => unlisten());
  });
  booting.set(label, booted);
  return booted;
}
