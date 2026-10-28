/**
 * The texts the poller (`swf/poller.service.ts`) writes on GitHub, free of I/O: its comments on the issue when the
 * session could not start, the agent stopped or the pull request was merged, closed or missing, the comment that asks the
 * people to review the pull request, and the finding a person's change request becomes in the pipeline record.
 */
import type { AgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { PullRequestReview } from "./pipeline.domain.ts";

/** The comment that reports why the session could not start; `error` has been redacted. */
export function failureComment(error: string, vm: string | null): string {
  const kept = vm ? `\n\nThe VM \`${vm}\` stays for inspection.` : "";
  return `Hunt could not start a session for this issue:\n\n\`\`\`\n${error.replace(/`{3,}/g, "``")}\n\`\`\`${kept}`;
}

/** Why the session could not start when the repository's hunt.json names no skill for the agent steps `steps`; `failureComment` quotes it. */
export function missingSkillsError(steps: readonly AgentStep[]): string {
  const what = steps.length === 1 ? `the step ${steps[0]}` : `the steps ${steps.join(", ")}`;
  return `hunt.json names no skill for ${what} under swf.skills; Hunt has no default skill and asks to add the entries when a session of the repository opens`;
}

/** The comment that asks the people to review the pull request. */
export function humanReviewComment(mentions: string[], issue: number, reasons: string[] = []): string {
  const who = mentions.map((login) => `@${login}`).join(" ");
  const why = reasons.length > 0 ? `\n\nWhy a person has to look at it:\n${reasons.map((reason) => `- ${reason}`).join("\n")}` : "";
  return (
    `**👀 REVIEW** ${who}\n\nHunt's gate asks for a human review of this pull request for #${issue} before it is merged. ` +
    `Approve it to let Hunt merge it, or request changes and Hunt's agent will work them in.${why}`
  );
}

/** The comment on the issue once the pull request is merged. */
export function mergedComment(pullRequest: number): string {
  return `Hunt merged pull request #${pullRequest}.`;
}

/** The comment that marks an issue as failed because its pipeline reached the review without a pull request number. */
export function noPullRequestComment(): string {
  return "Hunt reached the review without a pull request number, so this issue is marked as failed.";
}

/** The comment that marks an issue as failed because its pull request does not exist (any more). */
export function missingPullRequestComment(pullRequest: number): string {
  return `Pull request #${pullRequest} does not exist (any more), so this issue is marked as failed.`;
}

/** The comment on the issue when the pull request was closed without a merge. */
export function closedComment(pullRequest: number): string {
  return `Pull request #${pullRequest} was closed without being merged, so this issue is marked as failed.`;
}

/** The comment that marks an issue as failed because its agent ended a step's turn twice without reporting the step. */
export function stoppedComment(step: string, vm: string): string {
  return (
    `Hunt's agent ended its turn twice without reporting the step \`${step}\`, asking a question or giving up, so this issue is marked as failed. ` +
    `The VM \`${vm}\` keeps the session: open it in Hunt to see what happened and to continue.`
  );
}

/**
 * The finding a change request of a person on the pull request becomes: who asked on which pull request, the review's
 * body and its inline comments `inline`, one per line; empty parts are left out.
 */
export function changeRequestFinding(pullRequest: number, review: PullRequestReview, inline: string[]): string {
  return [`@${review.author} requested changes on #${pullRequest}:`, review.body.trim(), ...inline].filter(Boolean).join("\n");
}
