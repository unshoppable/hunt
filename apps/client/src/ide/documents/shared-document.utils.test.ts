import { describe, expect, it } from "vitest";
import { minimalChange, remoteChangeAction, type TextReplacement } from "./shared-document.utils";

function apply(text: string, change: TextReplacement | null): string {
  return change ? text.slice(0, change.start) + change.text + text.slice(change.end) : text;
}

describe("remoteChangeAction", () => {
  it("applies the next version and ignores versions the replica holds", () => {
    expect(remoteChangeAction(4, false, 5)).toBe("apply");
    expect(remoteChangeAction(4, false, 4)).toBe("ignore");
    expect(remoteChangeAction(4, false, 3)).toBe("ignore");
  });

  it("re-reads after a gap and skips changes while busy", () => {
    expect(remoteChangeAction(4, false, 6)).toBe("resync");
    expect(remoteChangeAction(4, true, 5)).toBe("ignore");
  });
});

describe("minimalChange", () => {
  it("is null for equal texts", () => {
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("covers only what differs", () => {
    expect(minimalChange("const a = 1;", "const ab = 1;")).toEqual({ start: 7, end: 7, text: "b" });
    expect(minimalChange("abcdef", "abef")).toEqual({ start: 2, end: 4, text: "" });
    expect(minimalChange("one\ntwo\n", "one\nTWO\nthree\n")).toEqual({ start: 4, end: 7, text: "TWO\nthree" });
  });

  it("finds a replacement for repeated characters", () => {
    for (const [oldText, newText] of [["aaa", "aaaa"], ["aaaa", "a"], ["", "x"], ["x", ""]]) {
      expect(apply(oldText, minimalChange(oldText, newText))).toBe(newText);
    }
  });

  it("never splits a surrogate pair or a CRLF", () => {
    const pair = minimalChange("x😀", "x😃");
    expect(pair).toEqual({ start: 1, end: 3, text: "😃" });
    const crlf = minimalChange("a\r\nb", "a\nb");
    expect(crlf).toEqual({ start: 1, end: 3, text: "\n" });
    expect(apply("a\r\nb", crlf)).toBe("a\nb");
  });
});
