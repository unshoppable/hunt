import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";

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
  /**
   * GitHub's `reviewDecision`: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when the base branch requires no
   * review. The repository's review workflow (app-framework's scorer action, for one) approves as its own GitHub App when
   * no person has to review.
   */
  reviewDecision: z.nullable(z.string()),
  /** The combined state of the head commit's checks: success, failure, pending, or none without checks. */
  checks: z.enum(["success", "failure", "pending", "none"]),
  labels: z.array(z.string()),
});

export type MergeOutcome =
  | { kind: "merge" }
  | { kind: "update" }
  | { kind: "wait"; reason: string }
  | { kind: "fix"; findings: string[] }
  | { kind: "review"; reason: string }
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

  /** Whether the pull request has the approval the ruleset requires, by the repository's review workflow or a person. */
  get isApproved(): boolean {
    return this.reviewDecision === "APPROVED";
  }

  /** The first seven characters of the head SHA, as GitHub shows commits. */
  get shortSha(): string {
    return this.headSha.slice(0, 7);
  }

  /**
   * What the merge step does with the pull request, from GitHub's state; `requestedSha` is the head the poller already
   * asked GitHub to merge or update, null without such a request. A mergeable pull request is merged once its checks
   * ran, one behind its base updated (its new head runs its checks and gets reviewed again), one with conflicts goes back
   * to the agent; one GitHub reports as blocked goes back to pr-gate once its checks are done (its approval was
   * withdrawn, or a required check failed) and waits while they run.
   */
  mergeOutcome(requestedSha: string | null): MergeOutcome {
    if (this.isMerged) return { kind: "merged" };
    if (this.isClosed) return { kind: "closed" };
    const isRequested = requestedSha === this.headSha;
    switch (this.mergeState) {
      case "CLEAN":
      case "HAS_HOOKS":
      case "UNSTABLE":
        if (this.checks === "pending") return { kind: "wait", reason: "the checks of the head commit are still running" };
        return isRequested ? { kind: "wait", reason: "the merge was requested" } : { kind: "merge" };
      case "BEHIND":
        return isRequested ? { kind: "wait", reason: "the branch is being updated" } : { kind: "update" };
      case "DIRTY":
        return {
          kind: "fix",
          findings: [`Merge: the branch conflicts with the base branch; merge the base branch into ${this.shortSha}'s branch, resolve the conflicts and push`],
        };
      case "BLOCKED":
        if (this.checks === "pending" || this.checks === "none") return { kind: "wait", reason: "GitHub reports the pull request as blocked while its checks run" };
        return { kind: "review", reason: this.isApproved ? "a required check failed or another rule is unmet" : "it has no approval" };
      default:
        return { kind: "wait", reason: `GitHub reports the merge state ${this.mergeState}` };
    }
  }
}
