import { useLayoutEffect, type RefObject } from "react";

/**
 * Sizes a textarea to its content up to `maxRows` lines, wrapped lines included, and lets it scroll beyond that.
 * `rows` on the element stays the minimum. `text` is the current value, so the height follows every change.
 */
export function useAutoGrow(textarea: RefObject<HTMLTextAreaElement | null>, text: string, maxRows: number): void {
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const maxHeight = maxRows * lineHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    element.style.height = "auto";
    const isOverflowing = element.scrollHeight > maxHeight;
    element.style.height = `${isOverflowing ? maxHeight : element.scrollHeight}px`;
    element.style.overflowY = isOverflowing ? "auto" : "hidden";
  }, [textarea, text, maxRows]);
}
