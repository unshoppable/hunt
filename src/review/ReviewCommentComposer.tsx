import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent } from "react";
import { MarkdownText } from "../chat/MessageList";
import { commands } from "../ipc/commands";
import type { GithubViewer } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { ICON_BUTTON_XS, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import {
  BoldIcon,
  BulletListIcon,
  CodeIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  MentionIcon,
  NumberedListIcon,
  QuoteIcon,
  TaskListIcon,
} from "../ui/icons";
import { useAutoGrow } from "../ui/useAutoGrow";
import { useLoad } from "../ui/useLoad";
import { applyMarkdownAction, type MarkdownAction } from "./markdownEdits";
import { useReviewDraftCount, type LineSpan } from "./reviewComments";

/** Hint on a comment whose lines lie outside the diff hunks. */
export const NOTE_HINT = "Outside the diff · posted as a note in the review summary";

type ReviewCommentComposerProps = {
  sessionId: string;
  /** Lines of the new file version the comment is for. */
  span: LineSpan;
  /** Whether the comment lies inside a diff hunk and is posted inline; otherwise it becomes a note, which the title says. */
  isInline: boolean;
  /** Saves the draft; rejects with the message to show. */
  onSubmit: (body: string) => Promise<unknown>;
  onClose: () => void;
};

/**
 * GitHub's "add a comment" box under a diff line: a card with the viewer's avatar and "Add a comment on line R15"
 * (or "lines R15 to R28") above a `CommentEditorPanel` whose primary action starts the review or adds to it. The
 * outer element carries `data-review-composer` ("inline" or "note": the range's blue or grey bar runs along it) and
 * sits 10px right of the code's left edge via `--zone-content-left`.
 */
export function ReviewCommentComposer({ sessionId, span, isInline, onSubmit, onClose }: ReviewCommentComposerProps) {
  const hasDrafts = useReviewDraftCount(sessionId) > 0;
  const title = span.startLine === span.line ? `Add a comment on line R${span.line}` : `Add a comment on lines R${span.startLine} to R${span.line}`;
  const hint = isInline ? null : NOTE_HINT;
  return (
    <div
      data-review-composer={isInline ? "inline" : "note"}
      className="py-2 pr-3 text-[13px] leading-[1.5] text-neutral-200"
      style={{ paddingLeft: "calc(var(--zone-content-left) + 10px)" }}
    >
      <div className="rounded-md border border-(--line) bg-(--surface-inset) shadow-md">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <ViewerAvatar sessionId={sessionId} />
          <span className="font-semibold text-neutral-100">{title}</span>
          {hint ? <span className="truncate text-neutral-500">{hint}</span> : null}
        </div>
        <div className="px-3 pb-3">
          <CommentEditorPanel submitLabel={hasDrafts ? "Add review comment" : "Start a review"} onSubmit={onSubmit} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

/** One `gh api user` per repository; a failed load is forgotten so that the next box tries again. */
const viewerLoads = new Map<string, Promise<GithubViewer>>();

function loadViewer(repoPath: string): Promise<GithubViewer> {
  const cached = viewerLoads.get(repoPath);
  if (cached) return cached;
  const load = commands.githubViewer(repoPath).catch((reason) => {
    viewerLoads.delete(repoPath);
    throw reason;
  });
  viewerLoads.set(repoPath, load);
  return load;
}

/** The 24px avatar of the GitHub account `gh` is logged in as; a neutral circle while it loads or when it cannot be fetched. */
function ViewerAvatar({ sessionId }: { sessionId: string }) {
  const repoPath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.repoPath ?? null);
  const [viewer, setViewer] = useState<GithubViewer | null>(null);
  const [hasImageFailed, setHasImageFailed] = useState(false);
  useLoad(() => (repoPath ? loadViewer(repoPath) : Promise.resolve(null)), { onValue: setViewer, onError: () => setViewer(null) }, [repoPath]);
  return (
    <span className="size-6 shrink-0 overflow-hidden rounded-full bg-neutral-700" title={viewer?.login}>
      {viewer && !hasImageFailed ? <img src={viewer.avatarUrl} alt="" onError={() => setHasImageFailed(true)} className="size-full object-cover" /> : null}
    </span>
  );
}

type ToolbarItem = { action: MarkdownAction; title: string; Icon: ComponentType<{ className?: string }> };

/** GitHub's markdown toolbar: text styles, lists, mention; groups are separated by a divider. */
const TOOLBAR_GROUPS: ToolbarItem[][] = [
  [
    { action: "heading", title: "Heading", Icon: HeadingIcon },
    { action: "bold", title: "Bold (⌘B)", Icon: BoldIcon },
    { action: "italic", title: "Italic (⌘I)", Icon: ItalicIcon },
    { action: "quote", title: "Quote (⌘⇧.)", Icon: QuoteIcon },
    { action: "code", title: "Code (⌘E)", Icon: CodeIcon },
    { action: "link", title: "Link (⌘K)", Icon: LinkIcon },
  ],
  [
    { action: "bulletList", title: "Bulleted list (⌘⇧8)", Icon: BulletListIcon },
    { action: "numberedList", title: "Numbered list (⌘⇧7)", Icon: NumberedListIcon },
    { action: "taskList", title: "Task list", Icon: TaskListIcon },
  ],
  [{ action: "mention", title: "Mention a user or team (@)", Icon: MentionIcon }],
];

/** The toolbar action a ⌘ shortcut in the textarea stands for, or null for an ordinary key. */
function shortcutAction(event: KeyboardEvent<HTMLTextAreaElement>): MarkdownAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.shiftKey) {
    if (event.code === "Digit7") return "numberedList";
    if (event.code === "Digit8") return "bulletList";
    if (event.code === "Period") return "quote";
    return null;
  }
  switch (event.key.toLowerCase()) {
    case "b":
      return "bold";
    case "i":
      return "italic";
    case "k":
      return "link";
    case "e":
      return "code";
    default:
      return null;
  }
}

