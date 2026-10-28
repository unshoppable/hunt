import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { scrollTopToReveal, visibleRowRange, type RowRange } from "./virtual-rows.utils";

type Layout = { range: RowRange; rowHeight: number; viewportHeight: number };

/** The scroll container a virtualized list follows, with the row whose size it watches. */
type Attachment = { list: HTMLElement; row: Element | null; observer: ResizeObserver; update: () => void; onScroll: () => void };

export type VirtualRows<RowsElement extends HTMLElement> = {
  /** First rendered row. */
  start: number;
  /** One past the last rendered row. */
  end: number;
  /** Height in px of all rows, which the content of the scroll container takes. */
  totalHeight: number;
  /** Height in px of the scroll container's viewport, which the sticky layer of the rows takes. */
  viewportHeight: number;
  /** Scrolls the list the least distance that shows row `index` fully. */
  scrollToIndex: (index: number) => void;
  /** The scroll container's `ref`; it also sets `listRef`. */
  containerRef: (list: HTMLElement | null) => (() => void) | undefined;
  /** The `ref` of the element that holds the rendered rows as its children; the hook moves it with its `top`. */
  rowsRef: RefObject<RowsElement | null>;
};

/**
 * Renders only the rows of a long list that are in the viewport of its scroll container. The rows must all have the
 * same height, which is measured on the first rendered row and followed when it changes (font settings). Structure:
 *
 *   scroll container (`containerRef`, overflow auto)
 *     content of `totalHeight` px
 *       sticky layer (`position: sticky; top: 0; overflow: hidden`, `viewportHeight` px, opaque background)
 *         rows element (`rowsRef`, `position: relative`) with the rows `start` to `end` as children
 *
 * WebKit scrolls a list on its own thread and shows content it has not painted yet as black, so the rows never scroll
 * with the content: they sit in the sticky layer, which stays in place and is only repainted, and the hook shifts them
 * by the scroll offset in the scroll event. A fast scroll thus shows the previous rows for a frame instead of black.
 */
export function useVirtualRows<RowsElement extends HTMLElement>(listRef: RefObject<HTMLElement | null>, rowCount: number, overscan = 10): VirtualRows<RowsElement> {
  const [layout, setLayout] = useState<Layout>({ range: { start: 0, end: 0 }, rowHeight: 0, viewportHeight: 0 });
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;
  const rowsRef = useRef<RowsElement | null>(null);
  const attachmentRef = useRef<Attachment | null>(null);

  const { rowHeight, viewportHeight } = layout;
  const end = Math.min(layout.range.end, rowCount);
  const start = Math.min(layout.range.start, end);
  /** The rendered range and row height, read by `position` between renders. */
  const renderedRef = useRef({ start, rowHeight });
  renderedRef.current = { start, rowHeight };

  const containerRef = useCallback(
    (list: HTMLElement | null) => {
      listRef.current = list;
      if (!list) return undefined;
      const attachment = attach(list, rowsRef, () => rowCountRef.current, overscan, setLayout, () => position(list, rowsRef.current, renderedRef.current));
      attachmentRef.current = attachment;
      attachment.update();
      return () => {
        detach(attachment);
        attachmentRef.current = null;
        listRef.current = null;
      };
    },
    [listRef, overscan],
  );

  // Recomputes the range after every render (the row count or the first row may have changed); unchanged, it renders nothing.
  useLayoutEffect(() => {
    const attachment = attachmentRef.current;
    if (!attachment) return;
    attachment.update();
    position(attachment.list, rowsRef.current, renderedRef.current);
  });

  return {
    start,
    end,
    totalHeight: rowCount * rowHeight,
    viewportHeight,
    scrollToIndex: (index) => {
      const list = listRef.current;
      if (!list || index < 0 || !rowHeight) return;
      list.scrollTop = scrollTopToReveal(index, rowHeight, list.scrollTop, list.clientHeight);
    },
    containerRef,
    rowsRef,
  };
}

/** Shifts the rendered rows so that row `start` sits where the scroll offset puts it. */
function position(list: HTMLElement, rows: HTMLElement | null, { start, rowHeight }: { start: number; rowHeight: number }) {
  if (!rows) return;
  rows.style.top = `${start * rowHeight - list.scrollTop}px`;
}

function attach(
  list: HTMLElement,
  rowsRef: RefObject<HTMLElement | null>,
  rowCount: () => number,
  overscan: number,
  setLayout: (update: (current: Layout) => Layout) => void,
  reposition: () => void,
): Attachment {
  const observer = new ResizeObserver(() => attachment.update());
  const attachment: Attachment = {
    list,
    row: null,
    observer,
    update: () => {
      const row = rowsRef.current?.firstElementChild ?? null;
      if (row !== attachment.row) {
        if (attachment.row) {
          observer.unobserve(attachment.row);
        }
        if (row) {
          observer.observe(row);
        }
        attachment.row = row;
      }
      const measuredHeight = row?.getBoundingClientRect().height ?? 0;
      const viewportHeight = list.clientHeight;
      setLayout((current) => {
        const rowHeight = measuredHeight || current.rowHeight;
        const range = visibleRowRange(list.scrollTop, viewportHeight, rowHeight, rowCount(), overscan);
        if (rowHeight === current.rowHeight && viewportHeight === current.viewportHeight && range.start === current.range.start && range.end === current.range.end) {
          return current;
        }
        return { range, rowHeight, viewportHeight };
      });
    },
    onScroll: () => {
      flushSync(attachment.update);
      reposition();
    },
  };
  observer.observe(list);
  list.addEventListener("scroll", attachment.onScroll, { passive: true });
  return attachment;
}

function detach(attachment: Attachment | null) {
  if (!attachment) return;
  attachment.observer.disconnect();
  attachment.list.removeEventListener("scroll", attachment.onScroll);
}
