import { describe, expect, it } from "vitest";
import { codePasteText, editorCopyLanguage, fenceCode, splitFencedCode } from "./codePaste";

describe("editorCopyLanguage", () => {
  it("reads the language of a Monaco copy", () => {
    expect(editorCopyLanguage(JSON.stringify({ version: 1, isFromEmptySelection: false, multicursorText: null, mode: "typescript" }))).toBe("typescript");
  });

  it("gives no language for plain text and copies without highlighting", () => {
    expect(editorCopyLanguage(JSON.stringify({ version: 1, mode: "plaintext" }))).toBe("");
    expect(editorCopyLanguage(JSON.stringify({ version: 1, mode: null }))).toBe("");
  });

  it("rejects anything that is not Monaco's metadata", () => {
    expect(editorCopyLanguage("")).toBeNull();
    expect(editorCopyLanguage("not json")).toBeNull();
    expect(editorCopyLanguage(JSON.stringify({ version: 2, mode: "rust" }))).toBeNull();
  });
});

describe("fenceCode", () => {
  it("tags the fence with the language", () => {
    expect(fenceCode("a\nb", "rust")).toBe("```rust\na\nb\n```");
  });

  it("makes the fence longer than backtick runs inside the code", () => {
    expect(fenceCode("```ts\nx\n```", "markdown")).toBe("````markdown\n```ts\nx\n```\n````");
  });
});

describe("codePasteText", () => {
  it("leaves a single line alone, also a whole line copied without a selection", () => {
    expect(codePasteText("const a = 1;", "typescript", "", "")).toBeNull();
    expect(codePasteText("const a = 1;\n", "typescript", "", "")).toBeNull();
  });

  it("fences several lines and drops the trailing line break", () => {
    expect(codePasteText("a\nb\n", "", "", "")).toBe("```\na\nb\n```\n");
    expect(codePasteText("a\r\nb", "", "", "")).toBe("```\na\nb\n```\n");
  });

  it("puts the fence on lines of its own, with a line below for the caret", () => {
    expect(codePasteText("a\nb", "ts", "Look at", "please")).toBe("\n```ts\na\nb\n```\n");
    expect(codePasteText("a\nb", "ts", "Look at\n", "\nplease")).toBe("```ts\na\nb\n```");
    expect(codePasteText("a\nb", "ts", "Look at", "")).toBe("\n```ts\na\nb\n```\n");
  });
});

describe("splitFencedCode", () => {
  it("keeps text without fences whole", () => {
    expect(splitFencedCode("one\ntwo")).toEqual([{ kind: "text", text: "one\ntwo" }]);
  });

  it("splits text and fenced code", () => {
    expect(splitFencedCode("Why?\n```ts\nconst a = 1;\n```\nThanks")).toEqual([
      { kind: "text", text: "Why?" },
      { kind: "code", text: "const a = 1;", language: "ts" },
      { kind: "text", text: "Thanks" },
    ]);
  });

  it("closes a fence only with at least as many backticks", () => {
    expect(splitFencedCode("````md\n```\nx\n```\n````")).toEqual([{ kind: "code", text: "```\nx\n```", language: "md" }]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(splitFencedCode("```\na\nb")).toEqual([{ kind: "code", text: "a\nb", language: "" }]);
  });

  it("does not take inline backticks for a fence", () => {
    expect(splitFencedCode("```a``` b")).toEqual([{ kind: "text", text: "```a``` b" }]);
  });
});
