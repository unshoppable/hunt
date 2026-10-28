import { useCallback, useEffect, useRef, type RefObject } from "react";
import { shouldFollow } from "./follow-scroll.utils";

/** Keys that scroll the view up while an element inside it has the focus. */
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Keeps `scrollRef` pinned to its newest content: every growth of `contentRef` (loaded history, streamed text,
 * async highlighting, images) and every shrink of the viewport (growing prompt box, window resize) scrolls to the
 * end, until the user scrolls up to read; scrolling back to the end follows again. Only the user's input (wheel, keys,
 * a drag of the scrollbar or a selection) stops following, since layout moves the offset up as well: a prompt box
 * collapses for a moment to measure its text, which clamps the offset. A change of `resetKey` (e.g. the shown session)
 * jumps to the end and follows again. The returned function does the same on demand, e.g. when the user sends a prompt.
 */
export function useFollowScroll(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, resetKey: unknown): () => void {
  const followEndRef = useRef(() => {});
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    let isFollowing = true;
    let previousTop = 0;
    let isDragging = false;
    const scrollToEnd = () => {
      element.scrollTop = element.scrollHeight;
      previousTop = element.scrollTop;
    };
    const onScroll = () => {
      isFollowing = shouldFollow(isFollowing, previousTop, isDragging, element);
      previousTop = element.scrollTop;
    };
    // Wheel and keys stop following before the scroll they cause, whose event may arrive only after the content grew.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && element.scrollTop > 0) {
        isFollowing = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_UP_KEYS.has(event.key) && element.scrollTop > 0) {
        isFollowing = false;
      }
    };
    const onPointerDown = () => {
      isDragging = true;
    };
    const onPointerUp = () => {
      isDragging = false;
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
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      followEndRef.current = () => {};
    };
  }, [scrollRef, contentRef, resetKey]);
  return useCallback(() => followEndRef.current(), []);
}
