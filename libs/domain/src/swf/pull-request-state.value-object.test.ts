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
    failingChecks: [],
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

  describe("checksOutcome", () => {
    it("waits while the checks run or the head has none yet", () => {
      expect(pullRequest({ checks: "pending" }).checksOutcome()).toEqual({ kind: "wait", reason: "the checks of the head commit are still running" });
      expect(pullRequest({ checks: "none" }).checksOutcome()).toEqual({ kind: "wait", reason: `the head commit ${SHORT} has no checks yet` });
      expect(pullRequest({ checks: "pending", reviewDecision: null }).checksOutcome().kind).toBe("wait");
    });

    it("sends failing checks back, whatever the review workflow decided", () => {
      expect(pullRequest({ checks: "failure", failingChecks: ["build", "test-med"] }).checksOutcome()).toEqual({
        kind: "fix",
        findings: [`Checks: build, test-med failed on ${SHORT} (https://github.com/acme/app/pull/42/checks)`],
      });
      expect(pullRequest({ checks: "failure", reviewDecision: null }).checksOutcome()).toEqual({
        kind: "fix",
        findings: [`Checks: a check failed on ${SHORT} (https://github.com/acme/app/pull/42/checks)`],
      });
    });

    it("lets the review workflow's decision decide once the checks passed: approved merges, anything else needs a person", () => {
      expect(pullRequest().checksOutcome()).toEqual({ kind: "merge" });
      expect(pullRequest({ reviewDecision: "REVIEW_REQUIRED" }).checksOutcome()).toEqual({ kind: "human" });
      expect(pullRequest({ reviewDecision: "CHANGES_REQUESTED" }).checksOutcome()).toEqual({ kind: "human" });
      expect(pullRequest({ reviewDecision: null }).checksOutcome()).toEqual({ kind: "human" });
    });

    it("reports a merged or closed pull request first", () => {
      expect(pullRequest({ state: "merged", checks: "failure" }).checksOutcome()).toEqual({ kind: "merged" });
      expect(pullRequest({ state: "closed", checks: "pending" }).checksOutcome()).toEqual({ kind: "closed" });
    });
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

    it("hands a blocked pull request whose checks passed without an approval to a person, and waits on any other block", () => {
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }).mergeOutcome(null)).toEqual({ kind: "human" });
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: null }).mergeOutcome(HEAD)).toEqual({ kind: "human" });
      const blocked = { kind: "wait", reason: "GitHub reports the pull request as blocked (a required check or review is missing)" };
      expect(pullRequest({ mergeState: "BLOCKED" }).mergeOutcome(null)).toEqual(blocked);
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", checks: "pending" }).mergeOutcome(null)).toEqual(blocked);
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", checks: "failure" }).mergeOutcome(null)).toEqual(blocked);
      expect(pullRequest({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", checks: "none" }).mergeOutcome(null)).toEqual(blocked);
    });

    it("waits on an unknown merge state and reports a merged or closed pull request first", () => {
      expect(pullRequest({ mergeState: "UNKNOWN" }).mergeOutcome(null)).toEqual({ kind: "wait", reason: "GitHub reports the merge state UNKNOWN" });
      expect(pullRequest({ state: "merged" }).mergeOutcome(null)).toEqual({ kind: "merged" });
      expect(pullRequest({ state: "closed", mergeState: "DIRTY" }).mergeOutcome(null)).toEqual({ kind: "closed" });
    });
  });
});
