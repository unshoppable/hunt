import { describe, expect, it } from "vitest";
import { hasInspectorTab } from "./inspector.utils";

describe("hasInspectorTab", () => {
  const localSession = { isOnVm: false, isReviewingPullRequest: false };

  it("gives every session the tabs that need neither a VM nor a pull request", () => {
    for (const tab of ["diff", "git", "editor", "graph", "checks", "terminal"] as const) {
      expect(hasInspectorTab(tab, localSession)).toBe(true);
    }
  });

  it("gives Preview and Desktop only to a session on a VM", () => {
    expect(hasInspectorTab("preview", localSession)).toBe(false);
    expect(hasInspectorTab("desktop", localSession)).toBe(false);
    expect(hasInspectorTab("preview", { ...localSession, isOnVm: true })).toBe(true);
    expect(hasInspectorTab("desktop", { ...localSession, isOnVm: true })).toBe(true);
  });

  it("gives PR Description only to a pull request review", () => {
    expect(hasInspectorTab("pullRequest", { ...localSession, isOnVm: true })).toBe(false);
    expect(hasInspectorTab("pullRequest", { ...localSession, isReviewingPullRequest: true })).toBe(true);
  });
});
