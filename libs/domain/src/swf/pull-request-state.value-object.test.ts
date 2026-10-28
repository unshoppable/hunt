import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { PullRequestState } from "./pull-request-state.value-object.ts";
import { ReviewVerdict } from "./review-verdict.value-object.ts";

const HEAD = "a".repeat(40);

function pullRequest(overrides: Partial<z.input<typeof PullRequestState.schema>> = {}): PullRequestState {
  return new PullRequestState({
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: thing",
    headSha: HEAD,
    state: "open",
    mergeState: "CLEAN",
    checks: "success",
    failingChecks: [],
    labels: [],
    ...overrides,
  });
}

function verdict(overrides: Partial<z.input<typeof ReviewVerdict.schema>> = {}): ReviewVerdict {
  return new ReviewVerdict({ headSha: HEAD, blocking: 0, findings: 0, body: "", ...overrides });
}

describe("PullRequestState", () => {
  it("rejects a pull request without a positive number or with an unknown state", () => {
    expect(() => pullRequest({ number: 0 })).toThrow();
    expect(() => pullRequest({ state: "draft" as "open" })).toThrow();
    expect(pullRequest().shortSha).toBe("aaaaaaa");
  });

  describe("reviewOutcome", () => {
    it("waits for pending checks and for the verdict of the current head", () => {
      expect(pullRequest({ checks: "pending" }).reviewOutcome(verdict())).toMatchObject({ kind: "wait" });
      expect(pullRequest().reviewOutcome(null)).toMatchObject({ kind: "wait" });
      expect(pullRequest().reviewOutcome(verdict({ headSha: "b".repeat(40) }))).toMatchObject({ kind: "wait" });
    });

    it("sends failing checks and blocking findings back, and ends the review when both are clean", () => {
      expect(pullRequest({ checks: "failure", failingChecks: ["build", "test-med"] }).reviewOutcome(verdict())).toEqual({
        kind: "fix",
        findings: [`Checks: build, test-med failed on ${HEAD.slice(0, 7)} (https://github.com/acme/app/pull/42/checks)`],
      });
      const blocking = pullRequest().reviewOutcome(verdict({ blocking: 2, body: "<!-- claude-pr-review -->\nFix A and B\n<!-- claude-pr-review:verdict {} -->" }));
      expect(blocking.kind).toBe("fix");
      expect((blocking as { findings: string[] }).findings[0]).toContain("2 blocking finding(s):\n\nFix A and B");
      expect(pullRequest().reviewOutcome(verdict())).toEqual({ kind: "clean" });
      expect(pullRequest({ checks: "none" }).reviewOutcome(verdict())).toEqual({ kind: "clean" });
      expect(pullRequest({ state: "merged" }).reviewOutcome(null)).toEqual({ kind: "merged" });
      expect(pullRequest({ state: "closed" }).reviewOutcome(null)).toEqual({ kind: "closed" });
    });
  });

  describe("mergeOutcome", () => {
    it("merges a clean pull request once per head, updates one behind once per head, fixes conflicts and waits otherwise", () => {
      expect(pullRequest().mergeOutcome(null)).toEqual({ kind: "merge" });
      expect(pullRequest({ mergeState: "UNSTABLE" }).mergeOutcome(null)).toEqual({ kind: "merge" });
      expect(pullRequest().mergeOutcome(HEAD)).toMatchObject({ kind: "wait" });
      expect(pullRequest({ mergeState: "BEHIND" }).mergeOutcome(null)).toEqual({ kind: "update" });
      expect(pullRequest({ mergeState: "BEHIND" }).mergeOutcome(HEAD)).toMatchObject({ kind: "wait" });
      expect(pullRequest({ mergeState: "DIRTY" }).mergeOutcome(null).kind).toBe("fix");
      expect(pullRequest({ mergeState: "BLOCKED" }).mergeOutcome(null)).toMatchObject({ kind: "wait" });
      expect(pullRequest({ state: "merged" }).mergeOutcome(null)).toEqual({ kind: "merged" });
    });
  });
});
