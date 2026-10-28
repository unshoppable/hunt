import { describe, expect, it } from "vitest";
import { excerptSpans, lineSpans } from "./excerpt.utils";
import type { SemanticSpan } from "./semantic-tokens.monaco";

/** A span of `role` over every occurrence of `name` in `text`. */
const spansOf = (text: string, name: string, role: number): SemanticSpan[] =>
  [...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))].map((match) => ({ start: match.index, length: name.length, role }));

/** The names the spans of `text` cover, with their roles. */
const named = (text: string, spans: SemanticSpan[] | null) => spans?.map((span) => [text.slice(span.start, span.start + span.length), span.role]);

const FILE = [
  'import { SsrBaseConfig } from "../config/ssr-base.schema";',
  "",
  "class Policy {",
  "  sources(): string[] {",
  "    if (SsrBaseConfig.LOCAL) return [];",
  "",
  "    return [SsrBaseConfig.ORIGIN];",
  "  }",
  "}",
].join("\n");
const FILE_SPANS = [...spansOf(FILE, "SsrBaseConfig", 12), ...spansOf(FILE, "Policy", 0)].sort((first, second) => first.start - second.start);

describe("excerptSpans", () => {
  it("keeps the spans of the excerpt's lines at their offsets within the excerpt", () => {
    const excerpt = ["class Policy {", "  sources(): string[] {", "    if (SsrBaseConfig.LOCAL) return [];"].join("\n");
    const spans = excerptSpans(FILE, FILE_SPANS, excerpt, 3);
    expect(named(excerpt, spans)).toEqual([
      ["Policy", 0],
      ["SsrBaseConfig", 12],
    ]);
  });

  it("follows a dedented excerpt line by line, blank lines included", () => {
    const excerpt = ["if (SsrBaseConfig.LOCAL) return [];", "", "return [SsrBaseConfig.ORIGIN];"].join("\n");
    const spans = excerptSpans(FILE, FILE_SPANS, excerpt, 5);
    expect(named(excerpt, spans)).toEqual([
      ["SsrBaseConfig", 12],
      ["SsrBaseConfig", 12],
    ]);
  });

  it("maps the offsets of a file with CRLF line breaks", () => {
    const crlfFile = FILE.split("\n").join("\r\n");
    const crlfSpans = spansOf(crlfFile, "SsrBaseConfig", 12);
    const excerpt = "    return [SsrBaseConfig.ORIGIN];";
    expect(named(excerpt, excerptSpans(crlfFile, crlfSpans, excerpt, 7))).toEqual([["SsrBaseConfig", 12]]);
  });

  it("returns null when the lines differ from the file", () => {
    expect(excerptSpans(FILE, FILE_SPANS, "    if (SsrBaseConfig.REMOTE) return [];", 5)).toBeNull();
    expect(excerptSpans(FILE, FILE_SPANS, "class Policy {", 4)).toBeNull();
  });

  it("returns null when the excerpt runs past the end of the file", () => {
    expect(excerptSpans(FILE, FILE_SPANS, "}\nmore", 9)).toBeNull();
    expect(excerptSpans(FILE, FILE_SPANS, "class Policy {", 0)).toBeNull();
  });
});

describe("lineSpans", () => {
  it("keeps the spans of a line shown without its indentation", () => {
    const text = "return [SsrBaseConfig.ORIGIN];";
    expect(named(text, lineSpans(FILE, FILE_SPANS, 7, text))).toEqual([["SsrBaseConfig", 12]]);
  });

  it("shifts the spans behind the ellipsis of a line cut at the start and drops those cut off", () => {
    const text = "…aseConfig.LOCAL) return [];";
    expect(lineSpans(FILE, FILE_SPANS, 5, text)).toEqual([]);
    const cut = "…(SsrBaseConfig.LOCAL…";
    expect(named(cut, lineSpans(FILE, FILE_SPANS, 5, cut))).toEqual([["SsrBaseConfig", 12]]);
  });

  it("is null when the line no longer contains the text", () => {
    expect(lineSpans(FILE, FILE_SPANS, 4, "return [SsrBaseConfig.ORIGIN];")).toBeNull();
    expect(lineSpans(FILE, FILE_SPANS, 42, "class Policy {")).toBeNull();
  });
});
