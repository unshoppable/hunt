import { describe, expect, it } from "vitest";
import { ANNOTATION_LIMITS, parseBrowserAnnotation, parseStoredBrowserAnnotation, type BrowserAnnotation } from "./browserAnnotation.ts";

const ANNOTATION: BrowserAnnotation = {
  url: "https://7c0c6f2e-4200.hunt.example.com/orders",
  title: "Orders",
  selector: "main > button.save",
  text: "Save",
  outerHtml: '<button class="save">Save</button>',
  rect: { x: 10, y: 20.5, width: 80, height: 32 },
  viewport: { width: 1280, height: 800 },
  styles: { color: "rgb(0, 0, 0)", "font-size": "14px" },
  source: { file: "src/app/orders.tsx", line: 42, column: 7 },
  comment: "Make this the primary button",
};

describe("parseBrowserAnnotation", () => {
  it("reads a complete annotation, one without a source or column, and drops unknown fields", () => {
    expect(parseBrowserAnnotation({ ...ANNOTATION, extra: 1 })).toEqual({ annotation: ANNOTATION });
    const { source: _source, ...withoutSource } = ANNOTATION;
    expect(parseBrowserAnnotation(withoutSource)).toEqual({ annotation: withoutSource });
    const withoutColumn = { ...ANNOTATION, source: { file: "a.tsx", line: 1 } };
    expect(parseBrowserAnnotation(withoutColumn)).toEqual({ annotation: withoutColumn });
  });

  it("reports the first problem of an invalid annotation", () => {
    const cases: [unknown, string][] = [
      [null, "the annotation must be an object"],
      [{ ...ANNOTATION, comment: " " }, "comment must be a non-empty string of at most 4000 characters"],
      [{ ...ANNOTATION, url: 1 }, "url must be a non-empty string of at most 2048 characters"],
      [{ ...ANNOTATION, outerHtml: "x".repeat(ANNOTATION_LIMITS.outerHtml + 1) }, "outerHtml must be a string of at most 4000 characters"],
      [{ ...ANNOTATION, rect: { x: 1, y: 2, width: 3 } }, "rect must hold the numbers x, y, width, height"],
      [{ ...ANNOTATION, viewport: "1280x800" }, "viewport must hold the numbers width, height"],
      [{ ...ANNOTATION, styles: { Color: "red" } }, "styles must map at most 32 CSS properties to strings"],
      [{ ...ANNOTATION, styles: { color: 1 } }, "styles must map at most 32 CSS properties to strings"],
      [{ ...ANNOTATION, source: { file: "a.tsx", line: -1 } }, "source must hold a file and a line, optionally a column"],
      [{ ...ANNOTATION, source: { line: 1 } }, "source must hold a file and a line, optionally a column"],
    ];
    for (const [value, error] of cases) {
      expect(parseBrowserAnnotation(value), error).toEqual({ error });
    }
  });
});

describe("parseStoredBrowserAnnotation", () => {
  it("reads an annotation with its id and time, nothing without them", () => {
    const stored = { id: "0b5a7c1e-1f0d-4c1a-9c1e-2a3b4c5d6e7f", createdAt: 1_700_000_000_000, ...ANNOTATION };
    expect(parseStoredBrowserAnnotation(stored)).toEqual(stored);
    expect(parseStoredBrowserAnnotation(ANNOTATION)).toBeUndefined();
    expect(parseStoredBrowserAnnotation({ ...stored, comment: "" })).toBeUndefined();
  });
});
