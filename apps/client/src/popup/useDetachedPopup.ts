import { useCallback, useEffect, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { listenTo } from "../ipc/events";
import type { ScreenRect } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { createPopupWindow } from "../ui/nativeWindow";
import { fitIntoWorkArea, popupBounds, type PopupAnchor } from "./placement";
import { POPUP_WINDOW_BACKGROUND, POPUP_WINDOWS, popupWindowLabel, type PopupActions, type PopupContents, type PopupKind } from "./protocol";

type DetachedPopupOptions<Kind extends PopupKind> = {
  /** Changes whenever the popup shows something new (another ⌘clicked symbol, say); the window then takes the focus. */
  revision: unknown;
  /** Where the window opens when it is hidden, read each time the content is sent. */
  anchor: () => PopupAnchor;
  onAction: (action: PopupActions[Kind]) => void;
  /** The user closed the window, or another window took it over for its own popup. */
  onClose: () => void;
};

/** One showing of the popup by this hook, from the moment it gets content until it has none. */
type Showing = { token: string; sentRevision: unknown; sending: Promise<void> };

/** Marks a showing whose window has not been sent a revision yet, so the first `popup:show` takes the focus. */
const UNSENT = Symbol("unsent");

let showingCount = 0;

/** Popup windows this window is creating, until their page reports `popup:ready`. */
const booting = new Map<string, Promise<void>>();

/**
 * Shows `content` in the popup window of `kind`, owned by this window, as long as `content` is set: the window opens
 * at `anchor` (kept inside the screen) with the popup's remembered size, follows every change of `content` and goes
 * when `content` becomes null or the caller unmounts. What the user does there arrives in `onAction`; closing the
 * window (Escape, ⌘W, the traffic light) arrives in `onClose`, after which the caller drops `content`.
 */
export function useDetachedPopup<Kind extends PopupKind>(kind: Kind, content: PopupContents[Kind] | null, options: DetachedPopupOptions<Kind>): void {
  const latest = useRef({ content, options });
  latest.current = { content, options };
  const showing = useRef<Showing | null>(null);
  const isShown = !!content;

  const send = useCallback(() => {
    const current = showing.current;
    if (!current) return;
    current.sending = current.sending
      .then(async () => {
        const { content: shown, options: shownOptions } = latest.current;
        if (!shown || showing.current !== current) return;
        const placement = await popupWindowBounds(kind, shownOptions.anchor());
        await ensurePopupWindow(kind, placement);
        const focus = current.sentRevision !== shownOptions.revision;
        current.sentRevision = shownOptions.revision;
        const request = { kind, hostLabel: getCurrentWindow().label, token: current.token, content: shown, placement, focus };
        await emitTo(popupWindowLabel(kind), "popup:show", request);
      })
      .catch((reason) => console.error(`failed to show the ${kind} popup window: ${reason}`));
  }, [kind]);

  useEffect(() => {
    if (!isShown) return;
    const hostLabel = getCurrentWindow().label;
    const label = popupWindowLabel(kind);
    showingCount += 1;
    const current: Showing = { token: `${hostLabel}/${showingCount}`, sentRevision: UNSENT, sending: Promise.resolve() };
    showing.current = current;
    const subscriptions = [
      listenTo(
        "popup:action",
        ({ token, action }) => {
          if (token === current.token && showing.current === current) {
            latest.current.options.onAction(action as PopupActions[Kind]);
          }
        },
        { target: hostLabel },
      ),
      listenTo(
        "popup:closed",
        ({ token }) => {
          if (token === current.token && showing.current === current) {
            latest.current.options.onClose();
          }
        },
        { target: hostLabel },
      ),
      // A popup window that another window created, or that reloaded, asks for its content again.
      listenTo("popup:ready", (event) => {
        if (event.label !== label || booting.has(label)) return;
        current.sentRevision = UNSENT;
        send();
      }),
    ];
    return () => {
      showing.current = null;
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
      emitTo(label, "popup:hide", { token: current.token }).catch(() => {});
    };
  }, [isShown, kind, send]);

  useEffect(() => {
    if (content) {
      send();
    }
  }, [content, send]);
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
async function popupWindowBounds(kind: PopupKind, anchor: PopupAnchor): Promise<ScreenRect> {
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
 * Resolves once the popup window of `kind` exists and takes `popup:show`: a missing one is created hidden at `bounds`
 * and resolves when its page reports `popup:ready`; it rejects when the window could not be created or went before.
 */
async function ensurePopupWindow(kind: PopupKind, bounds: ScreenRect): Promise<void> {
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
