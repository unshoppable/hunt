import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import type { ReviewVerdict } from "./review-verdict.value-object.ts";

const ZodPullRequestState = z.object({
  number: z.int().check(z.positive()),
  url: z.string(),
  title: z.string(),
  headSha: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  /**
   * GitHub's `mergeStateStatus`: CLEAN, HAS_HOOKS, UNSTABLE (mergeable), BEHIND (needs the base), BLOCKED (a required
   * check or review is missing), DIRTY (conflicts), DRAFT, UNKNOWN.
   */
  mergeState: z.string(),
  /** The combined state of the head commit's checks: success, failure, pending, or none without checks. */
  checks: z.enum(["success", "failure", "pending", "none"]),
  /** The names of the failing checks. */
  failingChecks: z.array(z.string()),
  labels: z.array(z.string()),
});

export type ReviewOutcome =
  | { kind: "wait"; reason: string }
  | { kind: "fix"; findings: string[] }
  | { kind: "clean" }
  | { kind: "merged" }
  | { kind: "closed" };

export type MergeOutcome =
  | { kind: "merge" }
  | { kind: "update" }
  | { kind: "wait"; reason: string }
  | { kind: "fix"; findings: string[] }
  | { kind: "merged" }
  | { kind: "closed" };

export interface PullRequestState extends z.infer<typeof ZodPullRequestState> {}

/** The state of a session's pull request as the poller reads it at every poll of a poller step. */
export class PullRequestState extends ValueObject<typeof ZodPullRequestState> {
  static readonly schema = ZodPullRequestState;

  constructor(value: z.input<typeof ZodPullRequestState>) {
    super(value);
  }

  get isMerged(): boolean {
    return this.state === "merged";
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  /** The first seven characters of the head SHA, as GitHub shows commits. */
  get shortSha(): string {
    return this.headSha.slice(0, 7);
  }

  /**
   * What the review step does with the pull request: a failing check or a verdict with blocking findings for the
   * current head sends the agent back; a successful (or absent) check run and a verdict without blocking findings for
   * the current head end the review; anything else waits.
   */
  reviewOutcome(verdict: ReviewVerdict | null): ReviewOutcome {
    if (this.isMerged) return { kind: "merged" };
    if (this.isClosed) return { kind: "closed" };
    if (this.checks === "failure") {
      const names = this.failingChecks.length > 0 ? this.failingChecks.join(", ") : "a check";
      return { kind: "fix", findings: [`Checks: ${names} failed on ${this.shortSha} (${this.url}/checks)`] };
    }
    const current = verdict?.isFor(this.headSha) ? verdict : null;
    if (current?.hasBlockingFindings) {
      return { kind: "fix", findings: [`Claude review of ${this.shortSha} with ${current.blocking} blocking finding(s):\n\n${current.text}`] };
    }
    if (this.checks === "pending") return { kind: "wait", reason: "the checks of the head commit are still running" };
    if (!current) return { kind: "wait", reason: `no Claude review verdict for ${this.shortSha} yet` };
    return { kind: "clean" };
  }

  /**
   * What the merge step does with the pull request, from GitHub's merge state; `requestedSha` is the head the poller
   * already asked GitHub to merge or update, null without such a request.
   */
  mergeOutcome(requestedSha: string | null): MergeOutcome {
    if (this.isMerged) return { kind: "merged" };
    if (this.isClosed) return { kind: "closed" };
    const isRequested = requestedSha === this.headSha;
    switch (this.mergeState) {
      case "CLEAN":
      case "HAS_HOOKS":
      case "UNSTABLE":
        return isRequested ? { kind: "wait", reason: "the merge was requested" } : { kind: "merge" };
      case "BEHIND":
        return isRequested ? { kind: "wait", reason: "the branch is being updated" } : { kind: "update" };
      case "DIRTY":
        return {
          kind: "fix",
          findings: [`Merge: the branch conflicts with the base branch; merge the base branch into ${this.shortSha}'s branch, resolve the conflicts and push`],
        };
      case "BLOCKED":
        return { kind: "wait", reason: `GitHub reports the pull request as blocked (a required check or review is missing)` };
      default:
        return { kind: "wait", reason: `GitHub reports the merge state ${this.mergeState}` };
    }
  }
}
