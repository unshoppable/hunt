import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { PullRequestState } from "./pull-request-state.value-object.ts";

const HEAD = "a".repeat(40);
const SHORT = HEAD.slice(0, 7);

/** An open pull request with passed checks the review workflow approved, apart from `overrides`. */
function pullRequest(overrides: Partial<z.input<typeof PullRequestState.schema>> = {}): PullRequestState {
  return new PullRequestState({
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: thing",
    headSha: HEAD,
    state: "open",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checks: "success",
    labels: [],
    ...overrides,
  });
}

describe("PullRequestState", () => {
  it("rejects a pull request without a positive number or with an unknown state", () => {
    expect(() => pullRequest({ number: 0 })).toThrow();
    expect(() => pullRequest({ state: "draft" as "open" })).toThrow();
    expect(pullRequest().shortSha).toBe("aaaaaaa");
  });

  it("is approved only with GitHub's review decision APPROVED", () => {
    expect(pullRequest().isApproved).toBe(true);
    expect(pullRequest({ reviewDecision: "REVIEW_REQUIRED" }).isApproved).toBe(false);
    expect(pullRequest({ reviewDecision: "CHANGES_REQUESTED" }).isApproved).toBe(false);
    expect(pullRequest({ reviewDecision: null }).isApproved).toBe(false);
  });

  describe("mergeOutcome", () => {
    it("merges a mergeable pull request once per head and waits while the checks of a new head run", () => {
      expect(pullRequest().mergeOutcome(null)).toEqual({ kind: "merge" });
      expect(pullRequest({ mergeState: "HAS_HOOKS" }).mergeOutcome(null)).toEqual({ kind: "merge" });
      expect(pullRequest({ mergeState: "UNSTABLE" }).mergeOutcome(null)).toEqual({ kind: "merge" });
      expect(pullRequest().mergeOutcome(HEAD)).toEqual({ kind: "wait", reason: "the merge was requested" });
      for (const mergeState of ["CLEAN", "HAS_HOOKS", "UNSTABLE"]) {
        expect(pullRequest({ mergeState, checks: "pending" }).mergeOutcome(null), mergeState).toEqual({ kind: "wait", reason: "the checks of the head commit are still running" });
        expect(pullRequest({ mergeState, checks: "pending" }).mergeOutcome(HEAD), mergeState).toEqual({ kind: "wait", reason: "the checks of the head commit are still running" });
      }
      expect(pullRequest({ checks: "none" }).mergeOutcome(null)).toEqual({ kind: "merge" });
    });

    it("updates a branch behind the base once per head and fixes conflicts", () => {
      expect(pullRequest({ mergeState: "BEHIND" }).mergeOutcome(null)).toEqual({ kind: "update" });
      expect(pullRequest({ mergeState: "BEHIND" }).mergeOutcome(HEAD)).toEqual({ kind: "wait", reason: "the branch is being updated" });
      expect(pullRequest({ mergeState: "DIRTY" }).mergeOutcome(null)).toEqual({
        kind: "fix",
        findings: [`Merge: the branch conflicts with the base branch; merge the base branch into ${SHORT}'s branch, resolve the conflicts and push`],
      });
    });

    it("sends a blocked pull request whose checks are done back to its review, and waits while they run", () => {
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }).mergeOutcome(null)).toEqual({ kind: "review", reason: "it has no approval" });
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: null, checks: "failure" }).mergeOutcome(HEAD)).toEqual({ kind: "review", reason: "it has no approval" });
      const unmet = { kind: "review", reason: "a required check failed or another rule is unmet" };
      expect(pullRequest({ mergeState: "BLOCKED" }).mergeOutcome(null)).toEqual(unmet);
      expect(pullRequest({ mergeState: "BLOCKED", checks: "failure" }).mergeOutcome(null)).toEqual(unmet);
      const running = { kind: "wait", reason: "GitHub reports the pull request as blocked while its checks run" };
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", checks: "pending" }).mergeOutcome(null)).toEqual(running);
      expect(pullRequest({ mergeState: "BLOCKED", checks: "none" }).mergeOutcome(null)).toEqual(running);
    });

    it("waits on an unknown merge state and reports a merged or closed pull request first", () => {
      expect(pullRequest({ mergeState: "UNKNOWN" }).mergeOutcome(null)).toEqual({ kind: "wait", reason: "GitHub reports the merge state UNKNOWN" });
      expect(pullRequest({ state: "merged" }).mergeOutcome(null)).toEqual({ kind: "merged" });
      expect(pullRequest({ state: "closed", mergeState: "DIRTY" }).mergeOutcome(null)).toEqual({ kind: "closed" });
    });
  });
});
