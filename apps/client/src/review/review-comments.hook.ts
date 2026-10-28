import { useEffect, useMemo } from "react";
import type { PullRequestRef } from "../sessions/session.types";
import type { ReviewComment, ReviewThread } from "./review.types";
import { useReviewThreadStore } from "./review-threads.store";
import { useHuntStore } from "../sessions/hunt.store";
import { reviewCommentCounts, reviewCommentsFor, reviewSessionOf } from "./review-comments.utils";

/** Review drafts of `sessionId` on `path` (see `reviewCommentsFor`); none without a path. */
export function useReviewComments(sessionId: string, path: string | null): ReviewComment[] {
  const sessions = useHuntStore((state) => state.sessions);
  return useMemo(() => (path ? reviewCommentsFor(sessions, sessionId, path) : []), [sessions, sessionId, path]);
}

/**
 * GitHub's review threads on `path` of the pull request `sessionId` reviews, in GitHub's order, the error of the
 * last load and whether a load has ended; showing them loads them again once the last load is stale (see
 * `useReviewThreadStore`).
 */
export function useReviewThreads(sessionId: string, path: string): { threads: ReviewThread[]; error: string | null; isLoaded: boolean } {
  const reviewSessionId = useHuntStore((state) => reviewSessionOf(state.sessions, sessionId)?.id ?? null);
  const load = useReviewThreadStore((state) => (reviewSessionId ? state.loads[reviewSessionId] : undefined));
  const refresh = useReviewThreadStore((state) => state.refresh);
  useEffect(() => {
    if (!reviewSessionId) return;
    refresh(reviewSessionId);
  }, [refresh, reviewSessionId, path]);
  const threads = useMemo(() => load?.threads.filter((thread) => thread.path === path) ?? [], [load, path]);
  return { threads, error: load?.error ?? null, isLoaded: Boolean(load) };
}

/**
 * Review comments per path of `sessionId` (see `reviewCommentCounts`), none without a session; for a session that
 * reviews a pull request, showing them loads GitHub's review threads again once the last load is stale (see
 * `useReviewThreadStore`). A session still being created is not stored yet, so its threads load once it is.
 */
export function useReviewCommentCounts(sessionId: string | null): Map<string, number> {
  const reviewSession = useHuntStore((state) => (sessionId ? reviewSessionOf(state.sessions, sessionId) : null));
  const isCreating = useHuntStore((state) => Boolean(reviewSession && state.creatingIds.includes(reviewSession.id)));
  const threadSessionId = reviewSession?.pullRequest && !isCreating ? reviewSession.id : null;
  const load = useReviewThreadStore((state) => (threadSessionId ? state.loads[threadSessionId] : undefined));
  const refresh = useReviewThreadStore((state) => state.refresh);
  useEffect(() => {
    if (!threadSessionId) return;
    refresh(threadSessionId);
  }, [refresh, threadSessionId]);
  return useMemo(() => reviewCommentCounts(reviewSession?.reviewComments ?? [], load?.threads ?? []), [reviewSession, load]);
}

/** How many review comments `sessionId` has across all files (see `useReviewCommentCounts`); 0 without a session. */
export function useReviewCommentTotal(sessionId: string | null): number {
  const counts = useReviewCommentCounts(sessionId);
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

/** How many review drafts `sessionId` has across all files. */
export function useReviewDraftCount(sessionId: string): number {
  return useHuntStore((state) => reviewSessionOf(state.sessions, sessionId)?.reviewComments.length ?? 0);
}

/** The pull request `sessionId` reviews (its own or its parent's), or null for a session without one. */
export function useReviewedPullRequest(sessionId: string): PullRequestRef | null {
  return useHuntStore((state) => reviewSessionOf(state.sessions, sessionId)?.pullRequest ?? null);
}
