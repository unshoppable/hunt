import { describe, expect, it } from "vitest";
import { browserButtonTitle, isSamePages } from "./app-pages.utils";

const UI = { name: "med-ui", url: "http://localhost:4300" };
const ADMIN = { name: "med-admin-ui", url: "http://localhost:4200" };

describe("browserButtonTitle", () => {
  it("names the apps it opens", () => {
    expect(browserButtonTitle([ADMIN, UI])).toBe("Open med-admin-ui, med-ui in this session's Chrome, which its agent drives, a tab each");
  });

  it("says what enables it while no app shows a page", () => {
    expect(browserButtonTitle([])).toContain("start one in the Terminal tab");
  });
});

describe("isSamePages", () => {
  it("compares names and URLs in order", () => {
    expect(isSamePages([ADMIN, UI], [{ ...ADMIN }, { ...UI }])).toBe(true);
    expect(isSamePages([ADMIN, UI], [UI, ADMIN])).toBe(false);
    expect(isSamePages([ADMIN], [ADMIN, UI])).toBe(false);
    expect(isSamePages([], [])).toBe(true);
  });
});
