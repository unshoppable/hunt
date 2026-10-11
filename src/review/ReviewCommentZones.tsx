import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type * as monaco from "monaco-editor";
import { MarkdownText } from "../chat/MessageList";
import type { ChangeBlock } from "../diff/lineDiff";
import { commands } from "../ipc/commands";
import type { ReviewComment } from "../ipc/types";
import { GHOST_BUTTON_SM } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { rangeDecoration } from "./addCommentGlyph";
import { LineZone } from "./lineZone";
import { CommentEditorPanel, ReviewCommentComposer } from "./ReviewCommentComposer";
import { isInsideHunk, useReviewComments, type LineSpan } from "./reviewComments";

const COMPOSER_KEY = "composer";
const NOTE_HINT = "Outside the diff · posted as a note in the review summary";

type ReviewCommentZonesProps = {
  editor: monaco.editor.ICodeEditor;
  sessionId: string;
  /** Worktree path of the file the editor shows; the drafts of that file get a zone under their last line. */
  path: string;
  /** Change blocks of the file against the diff base, for telling inline comments from notes. */
  blocks: ChangeBlock[];
  /** Lines a new comment is being written for, or null while no comment box is open. */
  composer: LineSpan | null;
  onCloseComposer: () => void;
};

/**
 * The drafted review comments of `path` as cards under their lines and, while `composer` is set, the box for a
 * new one, each in a `LineZone` of `editor`. Zones persist across renders; a draft that disappears takes its
 * zone with it. Remount (key) when `editor` or `path` changes.
 */
export function ReviewCommentZones({ editor, sessionId, path, blocks, composer, onCloseComposer }: ReviewCommentZonesProps) {
  const comments = useReviewComments(sessionId, path);
  const zonesRef = useRef(new Map<string, LineZone>());
  const [zones, setZones] = useState<Map<string, LineZone>>(zonesRef.current);

  const entries = comments.map((comment) => ({ key: comment.id, line: comment.line }));
  if (composer) {
    entries.push({ key: COMPOSER_KEY, line: composer.line });
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

  // Tints the composer's lines, as GitHub does, for as long as the box is open.
  const composerStart = composer?.startLine ?? null;
  const composerEnd = composer?.line ?? null;
  useEffect(() => {
    if (composerStart === null || composerEnd === null) return;
    const tint = editor.createDecorationsCollection([rangeDecoration({ startLine: composerStart, line: composerEnd })]);
    return () => tint.clear();
  }, [editor, composerStart, composerEnd]);

  const composerZone = composer ? zones.get(COMPOSER_KEY) : undefined;
  return (
    <>
      {comments.map((comment) => {
        const zone = zones.get(comment.id);
        if (!zone) return null;
        return createPortal(<ReviewCommentCard sessionId={sessionId} comment={comment} isInline={isInsideHunk(blocks, comment.startLine, comment.line)} />, zone.domNode, comment.id);
      })}
      {composer && composerZone
        ? createPortal(
            <ReviewCommentComposer
              sessionId={sessionId}
              span={composer}
              hint={isInsideHunk(blocks, composer.startLine, composer.line) ? null : NOTE_HINT}
              onSubmit={(body) => commands.addReviewComment(sessionId, path, composer.startLine, composer.line, body)}
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
  return span.startLine === span.line ? `L${span.line}` : `L${span.startLine}–L${span.line}`;
}

/** A drafted comment: its lines, the text as markdown, and buttons to edit or delete it. */
function ReviewCommentCard({ sessionId, comment, isInline }: { sessionId: string; comment: ReviewComment; isInline: boolean }) {
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!(await confirmDestructive("Delete this review comment?"))) return;
    commands.deleteReviewComment(sessionId, comment.id).catch((reason) => setError(String(reason)));
  };

  return (
    <ZoneFrame
      label={lineLabel(comment)}
      hint={isInline ? null : NOTE_HINT}
      actions={
        isEditing ? null : (
          <>
            <button type="button" onClick={() => setIsEditing(true)} className={GHOST_BUTTON_SM}>
              Edit
            </button>
            <button type="button" onClick={() => void remove()} className={GHOST_BUTTON_SM}>
              Delete
            </button>
          </>
        )
      }
    >
      {isEditing ? (
        <CommentEditorPanel initial={comment.body} submitLabel="Save" onSubmit={(body) => commands.updateReviewComment(sessionId, comment.id, body)} onClose={() => setIsEditing(false)} />
      ) : (
        <MarkdownText text={comment.body} className="markdown-document" />
      )}
      {error ? <p className="mt-2 whitespace-pre-wrap text-[13px] text-red-400">{error}</p> : null}
    </ZoneFrame>
  );
}

/** GitHub-style card under a line: a tinted header with the line label and actions, the content below. */
function ZoneFrame({ label, hint, actions, children }: { label: string; hint: string | null; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-1.5 pr-3" style={{ paddingLeft: "var(--zone-content-left)" }}>
      <div className="overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset) text-[13px] leading-[1.5] text-neutral-200 shadow-md">
        <div className="flex items-center gap-2 border-b border-(--line) bg-white/4 px-3 py-1 text-[12px] text-neutral-400">
          <span className="font-mono text-neutral-300">{label}</span>
          {hint ? <span className="truncate text-neutral-500">{hint}</span> : null}
          <span className="flex-1" />
          {actions}
        </div>
        <div className="px-3 py-2">{children}</div>
      </div>
    </div>
  );
}
