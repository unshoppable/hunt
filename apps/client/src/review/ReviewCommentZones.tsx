import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type * as monaco from "monaco-editor";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MarkdownText } from "../chat/MessageList";
import { formatRelativeTime } from "../chat/ScreenshotPicker";
import type { ChangeBlock } from "../diff/lineDiff";
import { commands } from "../ipc/commands";
import type { ReviewComment, ReviewThread } from "../ipc/types";
import { GHOST_BUTTON_XS, ICON_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { ExternalIcon } from "../ui/icons";
import { rangeBar, rangeDecoration, type CommentTarget } from "./addCommentGlyph";
import { Avatar, useGithubViewer, ViewerAvatar } from "./Avatar";
import { LineZone } from "./lineZone";
import { CommentEditorPanel, NOTE_HINT, ReviewCommentComposer } from "./ReviewCommentComposer";
import {
  draftCards,
  isFileSpan,
  isPostedOnDiff,
  reloadReviewThreads,
  threadAnchorLine,
  useReviewComments,
  useReviewDraftCount,
  useReviewThreads,
  type LineSpan,
} from "./reviewComments";

const COMPOSER_KEY = "composer";
const THREADS_ERROR_KEY = "threads-error";

type ReviewCommentZonesProps = {
  editor: monaco.editor.ICodeEditor;
  sessionId: string;
  /** Worktree path of the file the editor shows; the drafts of that file get a zone under their last line. */
  path: string;
  /** Change blocks of the file against the diff base, for telling inline comments from notes. */
  blocks: ChangeBlock[];
  /**
   * Lines a new comment is being written for and the line its box opens under (`FILE_SPAN` and 0 for a comment on
   * the whole file), or null while no box is open.
   */
  composer: CommentTarget | null;
  onCloseComposer: () => void;
};

/**
 * The review threads of `path` on GitHub and its drafted review comments as cards under their lines (those on the
 * whole file above the first line), drafted replies inside the card they answer, and, while `composer` is set, the box
 * for a new comment, each in a `LineZone` of `editor`. Zones persist across renders; a thread or draft that
 * disappears takes its zone with it. Remount (key) when `editor` or `path` changes.
 */
export function ReviewCommentZones({ editor, sessionId, path, blocks, composer, onCloseComposer }: ReviewCommentZonesProps) {
  const comments = useReviewComments(sessionId, path);
  const { threads, error: threadsError, isLoaded } = useReviewThreads(sessionId, path);
  const { roots, replies, orphans } = useMemo(
    () => draftCards(comments, isLoaded ? new Set(threads.map((thread) => thread.id)) : null),
    [comments, threads, isLoaded],
  );
  const zonesRef = useRef(new Map<string, LineZone>());
  const [zones, setZones] = useState<Map<string, LineZone>>(zonesRef.current);

  const entries = [
    ...(threadsError ? [{ key: THREADS_ERROR_KEY, line: 0 }] : []),
    ...threads.map((thread) => ({ key: thread.id, line: threadAnchorLine(blocks, thread) })),
    ...[...roots, ...orphans].map((comment) => ({ key: comment.id, line: comment.line })),
  ];
  if (composer) {
    entries.push({ key: COMPOSER_KEY, line: composer.underLine });
  }
  const signature = entries.map((entry) => `${entry.key}@${entry.line}`).join("\n");

  // Keeps one zone per entry: existing zones on the same line stay, the rest are replaced; `signature` stands for `entries`.
  useEffect(() => {
    const current = zonesRef.current;
    const next = new Map<string, LineZone>();
    entries.forEach((entry, ordinal) => {
      const existing = current.get(entry.key);
      if (existing && existing.afterLine === entry.line) {
        next.set(entry.key, existing);
        return;
      }
      existing?.dispose();
      next.set(entry.key, new LineZone(editor, entry.line, ordinal));
    });
    for (const [key, zone] of current) {
      if (!next.has(key)) {
        zone.dispose();
      }
    }
    zonesRef.current = next;
    setZones(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, signature]);

  useEffect(
    () => () => {
      for (const zone of zonesRef.current.values()) {
        zone.dispose();
      }
      zonesRef.current = new Map();
    },
    [editor],
  );

  // Tints the composer's lines, as GitHub does, for as long as the box is open; the bar's color follows the "+". A
  // comment on the whole file tints nothing.
  const tintedSpan = composer && !isFileSpan(composer.span) ? composer.span : null;
  const composerStart = tintedSpan?.startLine ?? null;
  const composerEnd = tintedSpan?.line ?? null;
  const isComposerInline = composer ? isPostedOnDiff(blocks, composer.span) : false;
  useEffect(() => {
    if (composerStart === null || composerEnd === null) return;
    const span = { startLine: composerStart, line: composerEnd };
    const tint = editor.createDecorationsCollection([rangeDecoration(span)]);
    const bar = rangeBar(editor);
    bar.show(span, isComposerInline);
    return () => {
      tint.clear();
      bar.dispose();
    };
  }, [editor, composerStart, composerEnd, isComposerInline]);

  const composerZone = composer ? zones.get(COMPOSER_KEY) : undefined;
  const threadsErrorZone = threadsError ? zones.get(THREADS_ERROR_KEY) : undefined;
  return (
    <>
      {threadsError && threadsErrorZone
        ? createPortal(
            <ZoneFrame label="GitHub" hint="Review threads could not be loaded">
              <p className="whitespace-pre-wrap px-3 py-2 text-[13px] text-red-400">{threadsError}</p>
            </ZoneFrame>,
            threadsErrorZone.domNode,
            THREADS_ERROR_KEY,
          )
        : null}
      {threads.map((thread) => {
        const zone = zones.get(thread.id);
        if (!zone) return null;
        const card = <ReviewThreadCard sessionId={sessionId} thread={thread} anchorLine={threadAnchorLine(blocks, thread)} drafts={replies.get(thread.id) ?? []} />;
        return createPortal(card, zone.domNode, thread.id);
      })}
      {roots.map((comment) => {
        const zone = zones.get(comment.id);
        if (!zone) return null;
        const card = <ReviewCommentCard sessionId={sessionId} comment={comment} replies={replies.get(comment.id) ?? []} isInline={isPostedOnDiff(blocks, comment)} />;
        return createPortal(card, zone.domNode, comment.id);
      })}
      {orphans.map((comment) => {
        const zone = zones.get(comment.id);
        if (!zone) return null;
        return createPortal(<OrphanReplyCard sessionId={sessionId} comment={comment} />, zone.domNode, comment.id);
      })}
      {composer && composerZone
        ? createPortal(
            <ReviewCommentComposer
              sessionId={sessionId}
              span={composer.span}
              isInline={isComposerInline}
              onSubmit={(body) => commands.addReviewComment(sessionId, path, composer.span.startLine, composer.span.line, body)}
              onClose={onCloseComposer}
            />,
            composerZone.domNode,
            COMPOSER_KEY,
          )
        : null}
    </>
  );
}

function lineLabel(span: LineSpan): string {
  if (isFileSpan(span)) return "File";
  return span.startLine === span.line ? `L${span.line}` : `L${span.startLine}–L${span.line}`;
}

/** `lineLabel` of a thread; lines of the base version are marked as such. */
function threadLabel(thread: ReviewThread): string {
  const label = lineLabel(thread);
  return thread.side === "left" && !isFileSpan(thread) ? `Base ${label}` : label;
}

const PENDING_BADGE = "rounded-full border border-amber-400/40 px-2 text-[12px] text-amber-300";
/** GitHub's collapsed reply field: looks like a one-line text field and opens the comment editor. */
const REPLY_FIELD =
  "flex h-8 w-full cursor-text items-center rounded-md border border-(--line) bg-(--surface-input) px-2.5 text-left text-sm text-neutral-500 outline-none hover:border-white/15 focus-visible:ring-2 focus-visible:ring-blue-400/60";

type ReviewThreadCardProps = {
  sessionId: string;
  thread: ReviewThread;
  /** The line of the new file version the card sits under (see `threadAnchorLine`); drafted replies carry it. */
  anchorLine: number;
  /** Drafted replies to the thread, oldest first. */
  drafts: ReviewComment[];
};

/**
 * A review thread from GitHub: a header with the avatar of whoever opened it, its lines, author and age, then the
 * first comment, every reply with its author's avatar, the drafted replies marked "Pending", GitHub's "Write a reply"
 * and "Resolve conversation". A resolved thread shows only its header until expanded; resolving collapses it.
 */
function ReviewThreadCard({ sessionId, thread, anchorLine, drafts }: ReviewThreadCardProps) {
  const [isExpanded, setIsExpanded] = useState(!thread.isResolved || drafts.length > 0);
  // Resolution as last requested here, until a load of the threads reports a different one.
  const [isResolved, setIsResolved] = useState(thread.isResolved);
  const [loadedResolved, setLoadedResolved] = useState(thread.isResolved);
  if (thread.isResolved !== loadedResolved) {
    setLoadedResolved(thread.isResolved);
    setIsResolved(thread.isResolved);
  }
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [first, ...replies] = thread.comments;
  const states = [thread.isOutdated ? "Outdated" : null, isResolved ? "Resolved" : null];
  const hint = [first.author, formatRelativeTime(Date.parse(first.createdAt)), ...states].filter(Boolean).join(" · ");

  async function toggleResolved() {
    const next = !isResolved;
    setIsResolving(true);
    setResolveError(null);
    try {
      await commands.resolveReviewThread(sessionId, thread.id, next);
    } catch (reason) {
      setResolveError(String(reason));
      setIsResolving(false);
      return;
    }
    setIsResolving(false);
    setIsResolved(next);
    if (next) {
      setIsExpanded(false);
    }
    reloadReviewThreads(sessionId);
  }

  const draftReply = (body: string) => commands.addReviewComment(sessionId, thread.path, anchorLine, anchorLine, body, { kind: "thread", id: thread.id });
  const postReply = async (body: string) => {
    await commands.replyToReviewThread(sessionId, thread.id, body);
    reloadReviewThreads(sessionId);
  };

  return (
    <ZoneFrame
      avatar={<Avatar login={first.author} url={first.avatarUrl} size="size-5" />}
      label={threadLabel(thread)}
      hint={hint}
      actions={
        <>
          {isResolved ? (
            <button type="button" onClick={() => setIsExpanded(!isExpanded)} className={GHOST_BUTTON_XS}>
              {isExpanded ? "Hide" : "Show"}
            </button>
          ) : null}
          <button type="button" onClick={() => void openUrl(first.url)} className={ICON_BUTTON_XS} title="Open on GitHub" aria-label="Open on GitHub">
            <ExternalIcon />
          </button>
        </>
      }
    >
      {isExpanded ? (
        <>
          <div className="px-3 py-2">
            <MarkdownText text={first.body} className="markdown-document" />
          </div>
          {replies.map((reply) => (
            <CommentRow key={reply.id} avatar={<Avatar login={reply.author} url={reply.avatarUrl} size="size-5" />} author={reply.author} createdAt={reply.createdAt}>
              <MarkdownText text={reply.body} className="markdown-document" />
            </CommentRow>
          ))}
          {drafts.map((draft) => (
            <DraftReply key={draft.id} sessionId={sessionId} comment={draft} />
          ))}
          {thread.viewerCanReply ? <ReplyBox sessionId={sessionId} onDraft={draftReply} onPost={postReply} /> : null}
          {thread.viewerCanResolve || thread.viewerCanUnresolve ? (
            <div className="px-3 py-2">
              <button type="button" onClick={() => void toggleResolved()} disabled={isResolving} className={SECONDARY_BUTTON_XS}>
                {isResolved ? "Unresolve conversation" : "Resolve conversation"}
              </button>
              {resolveError ? <p className="mt-2 whitespace-pre-wrap text-[13px] text-red-400">{resolveError}</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </ZoneFrame>
  );
}

type CommentRowProps = {
  avatar: ReactNode;
  /** Login of the author; null while the viewer's is unknown. */
  author: string | null;
  createdAt: string;
  /** Marks a drafted reply that goes out with the review. */
  isPending?: boolean;
  actions?: ReactNode;
  children: ReactNode;
};

/** A reply in a thread: its author's avatar, login and age (and "Pending" for a draft), actions on the right, the text below. */
function CommentRow({ avatar, author, createdAt, isPending = false, actions, children }: CommentRowProps) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[12px] text-neutral-500">
        {avatar}
        {author ? <span className="font-semibold text-neutral-300">{author}</span> : null}
        <span title={createdAt}>{formatRelativeTime(Date.parse(createdAt))}</span>
        {isPending ? <span className={PENDING_BADGE}>Pending</span> : null}
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </div>
  );
}

/**
 * Edit and Delete of a draft: `actions` are the two buttons (none while editing), `content` is the text as markdown
 * or its editor, followed by the error of a failed delete. `deleteQuestion` is what the confirmation asks.
 */
function useDraftActions(sessionId: string, comment: ReviewComment, deleteQuestion: string): { actions: ReactNode; content: ReactNode } {
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!(await confirmDestructive(deleteQuestion))) return;
    commands.deleteReviewComment(sessionId, comment.id).catch((reason) => setError(String(reason)));
  };

  const actions = isEditing ? null : (
    <>
      <button type="button" onClick={() => setIsEditing(true)} className={GHOST_BUTTON_XS}>
        Edit
      </button>
      <button type="button" onClick={() => void remove()} className={GHOST_BUTTON_XS}>
        Delete
      </button>
    </>
  );
  const content = (
    <>
      {isEditing ? (
        <CommentEditorPanel initial={comment.body} submitLabel="Save" onSubmit={(body) => commands.updateReviewComment(sessionId, comment.id, body)} onClose={() => setIsEditing(false)} />
      ) : (
        <MarkdownText text={comment.body} className="markdown-document" />
      )}
      {error ? <p className="mt-2 whitespace-pre-wrap text-[13px] text-red-400">{error}</p> : null}
    </>
  );
  return { actions, content };
}

/** A drafted reply inside the card it answers: the viewer's avatar and login, "Pending", Edit and Delete. */
function DraftReply({ sessionId, comment }: { sessionId: string; comment: ReviewComment }) {
  const viewer = useGithubViewer(sessionId);
  const { actions, content } = useDraftActions(sessionId, comment, "Delete this reply?");
  return (
    <CommentRow
      avatar={<Avatar login={viewer?.login ?? null} url={viewer?.avatarUrl} size="size-5" />}
      author={viewer?.login ?? null}
      createdAt={comment.createdAt}
      isPending
      actions={actions}
    >
      {content}
    </CommentRow>
  );
}

type ReplyBoxProps = {
  sessionId: string;
  /** Drafts the reply; it goes out with the review. Rejects with the message to show. */
  onDraft: (body: string) => Promise<unknown>;
  /** Posts the reply right away; absent where only a draft can be answered (a reply to a draft). */
  onPost?: (body: string) => Promise<unknown>;
};

/**
 * GitHub's "Write a reply" at the bottom of a thread: a field in a darker band that opens a `CommentEditorPanel`. As on
 * GitHub the reply starts a review ("Start a review") or joins the drafts ("Add review comment"); while there are no
 * drafts, `onPost` can send it right away as well ("Add single comment").
 */
function ReplyBox({ sessionId, onDraft, onPost }: ReplyBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasDrafts = useReviewDraftCount(sessionId) > 0;
  return (
    <div className="bg-black/15 px-3 py-2.5">
      {isOpen ? (
        <CommentEditorPanel
          submitLabel={hasDrafts ? "Add review comment" : "Start a review"}
          onSubmit={onDraft}
          secondaryAction={onPost && !hasDrafts ? { label: "Add single comment", onSubmit: onPost } : undefined}
          onClose={() => setIsOpen(false)}
        />
      ) : (
        <button type="button" onClick={() => setIsOpen(true)} className={REPLY_FIELD}>
          Write a reply
        </button>
      )}
    </div>
  );
}

type ReviewCommentCardProps = {
  sessionId: string;
  comment: ReviewComment;
  /** Drafted replies to the comment, oldest first. */
  replies: ReviewComment[];
  /** Whether the comment is posted on the diff; otherwise it becomes a note, which the header says. */
  isInline: boolean;
};

/**
 * A drafted comment: the viewer's avatar, its lines (or "File"), the text as markdown with buttons to edit or delete
 * it, its drafted replies and GitHub's "Write a reply". Deleting it deletes its replies too.
 */
function ReviewCommentCard({ sessionId, comment, replies, isInline }: ReviewCommentCardProps) {
  const { actions, content } = useDraftActions(sessionId, comment, replies.length ? "Delete this review comment and its replies?" : "Delete this review comment?");
  const draftReply = (body: string) => commands.addReviewComment(sessionId, comment.path, comment.startLine, comment.line, body, { kind: "draft", id: comment.id });
  return (
    <ZoneFrame avatar={<ViewerAvatar sessionId={sessionId} size="size-5" />} label={lineLabel(comment)} hint={isInline ? null : NOTE_HINT} actions={actions}>
      <div className="px-3 py-2">{content}</div>
      {replies.map((reply) => (
        <DraftReply key={reply.id} sessionId={sessionId} comment={reply} />
      ))}
      <ReplyBox sessionId={sessionId} onDraft={draftReply} />
    </ZoneFrame>
  );
}

/** A drafted reply whose thread or draft is gone or could not be loaded: a card of its own, so it can still be edited or deleted. */
function OrphanReplyCard({ sessionId, comment }: { sessionId: string; comment: ReviewComment }) {
  const { actions, content } = useDraftActions(sessionId, comment, "Delete this reply?");
  return (
    <ZoneFrame avatar={<ViewerAvatar sessionId={sessionId} size="size-5" />} label={lineLabel(comment)} hint="Reply · the thread it answers was not found" actions={actions}>
      <div className="px-3 py-2">{content}</div>
    </ZoneFrame>
  );
}

type ZoneFrameProps = {
  /** Who wrote the content; sits before the label. */
  avatar?: ReactNode;
  label: string;
  hint: string | null;
  actions?: ReactNode;
  /** Sections under the header, divided by rules; each brings its own padding. None leaves only the header. */
  children?: ReactNode;
};

/** GitHub-style card under a line: a tinted header with avatar, line label, hint and actions, the content below. */
function ZoneFrame({ avatar, label, hint, actions, children }: ZoneFrameProps) {
  return (
    <div className="py-1.5 pr-3" style={{ paddingLeft: "var(--zone-content-left)" }}>
      <div className="overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset) text-[13px] leading-[1.5] text-neutral-200 shadow-md">
        <div className={`flex min-h-9 items-center gap-2 bg-white/4 px-3 py-1 text-[12px] text-neutral-400${children ? " border-b border-(--line)" : ""}`}>
          {avatar}
          <span className="shrink-0 font-mono text-neutral-300">{label}</span>
          {hint ? <span className="min-w-0 truncate text-neutral-500">{hint}</span> : null}
          <span className="flex-1" />
          {actions}
        </div>
        {children ? <div className="divide-y divide-(--line)">{children}</div> : null}
      </div>
    </div>
  );
}
