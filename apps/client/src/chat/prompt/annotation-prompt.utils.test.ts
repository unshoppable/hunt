import { describe, expect, it } from "vitest";
import type { StoredBrowserAnnotation } from "../../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { annotationElementLabel, annotationTooltip, formatAnnotation, formatAnnotations, promptWithAnnotations, sourceLocation } from "./annotation-prompt.utils";

function annotation(overrides: Partial<StoredBrowserAnnotation> = {}): StoredBrowserAnnotation {
  return {
    id: "5b0c",
    createdAt: 1_760_000_000_000,
    url: "https://app.example/cart",
    title: "Cart",
    selector: "main > button.buy",
    text: "Buy\n   now",
    outerHtml: '<button class="buy">Buy now</button>',
    rect: { x: 10.4, y: 20.6, width: 80, height: 32 },
    viewport: { width: 1280, height: 800 },
    styles: { color: "rgb(0, 0, 0)", "font-size": "14px" },
    source: { file: "src/cart/Cart.tsx", line: 12, column: 5 },
    comment: "Make it blue",
    ...overrides,
  };
}

describe("formatAnnotation", () => {
  it("renders the comment, page, element, source, text, box, styles and HTML of an annotation", () => {
    expect(formatAnnotation(annotation(), 2)).toBe(
      [
        "### Annotation 2",
        "",
        "> Make it blue",
        "",
        "- Page: Cart – https://app.example/cart",
        "- Element: `main > button.buy`",
        "- Source: `src/cart/Cart.tsx:12:5`",
        "- Text: Buy now",
        "- Box: 80×32 at (10, 21) in a 1280×800 viewport",
        "- Styles: color: rgb(0, 0, 0); font-size: 14px",
        "",
        "```html",
        '<button class="buy">Buy now</button>',
        "```",
      ].join("\n"),
    );
  });

  it("leaves out what the annotation lacks and quotes a comment of several lines", () => {
    const bare = annotation({ title: "", text: " ", outerHtml: "", styles: {}, source: undefined, comment: "Too tight.\n\nAdd space." });
    expect(formatAnnotation(bare, 1)).toBe(
      [
        "### Annotation 1",
        "",
        "> Too tight.",
        ">",
        "> Add space.",
        "",
        "- Page: https://app.example/cart",
        "- Element: `main > button.buy`",
        "- Box: 80×32 at (10, 21) in a 1280×800 viewport",
      ].join("\n"),
    );
  });

  it("keeps backticks of the selector and the HTML inside their code", () => {
    const formatted = formatAnnotation(annotation({ selector: "[data-x=`a`]", outerHtml: "<pre>```js```</pre>" }), 1);
    expect(formatted).toContain("- Element: ``[data-x=`a`]``");
    expect(formatted).toContain("````html\n<pre>```js```</pre>\n````");
  });

  it("lists at most eight styles", () => {
    const styles = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`style-${index}`, `${index}`]));
    const stylesLine = formatAnnotation(annotation({ styles }), 1)
      .split("\n")
      .find((line) => line.startsWith("- Styles:"));
    expect(stylesLine?.split("; ")).toHaveLength(8);
  });
});

describe("promptWithAnnotations", () => {
  it("is only the user's text without annotations", () => {
    expect(promptWithAnnotations([], "Fix the cart")).toBe("Fix the cart");
  });

  it("puts the numbered annotations into the prompt file and the user's text after it", () => {
    const annotations = [annotation(), annotation({ id: "7d1e", comment: "Remove this" })];
    const prompt = promptWithAnnotations(annotations, "Fix the cart");
    expect(prompt).toContain(formatAnnotations(annotations));
    expect(prompt).toContain("### Annotation 1\n\n> Make it blue");
    expect(prompt).toContain("### Annotation 2\n\n> Remove this");
    expect(prompt).not.toContain("{{");
    expect(prompt.endsWith("```\n\nFix the cart")).toBe(true);
  });

  it("is the filled prompt file alone without the user's text", () => {
    const prompt = promptWithAnnotations([annotation()], "");
    expect(prompt.startsWith("I annotated elements")).toBe(true);
    expect(prompt.endsWith("```")).toBe(true);
  });
});

describe("annotation labels", () => {
  it("names the source location with and without a column", () => {
    expect(sourceLocation(annotation())).toBe("src/cart/Cart.tsx:12:5");
    expect(sourceLocation(annotation({ source: { file: "src/App.tsx", line: 3 } }))).toBe("src/App.tsx:3");
    expect(sourceLocation(annotation({ source: undefined }))).toBe("");
  });

  it("names the element by its source file and line, else by its tag and the selector's last part", () => {
    expect(annotationElementLabel(annotation())).toBe("Cart.tsx:12");
    expect(annotationElementLabel(annotation({ source: undefined }))).toBe("button.buy");
    expect(annotationElementLabel(annotation({ source: undefined, selector: "#main .price" }))).toBe("button .price");
    expect(annotationElementLabel(annotation({ source: undefined, outerHtml: "" }))).toBe("button.buy");
  });

  it("tells the comment, the element and the page in the tooltip", () => {
    expect(annotationTooltip(annotation())).toBe("Make it blue\nmain > button.buy\nsrc/cart/Cart.tsx:12:5\nCart – https://app.example/cart");
    expect(annotationTooltip(annotation({ title: "", source: undefined }))).toBe("Make it blue\nmain > button.buy\nhttps://app.example/cart");
  });
});
