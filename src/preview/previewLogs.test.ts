import { describe, expect, it } from "vitest";
import { appendLogChunk, EMPTY_LOG, stripAnsi } from "./previewLogs";

describe("stripAnsi", () => {
  it("removes colors, cursor moves and control characters but keeps tabs and line breaks", () => {
    expect(stripAnsi("\u001b[32mready\u001b[39m in 3\tms\r\nnext\u0007")).toBe("ready in 3\tms\nnext");
    expect(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("link");
  });
});

describe("appendLogChunk", () => {
  it("appends a chunk that continues the view and counts the end in bytes", () => {
    const first = appendLogChunk(EMPTY_LOG, { size: 7, offset: 0, text: "ä\nb\n", reset: false });
    expect(first).toEqual({ text: "ä\nb\n", end: 5 });
    expect(appendLogChunk(first, { size: 8, offset: 5, text: "c\n", reset: false })).toEqual({ text: "ä\nb\nc\n", end: 7 });
  });

  it("replaces the text after a rotation or when the chunk starts elsewhere", () => {
    const view = { text: "old\n", end: 4 };
    expect(appendLogChunk(view, { size: 3, offset: 0, text: "new", reset: true }).text).toBe("new");
    expect(appendLogChunk(view, { size: 900, offset: 800, text: "tail", reset: false }).text).toBe("tail");
  });

  it("keeps only the newest lines", () => {
    const view = appendLogChunk(EMPTY_LOG, { size: 8, offset: 0, text: "1\n2\n3\n4\n", reset: false }, 3);
    expect(view.text).toBe("3\n4\n");
  });
});
