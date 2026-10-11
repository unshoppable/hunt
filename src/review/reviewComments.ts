import { useMemo } from "react";
import type { ChangeBlock } from "../diff/lineDiff";
import type { PullRequestRef, ReviewComment, SessionView } from "../ipc/types";
import { useHuntStore } from "../state/store";

/** Lines of unchanged context git puts around every change; the diff of a pull request on GitHub has the same. */
export const HUNK_CONTEXT_LINES = 3;

/** A span of lines of the new file version a review comment is drafted on; a single line has `startLine === line`. */
export type LineSpan = { startLine: number; line: number };

/** The session whose record holds the review drafts of `sessionId`: a sub session drafts into its parent's list. */
export function reviewSessionOf(sessions: SessionView[], sessionId: string): SessionView | null {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  const parent = session.parentId ? sessions.find((candidate) => candidate.id === session.parentId) : null;
  return parent ?? session;
}

/** Review drafts of `sessionId` on `path`, oldest first. */
export function reviewCommentsFor(sessions: SessionView[], sessionId: string, path: string): ReviewComment[] {
  const comments = reviewSessionOf(sessions, sessionId)?.reviewComments.filter((comment) => comment.path === path) ?? [];
  return comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

/** Review drafts of `sessionId` on `path` (see `reviewCommentsFor`); none without a path. */
export function useReviewComments(sessionId: string, path: string | null): ReviewComment[] {
  const sessions = useHuntStore((state) => state.sessions);
  return useMemo(() => (path ? reviewCommentsFor(sessions, sessionId, path) : []), [sessions, sessionId, path]);
}

/** How many review drafts `sessionId` has across all files. */
export function useReviewDraftCount(sessionId: string): number {
  return useHuntStore((state) => reviewSessionOf(state.sessions, sessionId)?.reviewComments.length ?? 0);
}

/** The pull request `sessionId` reviews (its own or its parent's), or null for a session without one. */
export function useReviewedPullRequest(sessionId: string): PullRequestRef | null {
  return useHuntStore((state) => reviewSessionOf(state.sessions, sessionId)?.pullRequest ?? null);
}

/**
 * Whether the new-file lines `startLine..line` lie inside one hunk of the diff `blocks` describe, i.e. whether
 * GitHub takes an inline comment there: a hunk is a block's modified lines plus `context` lines on either side (a
 * deletion contributes its context around the line it sits before). The backend applies the same rule to git's hunks.
 */
export function isInsideHunk(blocks: ChangeBlock[], startLine: number, line: number, context = HUNK_CONTEXT_LINES): boolean {
  return blocks.some((block) => {
    const first = block.modified.start - context;
    const last = block.modified.end - 1 + context;
    return startLine >= first && line <= last;
  });
}
