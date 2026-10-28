import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ResizeHandlers } from "./ResizeGrips";
import { rowsHeight } from "./auto-grow.utils";

/**
 * Sizes a textarea to its content up to `maxRows` lines, wrapped lines included, and lets it scroll beyond that.
 * `rows` on the element stays the minimum. `text` is the current value, so the height follows every change.
 * `minHeight` in px raises the minimum, and the maximum with it, e.g. to the height the user dragged the textarea to.
 */
export function useAutoGrow(textarea: RefObject<HTMLTextAreaElement | null>, text: string, maxRows: number, minHeight = 0): void {
  useLayoutEffect(() => {
    const element = textarea.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const maxHeight = Math.max(minHeight, rowsHeight(element, maxRows));
    // The parent keeps its height while the textarea collapses to measure its text: otherwise a scroll area beside it
    // grows for that moment, and WebKit clamps its offset up from the end, which stays after the textarea grew back.
    const parentMinHeight = parent.style.minHeight;
    parent.style.minHeight = `${parent.offsetHeight}px`;
    element.style.height = "auto";
    const height = Math.max(minHeight, Math.min(element.scrollHeight, maxHeight));
    element.style.height = `${height}px`;
    parent.style.minHeight = parentMinHeight;
    element.style.overflowY = element.scrollHeight > height ? "auto" : "hidden";
  }, [textarea, text, maxRows, minHeight]);
}

/**
 * Height of a textarea whose box the user resizes by dragging its top edge (`grips` for a `ResizeGrips` with
 * `edges={{ top: true }}`): `minHeight` is the dragged height while a drag runs, else `stored`, and goes to
 * `useAutoGrow`. On release `onStore` gets the height, or null once it was dragged down to the textarea's own `rows`,
 * so that the textarea follows its text again. `maxHeight` is read when a drag starts.
 */
export function useTextareaDrag(
  textarea: RefObject<HTMLTextAreaElement | null>,
  stored: number | null,
  onStore: (height: number | null) => void,
  maxHeight: () => number,
): { minHeight: number; grips: ResizeHandlers } {
  /** Height while the top edge is dragged; null outside a drag. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  /** Height the textarea had when the drag started, the one it has now and the largest it may take. */
  const drag = useRef({ start: 0, height: 0, max: 0 });

  const grips: ResizeHandlers = {
    onStart: () => {
      const height = textarea.current?.offsetHeight ?? 0;
      drag.current = { start: height, height, max: Math.max(height, maxHeight()) };
    },
    onDrag: ({ dy }) => {
      const height = Math.max(0, Math.min(drag.current.start + dy, drag.current.max));
      drag.current.height = height;
      setDragHeight(height);
    },
    onEnd: () => {
      const element = textarea.current;
      const { height } = drag.current;
      onStore(element && height > rowsHeight(element, element.rows) ? height : null);
      setDragHeight(null);
    },
  };

  return { minHeight: dragHeight ?? stored ?? 0, grips };
}
