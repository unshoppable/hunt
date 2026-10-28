import type { ChangeBlock } from "../editor/line-diff.utils";
import type { SessionView } from "../sessions/session.types";
import type { ReviewComment, ReviewThread } from "./review.types";
import { useReviewThreadStore } from "./review-threads.store";
import { useHuntStore } from "../sessions/hunt.store";
import { LineSpan } from "./line-span.value-object";

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

/** Lines a comment marks with GitHub's tint and a bar beside them: blue for a comment posted inline, grey for a note. */
export type MarkedSpan = { span: LineSpan; isInline: boolean };

/** The lines a drafted comment, or the comment box, on `span` marks; none for a comment on the whole file. */
export function draftMark(blocks: readonly ChangeBlock[], span: LineSpan): MarkedSpan | null {
  if (span.isFile) return null;
  return { span, isInline: span.isPostedOnDiff(blocks) };
}

/** The lines an unresolved thread on the new file version marks; resolved threads, base lines and the whole file mark none. */
export function threadMark(thread: Pick<ReviewThread, "side" | "startLine" | "line" | "isResolved">): MarkedSpan | null {
  if (thread.side !== "right" || thread.isResolved) return null;
  const span = LineSpan.ofComment(thread);
  return span.isFile ? null : { span, isInline: true };
}

/**
 * The line of the new file version a thread's card sits under: the last line of a thread on the new version, 0 (above
 * the first line) for a thread on the whole file. A thread on lines of the base version sits under the new lines that
 * replaced them; under the line before a pure deletion it shows above the deleted lines, as the inline diff aligns its
 * base line numbers only with zones that come first. One on an unchanged base line sits under that line in the new version.
 */
export function threadAnchorLine(blocks: ChangeBlock[], thread: Pick<ReviewThread, "side" | "line">): number {
  if (thread.side === "right" || LineSpan.isFileLine(thread.line)) return thread.line;
  let offset = 0;
  for (const block of blocks) {
    if (thread.line < block.original.start) break;
    if (thread.line < block.original.end) return block.modified.end - 1;
    offset = block.modified.end - block.original.end;
  }
  return thread.line + offset;
}
