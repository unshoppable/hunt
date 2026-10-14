import { useEffect, useMemo } from "react";
import type { ChangeBlock } from "../diff/lineDiff";
import type { PullRequestRef, ReviewComment, ReviewThread, SessionView } from "../ipc/types";
import { useReviewThreadStore } from "../state/reviewThreads";
import { useHuntStore } from "../state/store";

/** Lines of unchanged context git puts around every change; the diff of a pull request on GitHub has the same. */
export const HUNK_CONTEXT_LINES = 3;

/** A span of lines of the new file version a review comment is drafted on; a single line has `startLine === line`. */
export type LineSpan = { startLine: number; line: number };

/** The span of a comment on the whole file rather than on lines of it; its card sits above the first line. */
export const FILE_SPAN: LineSpan = { startLine: 0, line: 0 };

/** Whether `span` stands for the whole file (see `FILE_SPAN`). */
export function isFileSpan(span: LineSpan): boolean {
  return span.line === 0;
}

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

/** The drafts of a file as their cards show them (see `draftCards`). */
export type DraftCards = {
  /** Drafts that open a thread; each has a card of its own. */
  roots: ReviewComment[];
  /** Drafted replies by the ID of what they answer (a draft's or a GitHub thread's), oldest first. */
  replies: Map<string, ReviewComment[]>;
  /** Drafted replies whose thread or draft is not there; each has a card of its own, so it stays editable. */
  orphans: ReviewComment[];
};

/**
 * Splits the drafts of a file, oldest first, into the cards they show in: drafts that open a thread, replies under
 * what they answer, and orphaned replies. `threadIds` are the IDs of the file's loaded GitHub threads, null while no
 * load has ended; until then no reply to a thread counts as orphaned.
 */
export function draftCards(drafts: ReviewComment[], threadIds: ReadonlySet<string> | null): DraftCards {
  const rootIds = new Set(drafts.filter((draft) => !draft.replyTo).map((draft) => draft.id));
  const cards: DraftCards = { roots: [], replies: new Map(), orphans: [] };
  for (const draft of drafts) {
    const target = draft.replyTo;
    if (!target) {
      cards.roots.push(draft);
      continue;
    }
    const isAnswerable = target.kind === "draft" ? rootIds.has(target.id) : !threadIds || threadIds.has(target.id);
    if (!isAnswerable) {
      cards.orphans.push(draft);
      continue;
    }
    cards.replies.set(target.id, [...(cards.replies.get(target.id) ?? []), draft]);
  }
  return cards;
}

/** Loads the review threads of the pull request `sessionId` reviews again, after something was posted to it. */
export function reloadReviewThreads(sessionId: string): void {
  const reviewSessionId = reviewSessionOf(useHuntStore.getState().sessions, sessionId)?.id ?? sessionId;
  useReviewThreadStore.getState().refresh(reviewSessionId, true);
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

/** Review comments per path: one per draft plus every comment of the review threads, resolved threads included. */
export function reviewCommentCounts(drafts: ReviewComment[], threads: ReviewThread[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    counts.set(draft.path, (counts.get(draft.path) ?? 0) + 1);
  }
  for (const thread of threads) {
    counts.set(thread.path, (counts.get(thread.path) ?? 0) + thread.comments.length);
  }
  return counts;
}

/**
 * Review comments per path of `sessionId` (see `reviewCommentCounts`); for a session that reviews a pull request,
 * showing them loads GitHub's review threads again once the last load is stale (see `useReviewThreadStore`).
 */
export function useReviewCommentCounts(sessionId: string): Map<string, number> {
  const reviewSession = useHuntStore((state) => reviewSessionOf(state.sessions, sessionId));
  const threadSessionId = reviewSession?.pullRequest ? reviewSession.id : null;
  const load = useReviewThreadStore((state) => (threadSessionId ? state.loads[threadSessionId] : undefined));
  const refresh = useReviewThreadStore((state) => state.refresh);
  useEffect(() => {
    if (!threadSessionId) return;
    refresh(threadSessionId);
  }, [refresh, threadSessionId]);
  return useMemo(() => reviewCommentCounts(reviewSession?.reviewComments ?? [], load?.threads ?? []), [reviewSession, load]);
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

/**
 * Whether a comment on `span` is posted on the pull request's diff: a file comment when the file has changes, a line
 * comment when its lines lie inside one hunk (see `isInsideHunk`). Every other comment becomes a note in the review
 * summary; the backend decides the same way.
 */
export function isPostedOnDiff(blocks: ChangeBlock[], span: LineSpan): boolean {
  return isFileSpan(span) ? blocks.length > 0 : isInsideHunk(blocks, span.startLine, span.line);
}

/**
 * The line of the new file version a thread's card sits under: the last line of a thread on the new version, 0 (above
 * the first line) for a thread on the whole file. A thread on lines of the base version sits under the new lines that
 * replaced them; under the line before a pure deletion it shows above the deleted lines, as the inline diff aligns its
 * base line numbers only with zones that come first. One on an unchanged base line sits under that line in the new version.
 */
export function threadAnchorLine(blocks: ChangeBlock[], thread: Pick<ReviewThread, "side" | "line">): number {
  if (thread.side === "right" || thread.line === 0) return thread.line;
  let offset = 0;
  for (const block of blocks) {
    if (thread.line < block.original.start) break;
    if (thread.line < block.original.end) return block.modified.end - 1;
    offset = block.modified.end - block.original.end;
  }
  return thread.line + offset;
}
