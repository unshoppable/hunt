/** The rows `[start, end)` a virtualized list renders; the rows above and below it are replaced by empty space. */
export type RowRange = { start: number; end: number };

/**
 * The rows of a list of `rowCount` rows of `rowHeight` px each that touch the viewport (`scrollTop`, `viewportHeight`),
 * widened by `overscan` rows on each side, so a fast scroll shows rendered rows before the next render arrives. While
 * the row height is unknown (0) only the first row renders, so that it can be measured.
 */
export function visibleRowRange(scrollTop: number, viewportHeight: number, rowHeight: number, rowCount: number, overscan: number): RowRange {
  if (rowCount <= 0) return { start: 0, end: 0 };
  if (rowHeight <= 0) return { start: 0, end: 1 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / rowHeight);
  return { start: Math.max(0, Math.min(first, rowCount) - overscan), end: Math.min(rowCount, last + overscan) };
}

/**
 * The `scrollTop` that shows row `index` with the least movement, like `scrollIntoView({ block: "nearest" })`:
 * unchanged when the row is fully visible, otherwise its top or bottom aligned with the viewport's edge.
 */
export function scrollTopToReveal(index: number, rowHeight: number, scrollTop: number, viewportHeight: number): number {
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollTop) return rowTop;
  if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
  return scrollTop;
}
