import { describe, expect, it } from "vitest";
import { selectedLineSpan } from "./selectionContext";

describe("selectedLineSpan", () => {
  it("keeps a selection that ends mid-line", () => {
    expect(selectedLineSpan({ startLineNumber: 3, startColumn: 1, endLineNumber: 5, endColumn: 8 })).toEqual({ startLine: 3, endLine: 5 });
  });

  it("drops the line a whole-line drag selection ends in front of", () => {
    expect(selectedLineSpan({ startLineNumber: 3, startColumn: 1, endLineNumber: 6, endColumn: 1 })).toEqual({ startLine: 3, endLine: 5 });
  });

  it("keeps a single-line selection that ends at column 1", () => {
    expect(selectedLineSpan({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 })).toEqual({ startLine: 3, endLine: 3 });
  });
});
