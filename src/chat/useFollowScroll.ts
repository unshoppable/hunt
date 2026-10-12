import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Distance from the end, in pixels, within which the view counts as scrolled to the bottom (covers subpixel rounding). */
const BOTTOM_THRESHOLD = 8;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * Whether the view keeps following the end after a scroll from `previousTop` to `metrics`: landing at the bottom
 * (re)starts following, moving up while not at the bottom stops it, anything else keeps the current state.
 * Shrinking content clamps the offset upwards but lands at the bottom, so it never counts as the user scrolling up.
 */
export function shouldFollow(wasFollowing: boolean, previousTop: number, metrics: ScrollMetrics): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  if (distance <= BOTTOM_THRESHOLD) return true;
  if (metrics.scrollTop < previousTop) return false;
  return wasFollowing;
}

/**
 * Keeps `scrollRef` pinned to its newest content: every growth of `contentRef` (loaded history, streamed text,
 * async highlighting, images) and every shrink of the viewport (growing prompt box, window resize) scrolls to the
 * end, until the user scrolls up to read; scrolling back to the end follows again. A change of `resetKey`
 * (e.g. the shown session) jumps to the end and follows again. The returned function does the same on demand,
 * e.g. when the user sends a prompt.
 */
export function useFollowScroll(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, resetKey: unknown): () => void {
  const followEndRef = useRef(() => {});
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    let isFollowing = true;
    let previousTop = 0;
    const scrollToEnd = () => {
      element.scrollTop = element.scrollHeight;
      previousTop = element.scrollTop;
    };
    const onScroll = () => {
      isFollowing = shouldFollow(isFollowing, previousTop, element);
      previousTop = element.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      if (isFollowing) {
        scrollToEnd();
      }
    });
    followEndRef.current = () => {
      isFollowing = true;
      scrollToEnd();
    };
    scrollToEnd();
    observer.observe(content);
    observer.observe(element);
    element.addEventListener("scroll", onScroll);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
      followEndRef.current = () => {};
    };
  }, [scrollRef, contentRef, resetKey]);
  return useCallback(() => followEndRef.current(), []);
}
