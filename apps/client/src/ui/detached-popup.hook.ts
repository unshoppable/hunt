import { useCallback, useEffect, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenTo } from "../ipc/events";
import type { PopupAnchor } from "./popup-placement.utils";
import { popupWindowLabel, type PopupActions, type PopupContents, type PopupKind } from "./popup-protocol.utils";
import { ensurePopupWindow, isPopupWindowBooting, popupWindowBounds } from "./detached-popup.utils";

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

/** The showing of each popup kind this window started last, until it ends. */
const newestShowings = new Map<PopupKind, Showing>();

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
        // The caller may have dropped its content meanwhile; the window then stays hidden.
        if (showing.current !== current) return;
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
    newestShowings.set(kind, current);
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
        if (event.label !== label || isPopupWindowBooting(label)) return;
        current.sentRevision = UNSENT;
        send();
      }),
    ];
    return () => {
      showing.current = null;
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
      // A showing started in the same render (a host that remounts its popup for new content) takes the window over
      // with its own `popup:show`; a `popup:hide` ahead of it would make the window vanish and reappear. So the hide
      // follows that `popup:show` and only takes effect when the successor ended before it sent one.
      queueMicrotask(() => {
        const newest = newestShowings.get(kind);
        if (newest === current) {
          newestShowings.delete(kind);
        }
        const successorSending = newest && newest !== current ? newest.sending : Promise.resolve();
        void successorSending.then(() => emitTo(label, "popup:hide", { token: current.token })).catch(() => {});
      });
    };
  }, [isShown, kind, send]);

  // A new revision with unchanged content (another ⌘P while the window is open) only brings the window to the front.
  const revision = options.revision;
  useEffect(() => {
    if (content) {
      send();
    }
  }, [content, revision, send]);
}
