import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { scrollTopToReveal, visibleRowRange, type RowRange } from "./virtualRows";

type Layout = { range: RowRange; rowHeight: number };

/** The scroll container a virtualized list follows, with the row whose size it watches. */
type Attachment = { list: HTMLElement; row: Element | null; observer: ResizeObserver; update: () => void };

export type VirtualRows = {
  /** First rendered row. */
  start: number;
  /** One past the last rendered row. */
  end: number;
  /** Heights in px of the spacers that stand in for the rows above `start` and below `end`. */
  spaceBefore: number;
  spaceAfter: number;
  /** Scrolls the list the least distance that shows row `index` fully. */
  scrollToIndex: (index: number) => void;
  /** The scroll container's `ref`; it also sets `listRef`. */
  containerRef: (list: HTMLElement | null) => (() => void) | undefined;
};

/**
 * Renders only the rows of a long list that are near the viewport of its scroll container, which takes `containerRef`
 * as `ref` (`listRef` then points at it too). The rows must all have the same height, which is measured on the first
 * rendered row and followed when it changes (font settings). The container renders a `<li data-virtual-spacer>` (or
 * any element with that attribute) of `spaceBefore` px, the rows `start` to `end`, and a spacer of `spaceAfter` px,
 * all as direct children.
 */
export function useVirtualRows(listRef: RefObject<HTMLElement | null>, rowCount: number, overscan = 40): VirtualRows {
  const [layout, setLayout] = useState<Layout>({ range: { start: 0, end: 0 }, rowHeight: 0 });
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;
  const attachmentRef = useRef<Attachment | null>(null);

  const containerRef = useCallback(
    (list: HTMLElement | null) => {
      listRef.current = list;
      if (!list) return undefined;
      const attachment = attach(list, () => rowCountRef.current, overscan, setLayout);
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
  useLayoutEffect(() => attachmentRef.current?.update());

  const { rowHeight } = layout;
  const end = Math.min(layout.range.end, rowCount);
  const start = Math.min(layout.range.start, end);
  return {
    start,
    end,
    spaceBefore: start * rowHeight,
    spaceAfter: (rowCount - end) * rowHeight,
    scrollToIndex: (index) => {
      const list = listRef.current;
      if (!list || index < 0 || !rowHeight) return;
      list.scrollTop = scrollTopToReveal(index, rowHeight, list.scrollTop, list.clientHeight);
    },
    containerRef,
  };
}

function attach(list: HTMLElement, rowCount: () => number, overscan: number, setLayout: (update: (current: Layout) => Layout) => void): Attachment {
  const observer = new ResizeObserver(() => attachment.update());
  const attachment: Attachment = {
    list,
    row: null,
    observer,
    update: () => {
      const row = list.querySelector(":scope > :not([data-virtual-spacer])");
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
      setLayout((current) => {
        const rowHeight = measuredHeight || current.rowHeight;
        const range = visibleRowRange(list.scrollTop, list.clientHeight, rowHeight, rowCount(), overscan);
        if (rowHeight === current.rowHeight && range.start === current.range.start && range.end === current.range.end) return current;
        return { range, rowHeight };
      });
    },
  };
  observer.observe(list);
  list.addEventListener("scroll", attachment.update, { passive: true });
  return attachment;
}

function detach(attachment: Attachment | null) {
  if (!attachment) return;
  attachment.observer.disconnect();
  attachment.list.removeEventListener("scroll", attachment.update);
}
