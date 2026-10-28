import { describe, expect, it } from "vitest";
import { attributeSource, cssSelector, pathOfUrl, pickStyles, reactSource, shorten, shortenHtml, type ElementStep } from "./element-info.utils.ts";

function step(tagName: string, fields: Partial<ElementStep> = {}): ElementStep {
  return { tagName, id: "", classNames: [], indexOfType: 1, countOfType: 1, ...fields };
}

describe("cssSelector", () => {
  it("takes a unique id of the element itself", () => {
    expect(cssSelector([step("button", { id: "save" }), step("main"), step("body"), step("html")], () => true)).toBe("#save");
  });

  it("goes up until the selector is unique, with stable classes and nth-of-type where siblings share the tag", () => {
    const chain = [
      step("button", { classNames: ["btn", "btn-primary", "large", "hover"], indexOfType: 2, countOfType: 3 }),
      step("div", { classNames: ["css-1q2w3e4", "toolbar"] }),
      step("main", { id: "content" }),
      step("body"),
      step("html"),
    ];
    const unique = new Set(["#content > div.toolbar > button.btn.btn-primary:nth-of-type(2)"]);

    expect(cssSelector(chain, (selector) => unique.has(selector) || selector === "#content")).toBe("#content > div.toolbar > button.btn.btn-primary:nth-of-type(2)");
    expect(cssSelector(chain, (selector) => selector === "div.toolbar > button.btn.btn-primary:nth-of-type(2)")).toBe(
      "div.toolbar > button.btn.btn-primary:nth-of-type(2)",
    );
  });

  it("skips ids and classes that need escaping or change per build, and ends at the root without a unique match", () => {
    const chain = [step("span", { id: "1st", classNames: ["sc-a1b2c3", "a:b", "_x", "jsx-123"] }), step("body"), step("html")];
    expect(cssSelector(chain, () => false)).toBe("html > body > span");
  });
});

describe("shorten", () => {
  it("collapses whitespace and marks a cut", () => {
    expect(shorten("  Save \n\t changes ", 20)).toBe("Save changes");
    expect(shorten("abcdefghij", 5)).toBe("abcd…");
    expect(shortenHtml("<b>\n  x</b>", 100)).toBe("<b>\n  x</b>");
    expect(shortenHtml("<div>abcdef</div>", 6)).toBe("<div>…");
  });
});

describe("pickStyles", () => {
  it("keeps the styles that say more than the default, in their order", () => {
    const computed: Record<string, string> = { display: "flex", position: "static", color: "rgb(255, 0, 0)", margin: "0px", opacity: "1", "font-size": "14px" };
    expect(pickStyles((property) => computed[property] ?? "")).toEqual({ display: "flex", color: "rgb(255, 0, 0)", "font-size": "14px" });
  });
});

describe("reactSource", () => {
  it("reads the _debugSource of the element's fiber or an ancestor's", () => {
    const parent = { _debugSource: { fileName: "/app/src/Orders.tsx", lineNumber: 12, columnNumber: 7 } };
    const element = { "__reactFiber$abc": { return: { return: parent } }, className: "x" };
    expect(reactSource(element)).toEqual({ file: "/app/src/Orders.tsx", line: 12, column: 7 });
  });

  it("reads the first application frame of React 19's _debugStack", () => {
    const debugStack = new Error("react-stack-top-frame");
    debugStack.stack = [
      "Error: react-stack-top-frame",
      "    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)",
      "    at Orders (http://localhost:5173/src/orders/Orders.tsx?t=17:31:9)",
      "    at App (http://localhost:5173/src/App.tsx:8:3)",
    ].join("\n");
    expect(reactSource({ "__reactFiber$x": { _debugStack: debugStack } })).toEqual({ file: "src/orders/Orders.tsx", line: 31, column: 9 });
    expect(reactSource({ "__reactFiber$x": { _debugOwner: { _debugStack: { stack: "Orders@http://localhost:5173/src/Orders.tsx:4:2" } } } })).toEqual({
      file: "src/Orders.tsx",
      line: 4,
      column: 2,
    });
  });

  it("finds nothing without React's debug info", () => {
    expect(reactSource({})).toBeUndefined();
    expect(reactSource({ "__reactFiber$x": { return: null } })).toBeUndefined();
  });
});

describe("pathOfUrl", () => {
  it("strips origin and query and keeps Vite's file system paths absolute", () => {
    expect(pathOfUrl("http://localhost:5173/src/App.tsx?t=1#x")).toBe("src/App.tsx");
    expect(pathOfUrl("http://localhost:5173/@fs/home/agent/app/libs/ui/Button.tsx")).toBe("/home/agent/app/libs/ui/Button.tsx");
    expect(pathOfUrl("http://localhost:5173/src/%E2%9C%93.tsx")).toBe("src/✓.tsx");
  });
});

describe("attributeSource", () => {
  it("reads react-dev-inspector's attributes and data-source", () => {
    const attributes = (values: Record<string, string>) => (name: string) => values[name] ?? null;
    expect(attributeSource(attributes({ "data-inspector-relative-path": "src/A.tsx", "data-inspector-line": "3", "data-inspector-column": "5" }))).toEqual({
      file: "src/A.tsx",
      line: 3,
      column: 5,
    });
    expect(attributeSource(attributes({ "data-inspector-relative-path": "src/A.tsx", "data-inspector-line": "3" }))).toEqual({ file: "src/A.tsx", line: 3 });
    expect(attributeSource(attributes({ "data-source": "src/B.vue:10:2" }))).toEqual({ file: "src/B.vue", line: 10, column: 2 });
    expect(attributeSource(attributes({ "data-source-location": "src/C.tsx:7" }))).toEqual({ file: "src/C.tsx", line: 7 });
    expect(attributeSource(attributes({ "data-source": "nothing" }))).toBeUndefined();
  });
});
