import { describe, expect, it } from "vitest";
import { clipUnchangedRegion, computeChangeBlocks, computeInnerChanges, computeRevertEdit, computeUnchangedRegions, mapLine, type TextEdit } from "./lineDiff";

const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";

describe("computeChangeBlocks", () => {
  it("reports a pure insertion with an empty original range", () => {
    const blocks = computeChangeBlocks("a\nb\n", "a\nx\ny\nb\n");
    expect(blocks).toEqual([{ original: { start: 2, end: 2 }, modified: { start: 2, end: 4 } }]);
  });

  it("merges removed and added lines into one modification block", () => {
    const blocks = computeChangeBlocks("a\nb\nc\n", "a\nB\nc\n");
    expect(blocks).toEqual([{ original: { start: 2, end: 3 }, modified: { start: 2, end: 3 } }]);
  });

  it("reports a deletion at the end with an empty modified range", () => {
    const blocks = computeChangeBlocks("a\nb\n", "a\n");
    expect(blocks).toEqual([{ original: { start: 2, end: 3 }, modified: { start: 2, end: 2 } }]);
  });
});

describe("computeUnchangedRegions", () => {
  it("keeps context lines around a block and none at the file edges", () => {
    const blocks = computeChangeBlocks(lines(30), lines(30).replace("line 15", "LINE 15"));
    const regions = computeUnchangedRegions(blocks, 30, 30, 3, 3);
    expect(regions).toEqual([
      { original: { start: 1, end: 12 }, modified: { start: 1, end: 12 } },
      { original: { start: 19, end: 31 }, modified: { start: 19, end: 31 } },
    ]);
  });

  it("offsets the modified range after an insertion", () => {
    const blocks = [{ original: { start: 5, end: 5 }, modified: { start: 5, end: 8 } }];
    const regions = computeUnchangedRegions(blocks, 20, 23, 2, 3);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ original: { start: 7, end: 21 }, modified: { start: 10, end: 24 } });
  });
});

describe("clipUnchangedRegion", () => {
  it("shrinks a region that a new change cuts into and shifts its modified side", () => {
    const region = { original: { start: 1, end: 12 }, modified: { start: 1, end: 12 } };
    const blocks = [{ original: { start: 10, end: 10 }, modified: { start: 10, end: 12 } }];
    expect(clipUnchangedRegion(region, blocks, 30, 32, 3)).toEqual({ original: { start: 1, end: 7 }, modified: { start: 1, end: 7 } });
  });

  it("drops a region that is fully changed", () => {
    const region = { original: { start: 5, end: 8 }, modified: { start: 5, end: 8 } };
    const blocks = [{ original: { start: 4, end: 9 }, modified: { start: 4, end: 9 } }];
    expect(clipUnchangedRegion(region, blocks, 10, 10, 0)).toBeNull();
  });
});

describe("computeInnerChanges", () => {
  it("highlights the changed words of paired lines", () => {
    const block = { original: { start: 1, end: 2 }, modified: { start: 1, end: 2 } };
    const inner = computeInnerChanges(block, ["const a = 1;"], ["const b = 1;"]);
    expect(inner.original).toEqual([{ line: 1, startColumn: 7, endColumn: 8 }]);
    expect(inner.modified).toEqual([{ line: 1, startColumn: 7, endColumn: 8 }]);
  });

  it("skips blocks whose sides differ in line count", () => {
    const block = { original: { start: 1, end: 2 }, modified: { start: 1, end: 3 } };
    expect(computeInnerChanges(block, ["a"], ["a", "b"])).toEqual({ original: [], modified: [] });
  });
});

describe("mapLine", () => {
  const blocks = [
    { original: { start: 3, end: 3 }, modified: { start: 3, end: 7 } },
    { original: { start: 10, end: 12 }, modified: { start: 14, end: 15 } },
  ];

  it("maps unchanged lines one to one with the accumulated shift", () => {
    expect(mapLine(blocks, "modified", 2)).toBe(2);
    expect(mapLine(blocks, "modified", 8)).toBe(4);
    expect(mapLine(blocks, "original", 4)).toBe(8);
    expect(mapLine(blocks, "original", 20)).toBe(23);
  });

  it("interpolates inside a block", () => {
    expect(mapLine(blocks, "modified", 5)).toBe(3);
    expect(mapLine(blocks, "original", 11)).toBe(14.5);
  });
});

describe("computeRevertEdit", () => {
  /** Applies the edit the way Monaco would and returns the resulting text. */
  const revertAll = (original: string, modified: string): string => {
    let text = modified;
    for (const block of computeChangeBlocks(original, modified).reverse()) {
      const edit = computeRevertEdit(original.split("\n"), text.split("\n"), block, "\n");
      text = applyEdit(text, edit);
    }
    return text;
  };
  const applyEdit = (text: string, edit: TextEdit): string => {
    const lines = text.split("\n");
    const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((sum, current) => sum + current.length + 1, 0) + column - 1;
    return text.slice(0, offset(edit.startLine, edit.startColumn)) + edit.text + text.slice(offset(edit.endLine, edit.endColumn));
  };

  it("restores a modified block", () => {
    expect(revertAll("a\nb\nc\n", "a\nB\nX\nc\n")).toBe("a\nb\nc\n");
  });

  it("removes inserted lines in the middle, at the start and at the end", () => {
    expect(revertAll("a\nb\n", "a\nx\ny\nb\n")).toBe("a\nb\n");
    expect(revertAll("a\nb\n", "x\na\nb\n")).toBe("a\nb\n");
    expect(revertAll("a\nb\n", "a\nb\nx\n")).toBe("a\nb\n");
    expect(revertAll("a\nb", "a\nb\nx")).toBe("a\nb");
    expect(revertAll("", "x\ny")).toBe("");
  });

  it("re-inserts deleted lines in the middle, at the start and at the end", () => {
    expect(revertAll("a\nb\nc\n", "a\nc\n")).toBe("a\nb\nc\n");
    expect(revertAll("a\nb\nc\n", "b\nc\n")).toBe("a\nb\nc\n");
    expect(revertAll("a\nb\nc\n", "a\nb\n")).toBe("a\nb\nc\n");
    expect(revertAll("a\nb\nc", "a\nb\n")).toBe("a\nb\nc");
    expect(revertAll("a\nb", "a")).toBe("a\nb");
  });

  it("handles several blocks in one file", () => {
    const original = lines(12);
    const modified = original.replace("line 2\n", "").replace("line 6", "LINE 6").replace("line 10\n", "line 10\nnew\n");
    expect(revertAll(original, modified)).toBe(original);
  });
});
