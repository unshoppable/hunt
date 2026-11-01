import { describe, expect, it } from "vitest";
import type { HighlightedLine } from "../../editor/highlight.monaco";
import { cachedValue, excerptRuns } from "./line-runs.utils";

const COMMENT = { foreground: "#808080", fontStyle: 0 };
const KEYWORD = { foreground: "#cc7832", fontStyle: 0 };
const TEXT = { foreground: "#a9b7c6", fontStyle: 0 };

describe("excerptRuns", () => {
  const line: HighlightedLine = [
    { text: "   * ", style: COMMENT },
    { text: "const x = 1;", style: COMMENT },
  ];

  it("cuts the shown text out of the colored file line, without its indentation", () => {
    expect(excerptRuns(line, "* const x = 1;")).toEqual([{ text: "* ", style: COMMENT }, { text: "const x = 1;", style: COMMENT }]);
  });

  it("gives each ellipsis the color next to it", () => {
    const code: HighlightedLine = [
      { text: "return ", style: KEYWORD },
      { text: "value + other", style: TEXT },
    ];
    expect(excerptRuns(code, "…urn value…")).toEqual([
      { text: "…", style: KEYWORD },
      { text: "urn ", style: KEYWORD },
      { text: "value", style: TEXT },
      { text: "…", style: TEXT },
    ]);
  });

  it("is null when the line no longer holds the text", () => {
    expect(excerptRuns(line, "let y")).toBeNull();
  });
});

describe("cachedValue", () => {
  it("computes a missing value once and drops the least recently used beyond the capacity", () => {
    const cache = new Map<string, number>();
    let computed = 0;
    const value = (key: string) => cachedValue(cache, key, 2, () => ++computed);
    expect([value("a"), value("b"), value("a")]).toEqual([1, 2, 1]);
    value("c");
    expect([...cache.keys()]).toEqual(["a", "c"]);
    expect(value("b")).toBe(4);
  });

  it("keeps no null", () => {
    const cache = new Map<string, number>();
    expect(cachedValue(cache, "a", 2, () => null)).toBeNull();
    expect(cache.size).toBe(0);
  });
});
