import { describe, expect, it } from "vitest";
import type { StoredBrowserAnnotation } from "../../../../../libs/domain/src/review/browser-annotation.utils.ts";
import {
  annotationElementLabel,
  annotationScreenshots,
  annotationTooltip,
  formatAnnotation,
  formatAnnotations,
  parseAnnotatedPrompt,
  promptSummary,
  promptWithAnnotations,
  sourceLocation,
} from "./annotation-prompt.utils";

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

describe("component and screenshot", () => {
  it("names the component and the prompt image of the screenshot", () => {
    const formatted = formatAnnotation(annotation({ source: undefined, component: { name: "JeStationPage", tag: "app-je-station-page" } }), 1, 3);
    expect(formatted).toContain("- Element: `main > button.buy`\n- Component: `JeStationPage` (`<app-je-station-page>`)\n- Screenshot: [Image #3]\n- Text: Buy now");
  });

  it("numbers only the annotations with a screenshot, after the user's own images", () => {
    const annotations = [annotation({ screenshotPath: "/a/1.png" }), annotation({ id: "2" }), annotation({ id: "3", screenshotPath: "/a/3.png" })];
    const formatted = formatAnnotations(annotations, 2);
    expect(formatted.match(/\[Image #\d+\]/g)).toEqual(["[Image #2]", "[Image #3]"]);
    expect(annotationScreenshots(annotations).map((screenshot) => screenshot.path)).toEqual(["/a/1.png", "/a/3.png"]);
  });
});

describe("parseAnnotatedPrompt", () => {
  it("reads the annotations and the user's text back from a prompt", () => {
    const annotations = [
      annotation({ screenshotPath: "/a/1.png" }),
      annotation({ id: "2", source: undefined, component: { name: "JeStationPage", tag: "app-je-station-page" }, comment: "Too tight.\n\nAdd space." }),
      annotation({ id: "3", source: undefined, outerHtml: "", selector: "[data-x=`a`]", comment: "Hide it" }),
    ];
    expect(parseAnnotatedPrompt(promptWithAnnotations(annotations, "Fix the cart\n\n- first\n- second", 2))).toEqual({
      annotations: [
        { comment: "Make it blue", label: "Cart.tsx:12", page: "Cart – https://app.example/cart", imageNumber: 2 },
        { comment: "Too tight.\n\nAdd space.", label: "JeStationPage", page: "Cart – https://app.example/cart" },
        { comment: "Hide it", label: "[data-x=`a`]", page: "Cart – https://app.example/cart" },
      ],
      text: "Fix the cart\n\n- first\n- second",
    });
    expect(parseAnnotatedPrompt(promptWithAnnotations([annotation({ outerHtml: "<pre>```js```</pre>" })], ""))?.text).toBe("");
  });

  it("is undefined for any other prompt", () => {
    expect(parseAnnotatedPrompt("Fix the cart")).toBeUndefined();
    expect(parseAnnotatedPrompt(promptWithAnnotations([annotation()], "").split("### Annotation")[0])).toBeUndefined();
  });

  it("summarises a prompt by the user's text, else the first comment", () => {
    expect(promptSummary(promptWithAnnotations([annotation()], "Fix the cart"))).toBe("Fix the cart");
    expect(promptSummary(promptWithAnnotations([annotation()], ""))).toBe("Make it blue");
    expect(promptSummary("Plain")).toBe("Plain");
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
    expect(annotationElementLabel(annotation({ source: undefined, component: { name: "CartPage", tag: "app-cart" } }))).toBe("CartPage");
  });

  it("tells the comment, the element and the page in the tooltip", () => {
    expect(annotationTooltip(annotation())).toBe("Make it blue\nmain > button.buy\nsrc/cart/Cart.tsx:12:5\nCart – https://app.example/cart");
    expect(annotationTooltip(annotation({ title: "", source: undefined }))).toBe("Make it blue\nmain > button.buy\nhttps://app.example/cart");
  });
});
