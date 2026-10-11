/** Size of the "Ask Claude" button and its distance to the selection, in CSS pixels; mirrored in `.hunt-ask-button` (index.css). */
export const ASK_BUTTON_PX = 22;
export const ASK_BUTTON_GAP_PX = 6;

/**
 * Where the button sits relative to the selection's active end: right of the end of a forward selection, left of
 * the start of a backward one, or above the start when the start is too close to the left edge of the code.
 */
export type AskButtonPlacement = "after" | "before" | "above";

/**
 * Picks the placement for a selection made forwards (`isForward`) whose active end is `offsetPx` pixels right of the
 * left edge of the code; a negative offset means the line is not rendered.
 */
export function askButtonPlacement(isForward: boolean, offsetPx: number): AskButtonPlacement {
  if (isForward) return "after";
  return offsetPx >= ASK_BUTTON_PX + ASK_BUTTON_GAP_PX ? "before" : "above";
}
