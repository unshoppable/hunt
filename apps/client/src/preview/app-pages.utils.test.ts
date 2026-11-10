import { describe, expect, it } from "vitest";
import type { PreviewService } from "./preview.types";
import { browserButtonTitle, isSamePages, remoteAppPages } from "./app-pages.utils";

const UI = { name: "med-ui", url: "http://localhost:4300" };
const ADMIN = { name: "med-admin-ui", url: "http://localhost:4200" };

describe("browserButtonTitle", () => {
  it("names the apps it opens", () => {
    expect(browserButtonTitle([ADMIN, UI], false)).toBe("Open med-admin-ui, med-ui in this session's Chrome, which its agent drives, a tab each");
  });

  it("says what enables it while no app shows a page", () => {
    expect(browserButtonTitle([], false)).toContain("runs on this Mac; start one in the Terminal tab");
    expect(browserButtonTitle([], true)).toContain("answers on the VM; start one in the Terminal tab");
  });

  it("tells the Chrome of a session on a VM from its agent's Chromium", () => {
    expect(browserButtonTitle([UI], true)).toBe(
      "Open the preview of med-ui in this session's Chrome on this Mac, with the review widget, a tab each; the agent's Chromium is in the Desktop tab",
    );
  });
});

describe("remoteAppPages", () => {
  function service(name: string, patch: Partial<PreviewService>): PreviewService {
    const url = `https://0123abcd-${name}.p.example.com`;
    return { name, port: 3000, url, guarded: true, tls: false, enabled: true, state: "running", responds: true, invocation: "1", uses: [], frontend: false, ...patch };
  }

  it("lists the frontend services that answer, at their preview URLs", () => {
    const services = [service("api", {}), service("ui", { frontend: true }), service("admin", { frontend: true, responds: false })];
    expect(remoteAppPages({ vmRunning: true, services })).toEqual([{ name: "ui", url: "https://0123abcd-ui.p.example.com" }]);
  });

  it("has none without a status or a frontend, and then keeps one list", () => {
    expect(remoteAppPages(null)).toEqual([]);
    expect(remoteAppPages({ vmRunning: true, services: [service("api", {})] })).toBe(remoteAppPages(null));
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
