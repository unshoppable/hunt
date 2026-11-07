/**
 * The comments on the issue that the gateway's poller (`apps/gateway/src/swf/poller.service.ts`, for the records it
 * drives) and the runner on the session VM (`apps/session/src/swf-runner/swf-runner.service.ts`) both write, free of
 * I/O; the poller's own are `apps/gateway/src/swf/swf-comments.utils.ts`.
 */

/**
 * The comment that marks an issue as failed because its agent ended a step's turn twice without reporting the step;
 * `failed` is the workflow's failed label, whose removal resumes the step.
 */
export function stoppedComment(step: string, vm: string, failed: string): string {
  return (
    `Hunt's agent ended its turn twice without reporting the step \`${step}\`, asking a question or giving up, so this issue is marked as failed. ` +
    `The VM \`${vm}\` keeps the session: open it in Hunt to see what happened. ` +
    `To resume the step in the same conversation, remove the label \`${failed}\`.`
  );
}
