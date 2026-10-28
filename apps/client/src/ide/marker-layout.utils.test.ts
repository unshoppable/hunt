import { describe, expect, it } from "vitest";
import { computeChangeBlocks } from "../editor/line-diff.utils";
import { markersFor } from "./marker-layout.utils";

describe("markersFor", () => {
  it("marks inserted lines green over exactly the inserted range", () => {
    const blocks = computeChangeBlocks("a\nb\n", "a\nx\ny\nb\n");
    expect(markersFor(blocks, 5)).toEqual([{ block: blocks[0], kind: "insert", startLine: 2, endLine: 3, edge: null }]);
  });

  it("marks changed lines blue", () => {
    const blocks = computeChangeBlocks("a\nb\nc\n", "a\nB\nc\n");
    expect(markersFor(blocks, 4)).toEqual([{ block: blocks[0], kind: "modify", startLine: 2, endLine: 2, edge: null }]);
  });

  it("puts a deletion triangle at the top of the line that follows the removed lines", () => {
    const blocks = computeChangeBlocks("a\nb\nc\n", "a\nc\n");
    expect(markersFor(blocks, 3)).toEqual([{ block: blocks[0], kind: "delete", startLine: 2, endLine: 2, edge: "top" }]);
  });

  it("puts a deletion past the last line at that line's bottom edge", () => {
    const block = { original: { start: 2, end: 3 }, modified: { start: 2, end: 2 } };
    expect(markersFor([block], 1)).toEqual([{ block, kind: "delete", startLine: 1, endLine: 1, edge: "bottom" }]);
  });
});
