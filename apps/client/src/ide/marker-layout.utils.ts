import { rangeLength, type ChangeBlock } from "../editor/line-diff.utils";

export type MarkerKind = "insert" | "modify" | "delete";

/**
 * Gutter marker of one change block: a stripe over lines `startLine..endLine` (inclusive) for inserted or modified
 * lines, or a triangle at the `edge` of the single line next to a deletion.
 */
export type Marker = { block: ChangeBlock; kind: MarkerKind; startLine: number; endLine: number; edge: "top" | "bottom" | null };

/** Markers for `blocks` in a model with `lineCount` lines; a deletion past the last line sits at that line's bottom edge. */
export function markersFor(blocks: ChangeBlock[], lineCount: number): Marker[] {
  return blocks.map((block) => {
    if (rangeLength(block.modified) === 0) {
      const isPastEnd = block.modified.start > lineCount;
      const line = isPastEnd ? lineCount : block.modified.start;
      return { block, kind: "delete", startLine: line, endLine: line, edge: isPastEnd ? "bottom" : "top" };
    }
    const kind: MarkerKind = rangeLength(block.original) === 0 ? "insert" : "modify";
    return { block, kind, startLine: block.modified.start, endLine: block.modified.end - 1, edge: null };
  });
}
