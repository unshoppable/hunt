import type { PullRequestComment, PullRequestDetails, PullRequestReview } from "./review.types";

/** One entry of the conversation under a pull request description: a comment or a submitted review. */
export type TimelineEntry =
  | { kind: "comment"; at: string; comment: PullRequestComment }
  | { kind: "review"; at: string; review: PullRequestReview };

/** Human label of a review state as GitHub words it; unknown states are shown as they come. */
export const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "approved these changes",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "left a review that was dismissed",
  PENDING: "started a review",
};

/**
 * Comments and reviews of a pull request merged into one conversation, oldest first like on GitHub. Minimized
 * comments (spam, off-topic) are left out; a review without text still counts, as its state is the news.
 */
export function buildTimeline(details: Pick<PullRequestDetails, "comments" | "reviews">): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...details.comments.filter((comment) => !comment.isMinimized).map((comment): TimelineEntry => ({ kind: "comment", at: comment.createdAt, comment })),
    ...details.reviews.map((review): TimelineEntry => ({ kind: "review", at: review.submittedAt, review })),
  ];
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}
