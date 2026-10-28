import { describe, expect, it } from "vitest";
import { LineSpan } from "./line-span.value-object";

describe("LineSpan", () => {
  it("rejects a negative line", () => {
    expect(() => LineSpan.of(-1, 3)).toThrow();
    expect(() => LineSpan.of(2, -1)).toThrow();
  });

  it("rejects a line that is no integer", () => {
    expect(() => LineSpan.of(1.5, 3)).toThrow();
  });

  it("rejects a span that ends before it starts", () => {
    expect(() => LineSpan.of(5, 4)).toThrow(/startLine ≤ endLine/);
  });

  it("rejects a span that starts at 0 but ends on a line", () => {
    expect(() => LineSpan.of(0, 3)).toThrow(/whole file/);
  });

  it("rejects a span that starts on a line but ends at 0", () => {
    expect(() => LineSpan.of(3, 0)).toThrow(/whole file/);
  });

  it("stands for the whole file with both lines 0", () => {
    expect(LineSpan.FILE.isFile).toBe(true);
    expect(LineSpan.of(0, 0).isEqualTo(LineSpan.FILE)).toBe(true);
    expect(LineSpan.of(1, 1).isFile).toBe(false);
  });

  it("reads the lines of a review comment, whose last line is `line`", () => {
    expect(LineSpan.ofComment({ startLine: 4, line: 6 }).toJSON()).toEqual({ startLine: 4, endLine: 6 });
    expect(LineSpan.ofComment({ startLine: 0, line: 0 }).isFile).toBe(true);
  });

  it("tells the last line of a comment on the whole file from a line", () => {
    expect(LineSpan.isFileLine(0)).toBe(true);
    expect(LineSpan.isFileLine(1)).toBe(false);
  });

  it("names the file, a single line or a range of lines", () => {
    expect(LineSpan.FILE.label).toBe("File");
    expect(LineSpan.of(5, 5).label).toBe("L5");
    expect(LineSpan.of(5, 9).label).toBe("L5–L9");
  });

  it("compares spans by their lines", () => {
    expect(LineSpan.of(3, 5).isEqualTo(LineSpan.of(3, 5))).toBe(true);
    expect(LineSpan.of(3, 5).isEqualTo(LineSpan.of(3, 6))).toBe(false);
  });
});

describe("LineSpan.isInsideHunk", () => {
  const blocks = [
    { original: { start: 10, end: 12 }, modified: { start: 10, end: 13 } },
    { original: { start: 40, end: 42 }, modified: { start: 41, end: 41 } },
  ];

  it("covers the changed lines and three context lines on either side", () => {
    expect(LineSpan.of(7, 7).isInsideHunk(blocks)).toBe(true);
    expect(LineSpan.of(6, 6).isInsideHunk(blocks)).toBe(false);
    expect(LineSpan.of(15, 15).isInsideHunk(blocks)).toBe(true);
    expect(LineSpan.of(16, 16).isInsideHunk(blocks)).toBe(false);
  });

  it("surrounds a deletion with context around the line it sits before", () => {
    expect(LineSpan.of(38, 38).isInsideHunk(blocks)).toBe(true);
    expect(LineSpan.of(43, 43).isInsideHunk(blocks)).toBe(true);
    expect(LineSpan.of(37, 37).isInsideHunk(blocks)).toBe(false);
    expect(LineSpan.of(44, 44).isInsideHunk(blocks)).toBe(false);
  });

  it("requires the whole span to lie in one hunk", () => {
    expect(LineSpan.of(7, 15).isInsideHunk(blocks)).toBe(true);
    expect(LineSpan.of(7, 16).isInsideHunk(blocks)).toBe(false);
    expect(LineSpan.of(1, 1).isInsideHunk([])).toBe(false);
  });

  it("takes another number of context lines", () => {
    expect(LineSpan.of(8, 8).isInsideHunk(blocks, 1)).toBe(false);
    expect(LineSpan.of(9, 9).isInsideHunk(blocks, 1)).toBe(true);
  });
});

describe("LineSpan.isPostedOnDiff", () => {
  const blocks = [{ original: { start: 1, end: 3 }, modified: { start: 1, end: 4 } }];

  it("posts a file comment on a changed file and turns one on an unchanged file into a note", () => {
    expect(LineSpan.FILE.isPostedOnDiff(blocks)).toBe(true);
    expect(LineSpan.FILE.isPostedOnDiff([])).toBe(false);
  });

  it("posts a line comment only inside a hunk, even near the top of the file", () => {
    expect(LineSpan.of(2, 6).isPostedOnDiff(blocks)).toBe(true);
    expect(LineSpan.of(7, 7).isPostedOnDiff(blocks)).toBe(false);
  });
});

describe("LineSpan.merge", () => {
  it("sorts the spans and merges overlapping ones without changing them", () => {
    const spans = [LineSpan.of(20, 22), LineSpan.of(3, 5), LineSpan.of(5, 5), LineSpan.of(4, 8), LineSpan.of(9, 9)];
    expect(LineSpan.merge(spans).map((span) => span.toJSON())).toEqual([
      { startLine: 3, endLine: 8 },
      { startLine: 9, endLine: 9 },
      { startLine: 20, endLine: 22 },
    ]);
    expect(spans.map((span) => span.label)).toEqual(["L20–L22", "L3–L5", "L5", "L4–L8", "L9"]);
  });

  it("merges nothing into nothing", () => {
    expect(LineSpan.merge([])).toEqual([]);
  });
});
