import { useEffect, useRef } from "react";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storedWindowPlacement, useRememberWindowBounds, type WindowKind } from "./windowBounds";

/** Default size of a window kind, used until a window of that kind was remembered (see windowBounds.ts). */
export type WindowDefaults = { width: number; height: number; minWidth: number; minHeight: number; backgroundColor: string };

type NativeWindowOptions = NonNullable<ConstructorParameters<typeof WebviewWindow>[1]>;

/**
 * The chrome every native window of Hunt shares: resizable, hidden until its page shows it, and an overlay title bar
 * whose traffic lights sit in the page's header row (see tauri.conf.json for the main window).
 */
function windowChrome(): NativeWindowOptions {
  return { resizable: true, visible: false, titleBarStyle: "overlay", hiddenTitle: true, trafficLightPosition: new LogicalPosition(12, 23) };
}

/** Options a window of `kind` is created with: Hunt's chrome and the remembered bounds of `kind` (the first window is centered). */
export async function rememberedWindowOptions(kind: WindowKind, defaults: WindowDefaults): Promise<NativeWindowOptions> {
  const placement = await storedWindowPlacement(kind);
  return {
    ...windowChrome(),
    width: placement?.width ?? defaults.width,
    height: placement?.height ?? defaults.height,
    minWidth: defaults.minWidth,
    minHeight: defaults.minHeight,
    ...(placement?.x !== undefined && placement?.y !== undefined ? { x: placement.x, y: placement.y } : { center: true }),
    maximized: placement?.maximized ?? false,
    backgroundColor: defaults.backgroundColor,
  };
}

/** Windows this window is creating, so a second request while one boots focuses it instead of failing on the taken label. */
const opening = new Map<string, Promise<WebviewWindow>>();

/** Options of a secondary window: its page and title besides the defaults of its kind. */
export type WindowOptions = { url: string; title: string } & WindowDefaults;

/**
 * Brings the window `label` to the front or creates it from `url` with the chrome and remembered bounds of `kind`.
 * Resolves with the window once the native window exists; the page shows it once rendered.
 */
export async function openOrFocusWindow(kind: WindowKind, label: string, options: WindowOptions): Promise<WebviewWindow> {
  const existing = await (opening.get(label) ?? WebviewWindow.getByLabel(label));
  if (existing) {
    await existing.setFocus();
    return existing;
  }
  return createWindow(kind, label, options);
}

/**
 * Creates the window `label` (which must be free) from `url` with the chrome and remembered bounds of `kind`.
 * Resolves with the window once the native window exists and rejects when it could not be created; the page shows it
 * once rendered.
 */
export async function createWindow(kind: WindowKind, label: string, options: WindowOptions): Promise<WebviewWindow> {
  return spawnWindow(label, { url: options.url, title: options.title, ...(await rememberedWindowOptions(kind, options)) });
}

/** Where a popup window opens and how big, in logical screen px, besides its page, title and smallest size. */
export type PopupWindowOptions = {
  url: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  backgroundColor: string;
};

/**
 * Creates the popup window `label` (which must be free) with Hunt's chrome at the given bounds (see
 * popup/useDetachedPopup.ts). Resolves once the native window exists; the page shows it once it has something to show.
 */
export function createPopupWindow(label: string, options: PopupWindowOptions): Promise<WebviewWindow> {
  return spawnWindow(label, { ...windowChrome(), ...options });
}

async function spawnWindow(label: string, options: NativeWindowOptions): Promise<WebviewWindow> {
  const window = new WebviewWindow(label, options);
  const created = new Promise<WebviewWindow>((resolve, reject) => {
    void window.once("tauri://created", () => resolve(window));
    void window.once("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
  opening.set(label, created);
  void window.once("tauri://destroyed", () => opening.delete(label));
  try {
    return await created;
  } catch (reason) {
    opening.delete(label);
    throw reason;
  }
}

/**
 * The behaviour every secondary window shares: its bounds are remembered as `kind`, it shows itself once mounted
 * and `isReady` (at once by default), and the traffic light, Escape and ⌘W call `close` (see `useWindowCloseKeys`).
 */
export function useSecondaryWindow(kind: WindowKind, close: () => void | Promise<void>, options: { isReady?: boolean } = {}): void {
  const isReady = options.isReady ?? true;

  useRememberWindowBounds(kind);
  useWindowCloseKeys(close);

  useEffect(() => {
    if (!isReady) return;
    void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
  }, [isReady]);
}

/**
 * The traffic light, Escape and ⌘W call `close`, which decides whether the window really goes, e.g. after asking
 * about unsaved edits. Both keys listen in the bubble phase; whatever takes Escape itself (a popover, a Monaco widget,
 * a selection) stops its propagation and keeps the window open.
 */
export function useWindowCloseKeys(close: () => void | Promise<void>): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A focused Monaco editor calls preventDefault on every Escape, so for Escape only a stopped propagation counts as taken.
      const isCloseKey = event.key === "Escape" || (event.key.toLowerCase() === "w" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.defaultPrevented);
      if (!isCloseKey) return;
      event.preventDefault();
      void closeRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const subscription = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void closeRef.current();
    });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}

/**
 * Hides the current window and tells the other windows first, so that the popup windows it opened go with it (see
 * popup/PopupWindow.tsx); the main window's traffic light sends the same event from the backend.
 */
export async function hideCurrentWindow(): Promise<void> {
  const window = getCurrentWindow();
  await emit("window:hidden", { label: window.label });
  await window.hide();
}

/** Session id and further query values of a secondary window's URL (`?session=…`); throws without a session. */
export function parseWindowUrl(search: string): { sessionId: string; params: URLSearchParams } {
  const params = new URLSearchParams(search);
  const sessionId = params.get("session");
  if (!sessionId) throw new Error("The window needs a session id in its URL.");
  return { sessionId, params };
}

/** A short hash of `text` fit for a window label, which allows only letters, digits, `-`, `/`, `:` and `_`. */
export function labelHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
