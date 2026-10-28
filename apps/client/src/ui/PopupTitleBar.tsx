import type { ReactNode } from "react";
import { useSettingsStore, type DetachablePopupKey } from "../settings/settings.store";
import { HEADER_BAR } from "./bars.constants";
import { ICON_BUTTON_XS } from "./buttons.constants";
import { AttachIcon, DetachIcon } from "./Icons";

/**
 * Switches every popup of `popupKey` between a window of its own and its place inside the app window (see
 * detached-popup.hook.ts); the popup on screen moves over at once.
 */
export function PopupModeButton({ popupKey, isDetached }: { popupKey: DetachablePopupKey; isDetached: boolean }) {
  const setPopupDetached = useSettingsStore((state) => state.setPopupDetached);
  const title = isDetached ? "Show inside the app window" : "Open in a window of its own";
  return (
    <button type="button" title={title} aria-label={title} onClick={() => setPopupDetached(popupKey, !isDetached)} className={`${ICON_BUTTON_XS} shrink-0`}>
      {isDetached ? <AttachIcon className="size-4" /> : <DetachIcon className="size-4" />}
    </button>
  );
}

/**
 * The 42 px top row of a popup window: its drag region beside the traffic lights, holding the popup's title and ending
 * with the button that puts the popup back into the app window.
 */
export function PopupWindowTitleBar({ popupKey, children }: { popupKey: DetachablePopupKey; children: ReactNode }) {
  return (
    <div data-tauri-drag-region="deep" className={`${HEADER_BAR} gap-2 border-b border-(--line) pr-2 pl-23 text-[13px] whitespace-nowrap select-none`}>
      {children}
      <PopupModeButton popupKey={popupKey} isDetached />
    </div>
  );
}
