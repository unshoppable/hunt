import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { assetUrl, commands } from "../ipc/commands";
import type { Screenshot } from "./chat.types";
import { PopupModeButton, PopupWindowTitleBar } from "../ui/PopupTitleBar";
import type { PopupActions } from "../ui/popup-protocol.utils";
import { useDetachedPopup } from "../ui/detached-popup.hook";
import { useSettingsStore } from "../settings/settings.store";
import { useHoverAnchor } from "../ui/hover-anchor.hook";
import { CLEAR_BUTTON, GHOST_BUTTON_XS, PRIMARY_BUTTON_XS } from "../ui/buttons.constants";
import { ImageIcon } from "../ui/Icons";
import { Modal } from "../ui/Modal";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { usePopupSize } from "../ui/popup-size.hook";
import { useViewportSize } from "../ui/viewport-size.hook";
import { formatRelativeTime } from "../common/time/relative-time.utils";

const POPOVER_WIDTH = 340;
const POPOVER_ITEMS = 8;
const GAP = 8;
const MARGIN = 12;
const DIALOG_MIN_SIZE = { width: 480, height: 320 };
/** The largest share of the window's width and height the dialog may take. */
const DIALOG_MAX_SHARE = 0.92;

/** URL the webview can load a screenshot file from (Tauri's asset protocol). */
export function screenshotUrl(screenshot: Screenshot): string {
  return assetUrl(screenshot.path);
}

/** The screenshot folder's images, loaded afresh each time `isActive` turns true, so new screenshots show up. */
function useScreenshots(isActive: boolean): { screenshots: Screenshot[] | null; error: string | null } {
  const [screenshots, setScreenshots] = useState<Screenshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLoad(() => commands.listScreenshots(), { onValue: setScreenshots, onError: (reason) => setError(errorText(reason)) }, [], { isEnabled: isActive });

  return { screenshots, error };
}

/**
 * Round picture button beside the prompt's send button, like Arc's download tray: hovering shows the newest screenshots
 * of the macOS screenshot folder, one click on an entry attaches it; a click on the icon opens a dialog to pick several.
 */
export function ScreenshotTrigger({ onPick, className = "" }: { onPick: (screenshots: Screenshot[]) => void; className?: string }) {
  const hover = useHoverAnchor<"screenshots">();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const isDialogDetached = useSettingsStore((state) => state.detachedPopups.screenshots);
  const isPopoverOpen = Boolean(hover.anchor) && !isDialogOpen;
  // A screenshot window loads the screenshots itself.
  const { screenshots, error } = useScreenshots(isPopoverOpen || (isDialogOpen && !isDialogDetached));
  const attach = (picked: Screenshot[]) => {
    onPick(picked);
    setIsDialogOpen(false);
  };

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Attach screenshots"
        title="Screenshots"
        onMouseEnter={(event) => hover.enter("screenshots", event.currentTarget)}
        onMouseLeave={hover.leave}
        onClick={() => setIsDialogOpen(true)}
        className={`${CLEAR_BUTTON} ${className}`}
      >
        <ImageIcon className="size-[18px]" />
      </button>
      {isPopoverOpen && hover.anchor ? (
        <ScreenshotPopover
          anchor={hover.anchor.rect}
          screenshots={screenshots}
          error={error}
          onPick={(screenshot) => {
            onPick([screenshot]);
            hover.leave();
          }}
          onEnter={hover.keep}
          onLeave={hover.leave}
        />
      ) : null}
      {isDialogOpen && isDialogDetached ? <DetachedScreenshotDialog onAttach={attach} onClose={() => setIsDialogOpen(false)} /> : null}
      {isDialogOpen && !isDialogDetached ? <ScreenshotDialog screenshots={screenshots} error={error} onAttach={attach} onClose={() => setIsDialogOpen(false)} /> : null}
    </>
  );
}

