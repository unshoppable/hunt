import type { CSSProperties } from "react";
import type { PopupKey, PopupSize } from "../state/settings";
import type { ResizeHandlers } from "./ResizeGrips";
import { usePopupSize } from "./usePopupSize";
import { useViewportSize } from "./useViewportSize";

/** Smallest size a dialog shrinks to unless it names its own. */
const DEFAULT_MIN_SIZE: PopupSize = { width: 320, height: 160 };
/** Largest share of the window a dialog may take. */
const MAX_WIDTH_SHARE = 0.94;
const MAX_HEIGHT_SHARE = 0.84;

export type DialogSize = {
  /** The `style` of the dialog's `Modal`. */
  style: CSSProperties;
  /** The `resize` of the dialog's `Modal`. */
  resize: ResizeHandlers;
};

/**
 * Size of a centered dialog the user may resize by dragging its edges (see Modal's `resize` and usePopupSize):
 * remembered under `key`, at least `min`, at most a share of the window. A dialog that `fillsHeight` is always as
 * tall as its size; otherwise it is as tall as its content until the user drags its height, up to its size.
 */
export function useDialogSize(key: PopupKey, { min = DEFAULT_MIN_SIZE, fillsHeight = false }: { min?: PopupSize; fillsHeight?: boolean } = {}): DialogSize {
  const viewport = useViewportSize();
  const { size, isHeightSet, grips } = usePopupSize(key, { min, max: { width: viewport.width * MAX_WIDTH_SHARE, height: viewport.height * MAX_HEIGHT_SHARE } });
  const isTall = fillsHeight || isHeightSet;
  return { style: { width: size.width, height: isTall ? size.height : undefined, maxHeight: size.height }, resize: grips };
}
