import { describe, expect, it } from "vitest";
import { createLineDecoder, encodeLine, parseLine } from "./ndjson.utils.ts";

describe("createLineDecoder", () => {
  it("emits complete lines across chunk boundaries and skips blank lines", () => {
    const lines: string[] = [];
    const decoder = createLineDecoder((line) => lines.push(line));

    decoder.push('{"a":1}\n{"b"');
    decoder.push(':2}\r\n\n  \n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}\r']);

    decoder.push("3}\n");
    expect(lines.map(parseLine)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("assembles a line split over many chunks", () => {
    const lines: string[] = [];
    const decoder = createLineDecoder((line) => lines.push(line));
    const text = "x".repeat(10_000);

    for (const part of encodeLine({ text }).match(/[\s\S]{1,333}/g) ?? []) {
      decoder.push(part);
    }

    expect(lines.map(parseLine)).toEqual([{ text }]);
  });
});

describe("encodeLine", () => {
  it("writes one line per message, also for text with line breaks", () => {
    const line = encodeLine({ text: "two\nlines" });

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseLine(line)).toEqual({ text: "two\nlines" });
  });
});

describe("parseLine", () => {
  it("returns undefined for a line that is not JSON", () => {
    expect(parseLine("{oops")).toBeUndefined();
    expect(parseLine("null")).toBeNull();
  });
});