/** Floating list of the newest screenshots above `anchor`, right-aligned with it; the mouse may move into it, a click attaches the entry. */
function ScreenshotPopover({
  anchor,
  screenshots,
  error,
  onPick,
  onEnter,
  onLeave,
}: {
  anchor: DOMRect;
  screenshots: Screenshot[] | null;
  error: string | null;
  onPick: (screenshot: Screenshot) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - 2 * MARGIN);
  const style: React.CSSProperties = {
    width,
    right: Math.max(MARGIN, Math.min(window.innerWidth - anchor.right, window.innerWidth - width - MARGIN)),
    bottom: Math.max(MARGIN, window.innerHeight - anchor.top + GAP),
  };
  const recent = screenshots?.slice(0, POPOVER_ITEMS) ?? [];

  return createPortal(
    <div
      role="menu"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 rounded-lg border border-neutral-600 bg-(--surface-chat) p-1 text-[13px] text-neutral-200 shadow-xl shadow-black/50"
    >
      {error ? <p className="px-2 py-1.5 text-red-400">{error}</p> : null}
      {!error && !screenshots ? <p className="px-2 py-1.5 text-neutral-500">Loading…</p> : null}
      {screenshots && !screenshots.length ? <p className="px-2 py-1.5 text-neutral-500">No screenshots yet.</p> : null}
      {recent.map((screenshot) => (
        <button
          key={screenshot.path}
          type="button"
          role="menuitem"
          onClick={() => onPick(screenshot)}
          className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left hover:bg-(--row-hover)"
        >
          <Thumbnail screenshot={screenshot} className="size-11 rounded border border-white/10" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-neutral-100">{screenshot.name}</span>
            <span className="block text-[12px] text-neutral-500">{formatRelativeTime(screenshot.modifiedAt)}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

type ScreenshotChooserProps = {
  screenshots: Screenshot[] | null;
  error: string | null;
  onAttach: (screenshots: Screenshot[]) => void;
  onClose: () => void;
};

/** The screenshot picker inside the app window: a dialog over the dimmed window; Esc or the backdrop closes it. */
function ScreenshotDialog(props: ScreenshotChooserProps) {
  const viewport = useViewportSize();
  const { size, isHeightSet, grips } = usePopupSize("screenshots", { min: DIALOG_MIN_SIZE, max: { width: viewport.width * DIALOG_MAX_SHARE, height: viewport.height * DIALOG_MAX_SHARE } });
  return (
    <Modal
      label="Attach screenshots"
      onClose={props.onClose}
      className="bg-(--surface-inspector)"
      style={{ width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
      resize={grips}
    >
      <ScreenshotChooser {...props} isDetached={false} />
    </Modal>
  );
}

/** What the screenshot window shows (see ui/popup-protocol.utils.ts): nothing but itself, it loads the screenshots on its own. */
export type ScreenshotsContent = Record<string, never>;

const SCREENSHOTS_CONTENT: ScreenshotsContent = {};

/** The screenshot window's host side: the screenshots picked there are attached here. */
function DetachedScreenshotDialog({ onAttach, onClose }: Pick<ScreenshotChooserProps, "onAttach" | "onClose">) {
  useDetachedPopup("screenshots", SCREENSHOTS_CONTENT, {
    revision: SCREENSHOTS_CONTENT,
    anchor: () => "center",
    onAction: (action: PopupActions["screenshots"]) => {
      onAttach(action.screenshots);
      void getCurrentWindow().setFocus();
    },
    onClose,
  });
  return null;
}

/** The screenshot window's page side (see popup/PopupWindow.tsx). */
export function ScreenshotsWindowContent({ onAction, onClose }: { onAction: (action: PopupActions["screenshots"]) => void; onClose: () => void }) {
  const { screenshots, error } = useScreenshots(true);
  return (
    <div className="flex h-screen flex-col bg-(--surface-inspector)">
      <ScreenshotChooser screenshots={screenshots} error={error} isDetached onAttach={(picked) => onAction({ type: "attach", screenshots: picked })} onClose={onClose} />
    </div>
  );
}

/** Grid of every screenshot with multi-select; Enter attaches the selection. */
function ScreenshotChooser({ screenshots, error, isDetached, onAttach, onClose }: ScreenshotChooserProps & { isDetached: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const picked = (screenshots ?? []).filter((screenshot) => selected.has(screenshot.path));

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function attach() {
    if (!picked.length) return;
    onAttach(picked);
  }
  const attachRef = useRef(attach);
  attachRef.current = attach;

  // Enter attaches from anywhere but a button (Cancel, Attach and the tiles keep their own Enter); the key is taken in
  // the capture phase and stopped there, so the prompt's own Enter (send) never sees it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      event.stopPropagation();
      attachRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const title = (
    <>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">Screenshots</span>
      <span className="text-[13px] text-neutral-500">{screenshots ? `${screenshots.length} images` : "Loading…"}</span>
    </>
  );
  return (
    <>
      {isDetached ? (
        <PopupWindowTitleBar popupKey="screenshots">{title}</PopupWindowTitleBar>
      ) : (
        <div className="flex h-11 items-center gap-2 border-b border-(--line) pr-2 pl-4">
          {title}
          <PopupModeButton popupKey="screenshots" isDetached={false} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        {screenshots && !screenshots.length ? <p className="text-sm text-neutral-500">No screenshots yet.</p> : null}
        <div className="grid grid-cols-4 gap-3">
          {(screenshots ?? []).map((screenshot) => {
            const isSelected = selected.has(screenshot.path);
            return (
              <button
                key={screenshot.path}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(screenshot.path)}
                className={`group flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors ${
                  isSelected ? "border-blue-500 bg-blue-500/10" : "border-transparent hover:bg-(--row-hover)"
                }`}
              >
                <span className="relative block">
                  <Thumbnail screenshot={screenshot} className="aspect-[4/3] w-full rounded-md border border-white/10" />
                  <span
                    aria-hidden="true"
                    className={`absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-full border text-white ${
                      isSelected ? "border-blue-400 bg-blue-600" : "border-white/60 bg-black/40 opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    {isSelected ? (
                      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3.5 8.5 3 3 6-7" />
                      </svg>
                    ) : null}
                  </span>
                </span>
                <span className="block truncate text-[13px] text-neutral-200">{screenshot.name}</span>
                <span className="-mt-1 block text-[12px] text-neutral-500">{formatRelativeTime(screenshot.modifiedAt)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-(--line) px-3 py-2.5">
        <button type="button" onClick={onClose} className={GHOST_BUTTON_XS}>
          Cancel
        </button>
        <button type="button" onClick={attach} disabled={!picked.length} className={PRIMARY_BUTTON_XS}>
          {picked.length > 1 ? `Attach ${picked.length} screenshots` : "Attach screenshot"}
        </button>
      </div>
    </>
  );
}

function Thumbnail({ screenshot, className }: { screenshot: Screenshot; className: string }) {
  return <img src={screenshotUrl(screenshot)} alt="" loading="lazy" decoding="async" className={`shrink-0 bg-black/30 object-cover ${className}`} />;
}
