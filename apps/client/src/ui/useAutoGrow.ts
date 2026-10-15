import { useLayoutEffect, type RefObject } from "react";

/** Outer height in px a textarea takes for `rows` lines of its current font, padding included. */
export function rowsHeight(element: HTMLTextAreaElement, rows: number): number {
  const style = getComputedStyle(element);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  return rows * lineHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
}

/**
 * Sizes a textarea to its content up to `maxRows` lines, wrapped lines included, and lets it scroll beyond that.
 * `rows` on the element stays the minimum. `text` is the current value, so the height follows every change.
 * `minHeight` in px raises the minimum, and the maximum with it, e.g. to the height the user dragged the textarea to.
 */
export function useAutoGrow(textarea: RefObject<HTMLTextAreaElement | null>, text: string, maxRows: number, minHeight = 0): void {
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const maxHeight = Math.max(minHeight, rowsHeight(element, maxRows));
    element.style.height = "auto";
    const height = Math.max(minHeight, Math.min(element.scrollHeight, maxHeight));
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > height ? "auto" : "hidden";
  }, [textarea, text, maxRows, minHeight]);
}
