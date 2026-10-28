import { describe, expect, it } from "vitest";
import { injectWidget, wantsWidget, WIDGET_TAG } from "./widget-injection.utils.ts";

const HTML = { "content-type": "text/html; charset=utf-8" };

describe("wantsWidget", () => {
  it("takes the uncompressed HTML answers of a GET that are not opted out", () => {
    expect(wantsWidget({ method: "GET", statusCode: 200, headers: HTML })).toBe(true);
    expect(wantsWidget({ method: "GET", statusCode: 404, headers: { "content-type": "TEXT/HTML" } })).toBe(true);
    expect(wantsWidget({ method: "GET", statusCode: 200, headers: { ...HTML, "content-encoding": "identity" } })).toBe(true);
  });

  it("leaves out other methods, redirects, empty answers, other types, compressed bodies and opted-out pages", () => {
    const cases: Parameters<typeof wantsWidget>[0][] = [
      { method: "HEAD", statusCode: 200, headers: HTML },
      { method: "POST", statusCode: 200, headers: HTML },
      { method: "GET", statusCode: 101, headers: HTML },
      { method: "GET", statusCode: 204, headers: HTML },
      { method: "GET", statusCode: 302, headers: HTML },
      { method: "GET", statusCode: 304, headers: HTML },
      { method: "GET", statusCode: 200, headers: { "content-type": "application/json" } },
      { method: "GET", statusCode: 200, headers: { "content-type": "text/html-sandboxed" } },
      { method: "GET", statusCode: 200, headers: {} },
      { method: "GET", statusCode: 200, headers: { ...HTML, "content-encoding": "gzip" } },
      { method: "GET", statusCode: 200, headers: { ...HTML, "x-hunt-review-widget": " Off " } },
    ];
    for (const head of cases) {
      expect(wantsWidget(head), JSON.stringify(head)).toBe(false);
    }
  });
});

describe("injectWidget", () => {
  const inject = (html: string) => injectWidget(Buffer.from(html, "utf8")).toString("utf8");

  it("puts the tag before </head>, else after <body>, else at the end, and keeps every other byte", () => {
    expect(inject("<html><head><title>Ä</title></HEAD ><body>ü</body></html>")).toBe(`<html><head><title>Ä</title>${WIDGET_TAG}</HEAD ><body>ü</body></html>`);
    expect(inject('<body class="x">€</body>')).toBe(`<body class="x">${WIDGET_TAG}€</body>`);
    expect(inject("<p>ok</p>")).toBe(`<p>ok</p>${WIDGET_TAG}`);
    expect(inject("<bodyguard></bodyguard>")).toBe(`<bodyguard></bodyguard>${WIDGET_TAG}`);
  });

  it("adds the tag only once", () => {
    const page = `<head>${WIDGET_TAG}</head>`;
    expect(inject(page)).toBe(page);
  });
});
