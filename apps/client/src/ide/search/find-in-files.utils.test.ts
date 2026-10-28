import { describe, expect, it } from "vitest";
import { matchSummary, selectionQuery, splitByRanges, splitRunsByRanges } from "./find-in-files.utils";

const match = (path: string, line: number) => ({ path, line, column: 1, endColumn: 2, preview: "x", ranges: [] });

describe("splitByRanges", () => {
  it("alternates plain and matched parts", () => {
    expect(splitByRanges("const a = private;", [{ start: 10, end: 17 }])).toEqual([
      { text: "const a = ", isMatch: false },
      { text: "private", isMatch: true },
      { text: ";", isMatch: false },
    ]);
  });

  it("keeps adjacent matches apart and clips ranges past the end", () => {
    expect(splitByRanges("abab", [{ start: 0, end: 2 }, { start: 2, end: 9 }])).toEqual([
      { text: "ab", isMatch: true },
      { text: "ab", isMatch: true },
    ]);
    expect(splitByRanges("plain", [])).toEqual([{ text: "plain", isMatch: false }]);
  });
});

describe("splitRunsByRanges", () => {
  const keyword = { foreground: "#c08cff", fontStyle: 0 };
  const text = { foreground: "#f7e862", fontStyle: 0 };

  it("cuts the runs at the matches and keeps each stretch's style", () => {
    const runs = [
      { text: "const", style: keyword },
      { text: " shouldPoll;", style: text },
    ];
    expect(splitRunsByRanges(runs, [{ start: 3, end: 12 }])).toEqual([
      { runs: [{ text: "con", style: keyword }], isMatch: false },
      { runs: [{ text: "st", style: keyword }, { text: " should", style: text }], isMatch: true },
      { runs: [{ text: "Poll;", style: text }], isMatch: false },
    ]);
  });

  it("returns the whole line as one part without matches", () => {
    expect(splitRunsByRanges([{ text: "plain", style: text }], [])).toEqual([{ runs: [{ text: "plain", style: text }], isMatch: false }]);
  });
});

describe("matchSummary", () => {
  it("counts lines and files", () => {
    expect(matchSummary({ matches: [match("a.ts", 1), match("a.ts", 4), match("b.ts", 2)], isTruncated: false })).toBe("3 matches in 2 files");
    expect(matchSummary({ matches: [match("a.ts", 1)], isTruncated: false })).toBe("1 match in 1 file");
    expect(matchSummary({ matches: [match("a.ts", 1)], isTruncated: true })).toBe("1+ matches in 1+ files");
    expect(matchSummary({ matches: [], isTruncated: false })).toBe("No matches");
  });
});

describe("selectionQuery", () => {
  it("takes a single non-blank line only", () => {
    expect(selectionQuery("userId")).toBe("userId");
    expect(selectionQuery("a\nb")).toBeNull();
    expect(selectionQuery("  ")).toBeNull();
    expect(selectionQuery(undefined)).toBeNull();
  });
});
