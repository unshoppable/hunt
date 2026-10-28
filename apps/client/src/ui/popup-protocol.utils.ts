import type { ImageContent } from "../chat/ChatImages";
import type { ScreenshotsContent } from "../chat/ScreenshotPicker";
import type { SubChatContent } from "../chat/sub-chat/SubChatPopover";
import type { FileSearchContent } from "../ide/search/FileSearchDialog";
import type { FindInFilesContent } from "../ide/search/FindInFilesDialog";
import type { RenamePreviewContent } from "../ide/language/RenameDialog";
import type { UsagesContent } from "../ide/language/UsagesPopover";
import type { Usage } from "../ide/language/usages.utils";
import type { Screenshot } from "../chat/chat.types";
import type { GuardrailDeclineReason } from "../chat/guardrail/guardrail-suggestion.types";
import type { DetachablePopupKey } from "../settings/settings.store";

/**
 * What the window of each detachable popup shows: plain data its host window sends along with `popup:show` (see
 * detached-popup.hook.ts), since the popup window has stores of its own.
 */
export type PopupContents = {
  usages: UsagesContent;
  fileSearch: FileSearchContent;
  findInFiles: FindInFilesContent;
  subChat: SubChatContent;
  renamePreview: RenamePreviewContent;
  image: ImageContent;
  screenshots: ScreenshotsContent;
};

/** Opens a file in the host window, at the 1-based position if given; `inRightSplit` asks for the file right of the current pane. */
type OpenFileAction = { type: "open"; path: string; line?: number; column?: number; inRightSplit: boolean };

/** What the window of each detachable popup asks its host window to do, sent as `popup:action`. */
export type PopupActions = {
  usages: { type: "open"; usage: Usage };
  fileSearch: OpenFileAction;
  findInFiles: OpenFileAction & { line: number; column: number };
  subChat: { type: "created"; subSessionId: string } | { type: "decline"; reason: GuardrailDeclineReason };
  renamePreview: { type: "apply"; keys: string[] } | { type: "back" };
  image: never;
  screenshots: { type: "attach"; screenshots: Screenshot[] };
};

export type PopupKind = keyof PopupContents & DetachablePopupKey;

/** A `popup:show` request narrowed to its kind. */
export type PopupRequest<Kind extends PopupKind = PopupKind> = {
  [Each in Kind]: { kind: Each; hostLabel: string; token: string; content: PopupContents[Each]; focus: boolean };
}[Kind];

/** The native window of each popup kind: its title and smallest size; it takes the rest from the popup's remembered size. */
export const POPUP_WINDOWS: Record<PopupKind, { title: string; minWidth: number; minHeight: number }> = {
  usages: { title: "Usages", minWidth: 520, minHeight: 280 },
  fileSearch: { title: "Go to File or Symbol", minWidth: 520, minHeight: 240 },
  findInFiles: { title: "Find in Files", minWidth: 560, minHeight: 280 },
  subChat: { title: "Sub Chat", minWidth: 420, minHeight: 240 },
  renamePreview: { title: "Rename Preview", minWidth: 560, minHeight: 320 },
  image: { title: "Image", minWidth: 320, minHeight: 200 },
  screenshots: { title: "Screenshots", minWidth: 480, minHeight: 320 },
};

/** Background of every popup window until its page paints, the color of `--surface-inspector`. */
export const POPUP_WINDOW_BACKGROUND = "#272c35";

/** Label of the popup window of `kind`; one window per kind serves every host window. */
export function popupWindowLabel(kind: PopupKind): string {
  return `popup-${kind}`;
}

/** The popup kind a popup window was opened for, from its URL query (`?kind=…`); throws for an unknown kind. */
export function parsePopupWindowUrl(search: string): PopupKind {
  const kind = new URLSearchParams(search).get("kind");
  if (!kind || !(kind in POPUP_WINDOWS)) throw new Error(`The popup window needs a known kind in its URL, not ${kind}.`);
  return kind as PopupKind;
}
