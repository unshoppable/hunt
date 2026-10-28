/** Distance from the end, in pixels, within which the view counts as scrolled to the bottom (covers subpixel rounding). */
const BOTTOM_THRESHOLD = 8;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * Whether the view keeps following the end after a scroll from `previousTop` to `metrics`: landing at the bottom
 * (re)starts following, moving up while the user drags (scrollbar, selection) and not at the bottom stops it,
 * anything else keeps the current state. Layout moves the offset up without a drag: a viewport that grows for a
 * moment, or shrinking content, clamps it, and the scroll event may arrive only after newer content grew.
 */
export function shouldFollow(wasFollowing: boolean, previousTop: number, isDragging: boolean, metrics: ScrollMetrics): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  if (distance <= BOTTOM_THRESHOLD) return true;
  if (isDragging && metrics.scrollTop < previousTop) return false;
  return wasFollowing;
}
