import type { PullRequestDetails } from "../review/review.types";
import type { ThreadLoad } from "../review/review-threads.store";

/** The review states that decide a pull request, as GitHub counts each reviewer's latest one; comments do not. */
const VERDICT_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * The Pull request tab as `hunt-client pull-request` prints it: the reviewed pull request, each reviewer's latest
 * verdict, the counts of its conversation comments and reviews, the review drafts not yet submitted and its review
 * threads on GitHub (null while none were loaded; `error` when the last load failed).
 */
export type PullRequestState = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  base: string;
  head: string;
  url: string;
  verdicts: { author: string; state: string }[];
  commentCount: number;
  reviewCount: number;
  draftCount: number;
  threads: { resolved: number; unresolved: number; error: string | null } | null;
};

/** The state of the Pull request tab for `details` with `draftCount` drafts and the review threads of `threadLoad`. */
export function pullRequestState(details: PullRequestDetails, draftCount: number, threadLoad: ThreadLoad | undefined): PullRequestState {
  const verdicts = new Map<string, string>();
  for (const review of details.reviews) {
    if (VERDICT_STATES.has(review.state)) {
      verdicts.set(review.author, review.state);
    }
  }
  const resolved = threadLoad?.threads.filter((thread) => thread.isResolved).length ?? 0;
  return {
    number: details.number,
    title: details.title,
    state: details.state,
    isDraft: details.isDraft,
    author: details.author,
    base: details.baseRefName,
    head: details.headRefName,
    url: details.url,
    verdicts: [...verdicts].map(([author, state]) => ({ author, state })),
    commentCount: details.comments.length,
    reviewCount: details.reviews.length,
    draftCount,
    threads: threadLoad ? { resolved, unresolved: threadLoad.threads.length - resolved, error: threadLoad.error } : null,
  };
}