const TAB_BASE =
  "-mb-px inline-flex h-8 select-none items-center rounded-t-md border px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60";
/** The active tab merges into the panel below: its bottom border takes the panel's color and covers the strip's line. */
const TAB_ACTIVE = "border-(--line) border-b-(--surface-inset) bg-(--surface-inset) text-white";
const TAB_INACTIVE = "border-transparent text-neutral-400 hover:text-white";
const MODES = [
  ["write", "Write"],
  ["preview", "Preview"],
] as const;
/** GitHub's comment field: the UI sans font at 14px on a surface a shade darker than the panel. */
const TEXTAREA =
  "w-full resize-none rounded-md border border-(--line) bg-(--surface-input) px-2.5 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-500 focus:border-blue-400/60";

type CommentEditorPanelProps = {
  initial?: string;
  submitLabel: string;
  /** Saves the text; rejects with the message to show. */
  onSubmit: (body: string) => Promise<unknown>;
  onClose: () => void;
};

/**
 * GitHub's comment editor: a bordered panel with Write / Preview tabs and the markdown toolbar on the right over the
 * textarea (or the rendered markdown), and Cancel plus the primary action right-aligned under the panel. ⌘⏎ submits,
 * Escape closes, the toolbar's ⌘ shortcuts work in the textarea. Used inside the card of `ReviewCommentComposer` and
 * bare for editing a draft.
 */
export function CommentEditorPanel({ initial = "", submitLabel, onSubmit, onClose }: CommentEditorPanelProps) {
  const [body, setBody] = useState(initial);
  const [mode, setMode] = useState<(typeof MODES)[number][0]>("write");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  useAutoGrow(textareaRef, body, 12);
  const canSubmit = body.trim().length > 0 && !isSaving;

  useEffect(() => {
    if (mode === "write") {
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Restores the selection a toolbar action asked for once React has rendered the text it produced.
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const textarea = textareaRef.current;
    if (!selection || !textarea) return;
    pendingSelection.current = null;
    textarea.focus();
    textarea.setSelectionRange(selection[0], selection[1]);
  }, [body]);

  function runAction(action: MarkdownAction) {
    const textarea = textareaRef.current;
    if (!textarea || mode !== "write") return;
    const { value, selectionStart, selectionEnd } = textarea;
    const next = applyMarkdownAction(action, { text: value, selectionStart, selectionEnd });
    pendingSelection.current = [next.selectionStart, next.selectionEnd];
    setBody(next.text);
  }

  async function submit() {
    if (!canSubmit) return;
    setIsSaving(true);
    setError(null);
    try {
      await onSubmit(body.trim());
    } catch (reason) {
      setError(String(reason));
      setIsSaving(false);
      return;
    }
    onClose();
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const action = shortcutAction(event);
    if (!action) return;
    event.preventDefault();
    runAction(action);
  };

  // Keeps the textarea focused (and its selection) while a toolbar button is clicked.
  const keepFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-(--line) bg-(--surface-inset)">
        <div className="flex items-end justify-between gap-2 border-b border-(--line) bg-white/4 px-2 pt-2">
          <div className="flex gap-1" role="tablist">
            {MODES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={`${TAB_BASE} ${mode === value ? TAB_ACTIVE : TAB_INACTIVE}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center pb-1">
            {TOOLBAR_GROUPS.map((group, groupIndex) => (
              <div key={groupIndex} className="flex items-center">
                {groupIndex > 0 ? <span aria-hidden="true" className="mx-1 h-4 w-px bg-(--line)" /> : null}
                {group.map(({ action, title, Icon }) => (
                  <button
                    key={action}
                    type="button"
                    title={title}
                    aria-label={title}
                    disabled={mode !== "write"}
                    onMouseDown={keepFocus}
                    onClick={() => runAction(action)}
                    className={ICON_BUTTON_XS}
                  >
                    <Icon />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="p-2">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Leave a comment"
            rows={3}
            className={`${mode === "write" ? "" : "hidden "}${TEXTAREA}`}
          />
          {mode === "preview" ? (
            <div className="min-h-[4.5rem] px-1 py-1 text-sm">
              {body.trim() ? <MarkdownText text={body} className="markdown-document" /> : <p className="text-neutral-500">Nothing to preview</p>}
            </div>
          ) : null}
        </div>
      </div>
      {error ? <p className="whitespace-pre-wrap text-[13px] text-red-400">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isSaving} className={SECONDARY_BUTTON_XS}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON_XS} title="⌘⏎">
          {isSaving ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
