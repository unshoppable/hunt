import { describe, expect, it } from "vitest";
import { hasInspectorTab } from "./inspector.utils";

describe("hasInspectorTab", () => {
  const localSession = { isOnVm: false, isReviewingPullRequest: false, isFactory: false };

  it("gives every session the tabs that need neither a VM, a pull request nor the swf pipeline", () => {
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

  it("gives Factory only to a session of the swf poller, on a VM or brought back", () => {
    expect(hasInspectorTab("factory", localSession)).toBe(false);
    expect(hasInspectorTab("factory", { ...localSession, isOnVm: true })).toBe(false);
    expect(hasInspectorTab("factory", { ...localSession, isFactory: true })).toBe(true);
    expect(hasInspectorTab("factory", { ...localSession, isOnVm: true, isFactory: true })).toBe(true);
  });
});
