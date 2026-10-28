import { useCallback, useEffect, useRef, useState } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ImageWindowContent } from "../chat/ChatImages";
import { ScreenshotsWindowContent } from "../chat/ScreenshotPicker";
import { SubChatWindowContent } from "../chat/sub-chat/SubChatPopover";
import { FileSearchWindowContent } from "../ide/search/FileSearchDialog";
import { FindInFilesWindowContent } from "../ide/search/FindInFilesDialog";
import { RenamePreviewWindowContent } from "../ide/language/RenameDialog";
import { UsagesWindowContent } from "../ide/language/UsagesPopover";
import { listenTo } from "../ipc/events";
import type { PopupShowRequest, ScreenRect } from "../ui/popup.types";
import { useSettingsStore } from "../settings/settings.store";
import { useHuntStore } from "../sessions/hunt.store";
import { useWindowCloseKeys } from "../ui/secondary-window.hook";
import type { PopupActions, PopupKind, PopupRequest } from "../ui/popup-protocol.utils";

/** Delay between the last resize of the window and remembering its size. */
const REMEMBER_DELAY_MS = 300;

/**
 * The window of a detachable popup (see detached-popup.hook.ts): one per popup kind, shared by every host window. It
 * boots hidden, shows the content a host sends with `popup:show` and opens at the host's placement when it was hidden.
 * Escape, ⌘W and the traffic light only hide it, so the next popup opens at once; a click elsewhere leaves it open.
 * It also hides when its host window hides or goes, and when the popup kind is put back into the app window. It reports
 * `popup:ready` once it listens and knows the sessions, which a sub chat needs to tell a live sub session from a stopped one.
 */
export function PopupWindow({ kind }: { kind: PopupKind }) {
  const [shown, setShown] = useState<PopupShowRequest | null>(null);
  /** The request on screen, ahead of the render, for event handlers. */
  const shownRef = useRef<PopupShowRequest | null>(null);
  const isDetached = useSettingsStore((state) => state.detachedPopups[kind]);
  const setPopupSize = useSettingsStore((state) => state.setPopupSize);
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isListening, setIsListening] = useState(false);

  /** Hides the window and drops its content; with `notifyHost` the host learns that its popup is gone. */
  const hide = useCallback(async (notifyHost: boolean) => {
    const current = shownRef.current;
    shownRef.current = null;
    setShown(null);
    await getCurrentWindow().hide();
    if (current && notifyHost) {
      await emitTo(current.hostLabel, "popup:closed", { token: current.token });
    }
  }, []);

  useWindowCloseKeys(() => hide(true));

  useEffect(() => {
    void refreshSessions()
      .catch((reason) => console.error(`failed to load the sessions: ${reason}`))
      .finally(() => setIsLoaded(true));
  }, [refreshSessions]);

  useEffect(() => {
    const label = getCurrentWindow().label;
    const subscriptions = [
      listenTo(
        "popup:show",
        (request) => {
          const previous = shownRef.current;
          if (previous && previous.token !== request.token) {
            void emitTo(previous.hostLabel, "popup:closed", { token: previous.token });
          }
          shownRef.current = request;
          setShown(request);
        },
        { target: label },
      ),
      listenTo(
        "popup:hide",
        ({ token }) => {
          if (shownRef.current?.token === token) {
            void hide(false);
          }
        },
        { target: label },
      ),
      listenTo("window:hidden", (event) => {
        if (shownRef.current?.hostLabel === event.label) {
          void hide(true);
        }
      }),
    ];
    void Promise.all(subscriptions).then(() => setIsListening(true));
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [hide]);

  useEffect(() => {
    if (!isLoaded || !isListening) return;
    void emit("popup:ready", { label: getCurrentWindow().label });
  }, [isLoaded, isListening]);

  // The host renders the popup in its own window from now on.
  useEffect(() => {
    if (!isDetached && shownRef.current) {
      void hide(false);
    }
  }, [isDetached, hide]);

  // A rendered request shows the window: a hidden one at the host's placement, a shown one only takes the focus.
  useEffect(() => {
    if (shown) {
      void reveal(shown.placement, shown.focus);
    }
  }, [shown]);

  const hostLabel = shown?.hostLabel;
  useEffect(() => {
    if (!hostLabel) return;
    const host = WebviewWindow.getByLabel(hostLabel);
    const subscription = host.then((window) =>
      window?.once("tauri://destroyed", () => {
        if (shownRef.current?.hostLabel === hostLabel) {
          void hide(false);
        }
      }),
    );
    return () => void subscription.then((unlisten) => unlisten?.());
  }, [hostLabel, hide]);

  // The size the user gives the window is the popup's size, also inside the app window.
  useEffect(() => {
    const window = getCurrentWindow();
    let timer: number | undefined;
    const remember = async () => {
      if (!shownRef.current || !(await window.isVisible())) return;
      const size = (await window.innerSize()).toLogical(await window.scaleFactor());
      // Showing the window at its remembered size resizes it too, which leaves the settings alone.
      const remembered = useSettingsStore.getState().popupSizes[kind];
      if (Math.round(size.width) === remembered.width && Math.round(size.height) === remembered.height) return;
      setPopupSize(kind, { width: size.width, height: size.height });
    };
    const subscription = window.onResized(() => {
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => void remember(), REMEMBER_DELAY_MS);
    });
    return () => {
      globalThis.clearTimeout(timer);
      void subscription.then((unlisten) => unlisten());
    };
  }, [kind, setPopupSize]);

  if (!shown) return null;
  const request = shown as PopupRequest;
  const sendAction = (action: PopupActions[PopupKind]) => void emitTo(request.hostLabel, "popup:action", { token: request.token, action });
  const close = () => void hide(true);
  switch (request.kind) {
    case "usages":
      return <UsagesWindowContent key={request.token} content={request.content} onAction={sendAction} />;
    case "fileSearch":
      return <FileSearchWindowContent key={request.token} content={request.content} onAction={sendAction} onClose={close} />;
    case "findInFiles":
      return <FindInFilesWindowContent key={request.token} content={request.content} onAction={sendAction} onClose={close} />;
    case "subChat":
      return <SubChatWindowContent key={request.token} content={request.content} onAction={sendAction} onClose={close} />;
    case "renamePreview":
      return <RenamePreviewWindowContent key={request.token} content={request.content} onAction={sendAction} onClose={close} />;
    case "image":
      return <ImageWindowContent key={request.token} content={request.content} />;
    case "screenshots":
      return <ScreenshotsWindowContent key={request.token} onAction={sendAction} onClose={close} />;
  }
}

/** Shows the window, at `placement` when it was hidden, and focuses it when it was hidden or `focus` asks for it. */
async function reveal(placement: ScreenRect, focus: boolean): Promise<void> {
  const window = getCurrentWindow();
  if (!(await window.isVisible())) {
    await window.setSize(new LogicalSize(placement.width, placement.height));
    await window.setPosition(new LogicalPosition(placement.x, placement.y));
    await window.show();
  } else if (!focus) {
    return;
  }
  await window.setFocus();
}
