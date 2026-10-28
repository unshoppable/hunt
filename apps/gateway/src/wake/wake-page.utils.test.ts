import { describe, expect, it } from "vitest";
import { isPageLoad, renderPage } from "./wake-page.utils.ts";

const NAVIGATE = { "sec-fetch-mode": "navigate", accept: "text/html" };

describe("isPageLoad", () => {
  it("counts navigations, and HTML requests of clients without fetch metadata, but no script's request", () => {
    expect(isPageLoad("GET", NAVIGATE)).toBe(true);
    expect(isPageLoad("GET", { "sec-fetch-mode": "cors", accept: "text/html" })).toBe(false);
    expect(isPageLoad("GET", { accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(isPageLoad("GET", { accept: "*/*" })).toBe(false);
    expect(isPageLoad("POST", NAVIGATE)).toBe(false);
  });
});

describe("renderPage", () => {
  it("escapes the text and reloads only when asked to", () => {
    const html = renderPage({ status: 502, title: "Preview <unavailable>", text: `"a" & 'b'`, reloads: true });
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).toContain("<title>Preview &#60;unavailable&#62;</title>");
    expect(html).toContain("<p>&#34;a&#34; &#38; &#39;b&#39;</p>");
    expect(renderPage({ status: 404, title: "No such session", text: "", reloads: false })).not.toContain("refresh");
  });
});
