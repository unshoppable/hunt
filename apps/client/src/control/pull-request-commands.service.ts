import { commands } from "../ipc/commands";
import { reviewSessionOf } from "../review/review-comments.utils";
import { useReviewThreadStore } from "../review/review-threads.store";
import { useHuntStore } from "../sessions/hunt.store";
import type { SessionView } from "../sessions/session.types";
import { errorText } from "../ui/error-text.utils";
import { pullRequestState, type PullRequestState } from "./pull-request-commands.utils";

/**
 * The state of the Pull request tab of `session`, as `hunt-client pull-request` prints it: the pull request as GitHub
 * reports it now, the review drafts and the review threads the store holds. The threads load alongside the pull request
 * unless their last load is recent; a first load that has not ended by then counts no threads.
 */
export async function readPullRequestState(session: SessionView): Promise<PullRequestState> {
  const reviewSession = reviewSessionOf(useHuntStore.getState().sessions, session.id) ?? session;
  useReviewThreadStore.getState().refresh(reviewSession.id);
  const details = await commands.viewPullRequest(session.id).catch((reason: unknown) => {
    throw new Error(`failed to load the pull request: ${errorText(reason)}`);
  });
  return pullRequestState(details, reviewSession.reviewComments.length, useReviewThreadStore.getState().loads[reviewSession.id]);
}
