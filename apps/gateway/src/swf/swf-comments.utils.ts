/**
 * The texts the poller (`swf/poller.service.ts`) writes on GitHub, free of I/O: its comments on the issue when the
 * session could not start or the pull request was merged, closed or missing, the comment that asks the people to review
 * the pull request, and the finding a person's change request becomes in the pipeline record. The comment on an agent
 * that stopped, which the runner on the VM writes too, is `libs/domain/src/swf/swf-comments.utils.ts`.
 */
import type { PullRequestReview } from "../../../../libs/domain/src/swf/pipeline.domain.ts";

/** The comment that reports why the session could not start; `error` has been redacted. */
export function failureComment(error: string, vm: string | null): string {
  const kept = vm ? `\n\nThe VM \`${vm}\` stays for inspection.` : "";
  return `Hunt could not start a session for this issue:\n\n\`\`\`\n${error.replace(/`{3,}/g, "``")}\n\`\`\`${kept}`;
}

/** The comment that reports the session's VM, which was gone, replaced by `vm`, where the step `step` starts over. */
export function replacedVmComment(step: string, vm: string): string {
  return `Hunt found no VM for this issue any more and replaced it with \`${vm}\`; the step \`${step}\` starts over there with what the steps before it left on the issue.`;
}

/** Why the session could not start when the step settings the VM reported are unusable (`stepSettings`), `problem` says how; `failureComment` quotes it. */
export function stepSettingsError(problem: string): string {
  return (
    `Hunt cannot start: ${problem}. hunt.json's \`swf.steps.<step>.skill\` (or \`swf.skills.<step>\`) names the skill of every agent step; ` +
    "Hunt's desktop asks to add the missing ones when a session of the repository opens."
  );
}

/** The comment that asks the people to review the pull request, which waits for an approval before Hunt merges it. */
export function reviewRequestComment(mentions: string[], issue: number): string {
  const who = mentions.map((login) => `@${login}`).join(" ");
  return (
    `**👀 REVIEW** ${who}\n\nThis pull request for #${issue} waits for an approval before Hunt merges it. ` +
    "Approve it to let Hunt merge it, or request changes and Hunt's agent will work them in."
  );
}

/** The comment on the issue once the pull request is merged. */
export function mergedComment(pullRequest: number): string {
  return `Hunt merged pull request #${pullRequest}.`;
}

/** The comment that marks an issue as failed because its pipeline reached the review of the pull request without a pull request number. */
export function noPullRequestComment(): string {
  return "Hunt reached the review of the pull request without a pull request number, so this issue is marked as failed.";
}

/** The comment that marks an issue as failed because its pull request does not exist (any more). */
export function missingPullRequestComment(pullRequest: number): string {
  return `Pull request #${pullRequest} does not exist (any more), so this issue is marked as failed.`;
}

/** The comment on the issue when the pull request was closed without a merge. */
export function closedComment(pullRequest: number): string {
  return `Pull request #${pullRequest} was closed without being merged, so this issue is marked as failed.`;
}

/**
 * The finding a change request of a person on the pull request becomes: who asked on which pull request, the review's
 * body and its inline comments `inline`, one per line; empty parts are left out.
 */
export function changeRequestFinding(pullRequest: number, review: PullRequestReview, inline: string[]): string {
  return [`@${review.author} requested changes on #${pullRequest}:`, review.body.trim(), ...inline].filter(Boolean).join("\n");
}
