import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AvailableCommand, PullRequestRef, Screenshot } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import type { PromptDraft, QueuedPrompt } from "../state/store";
import { PillSelect } from "./PillSelect";
import { appendPromptTexts, QueuedPrompts, useReturnedPrompts } from "./QueuedPrompts";
import { ScreenshotTrigger, screenshotUrl } from "./ScreenshotPicker";
import { CLEAR_BUTTON, SEND_BUTTON } from "../ui/buttons";
import type { DropdownOption } from "../ui/floatingMenu";
import { CloseIcon, EraserIcon, GitHubIcon, SendIcon } from "../ui/icons";
import { ResizeGrips } from "../ui/ResizeGrips";
import { rowsHeight, useAutoGrow } from "../ui/useAutoGrow";
import { useDismiss } from "../ui/useDismiss";
import { matchCommands, slashQueryOf } from "./slashCommands";
import { insertImageReference, removeImageReference, shiftImageReferences } from "./imageReferences";
import { useImageDrop } from "./useImageDrop";

/** One agent config dropdown (model, effort, …) shown in the prompt toolbar. */
export type ConfigSelect = { id: string; name: string; value: string; choices: DropdownOption[] };

/**
 * Accent color of the mode pill, matching the Claude Code dark theme (autoAccept, planMode, warning); bypass uses a
 * pastel red instead of the theme's error red. Manual mode stays neutral.
 */
const MODE_CLASS: Record<string, string | undefined> = {
  acceptEdits: "text-[#af87ff]",
  plan: "text-[#48968c]",
  auto: "text-[#ffc107]",
  bypassPermissions: "text-[#f098a4]",
};

/** Share of the window height the text area may be dragged to at most. */
const MAX_PROMPT_HEIGHT_SHARE = 0.6;

/**
 * The prompt box: a rounded card with the text area, attached screenshots, slash-command suggestions and a toolbar of
 * model, effort and mode pills. Dragging its top edge makes the text area taller; the height is remembered until it is
 * dragged back to the two lines the box starts with. Used inside a session and, with an `extension` bar for repository
 * and branch, as the start view's composer. The screenshot picker sits in the left margin of the box. While the agent
 * is busy, sending queues the prompt (shown above the box) for the end of the running turn; the send button therefore
 * never turns into a stop button, Escape stops the turn. ⌘↩ sends the prompt at once, stopping the running turn.
 */
export function PromptInput({
  isBusy,
  isBlocked,
  queue = [],
  onTakeQueue = () => [],
  onUnqueue = () => {},
  modeId,
  modes,
  configSelects,
  commands,
  onSend,
  onSendNow = onSend,
  onClear,
  onCycleMode,
  onModeChange,
  onConfigChange,
  pullRequest,
  extension,
  initialDraft = null,
  onDraftChange,
  placeholder = "Ask anything, / for commands",
  hint = "",
  dropZoneRef,
}: {
  isBusy: boolean;
  /** A pending permission request owns the keyboard; the prompt is disabled until it is answered. */
  isBlocked: boolean;
  /** Prompts sent while the agent was busy, waiting for the running turn to end. */
  queue?: QueuedPrompt[];
  /** Empties the queue and returns its prompts; they come back into the box when the turn was stopped or failed. */
  onTakeQueue?: () => QueuedPrompt[];
  /** Takes one prompt out of the queue, after the box took it back. */
  onUnqueue?: (promptId: string) => void;
  /** Sends a prompt at once while the agent is busy, interrupting the running turn (⌘↩, or the queued row's button). */
  onSendNow?: (text: string, images: Screenshot[]) => void;
  modeId: string;
  modes: DropdownOption[];
  configSelects: ConfigSelect[];
  commands: AvailableCommand[];
  onSend: (text: string, images: Screenshot[]) => void;
  /** Clears the conversation like typing `/clear`; the clear button is only shown when this is given. */
  onClear?: () => void;
  onCycleMode: () => void;
  onModeChange: (modeId: string) => void;
  onConfigChange: (configId: string, value: string) => void;
  /** The pull request the session reviews; shown as a GitHub badge in the toolbar that opens it in the browser. */
  pullRequest?: PullRequestRef | null;
  /** Secondary bar attached below the box, e.g. the repository and base branch of a session to be created. */
  extension?: ReactNode;
  /** Text and attachments the box starts with, e.g. a prompt whose session could not be created. */
  initialDraft?: PromptDraft | null;
  /** Called with the text and attachments whenever they change, so the caller can keep what the box holds beyond its lifetime. */
  onDraftChange?: (draft: PromptDraft) => void;
  placeholder?: string;
  /** Text under the box, e.g. what is still missing before a session can start; none inside a session. */
  hint?: string;
  /** Element whose area takes dropped image files as attachments; the box itself without it. */
  dropZoneRef?: RefObject<HTMLElement | null>;
}) {
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [attachments, setAttachments] = useState<Screenshot[]>(initialDraft?.images ?? []);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  /** Set when Escape or a click outside closed the suggestions for the current text; typing shows them again. */
  const [isSuggestionsDismissed, setIsSuggestionsDismissed] = useState(false);
  /** Shown under the box after a drop that attached nothing; cleared by the next successful drop or after a while. */
  const [dropError, setDropError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Where the caret goes once the text holds a freshly inserted image reference. */
  const pendingCaretRef = useRef<number | null>(null);
  const promptHeight = useSettingsStore((state) => state.promptHeight);
  const setPromptHeight = useSettingsStore((state) => state.setPromptHeight);
  /** Text area height while its top edge is dragged; null outside a drag. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  /** Height the text area had when the drag started and the one it has now; read when the drag ends. */
  const dragRef = useRef({ start: 0, height: 0 });

  const slashQuery = isSuggestionsDismissed ? null : slashQueryOf(text);
  const suggestions = slashQuery === null ? [] : matchCommands(commands, slashQuery);
  const selectedSuggestion = suggestions[Math.min(suggestionIndex, suggestions.length - 1)];
  const canSend = Boolean(text.trim() || attachments.length) && !isBlocked;

  useDismiss(suggestionsRef, () => setIsSuggestionsDismissed(true), { anchorRefs: [textareaRef], isEnabled: suggestions.length > 0 });
  useAutoGrow(textareaRef, text, 8, dragHeight ?? promptHeight ?? 0);

  useEffect(() => {
    if (!isBlocked) {
      textareaRef.current?.focus();
    }
  }, [isBlocked]);

  useReturnedPrompts(isBusy, queue, onTakeQueue, takeBack);

  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current?.({ text, images: attachments });
  }, [text, attachments]);

  useEffect(() => {
    const caret = pendingCaretRef.current;
    if (caret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [text]);

  const isDropTarget = useImageDrop(dropZoneRef ?? rootRef, {
    onDrop: (images) => {
      setDropError(null);
      addAttachments(images);
    },
    onNoImages: () => setDropError("Only images can be attached: PNG, JPEG, GIF or WebP."),
  });

  useEffect(() => {
    if (!dropError) return;
    const timer = window.setTimeout(() => setDropError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [dropError]);

  function submit(sendsNow = false) {
    const trimmed = text.trim();
    const images = attachments;
    if ((!trimmed && !images.length) || isBlocked) return;
    if (sendsNow) {
      onSendNow(trimmed, images);
    } else {
      onSend(trimmed, images);
    }
    setText("");
    setAttachments([]);
  }

  /** Puts `prompts` back into the box, after the text and attachments it holds; their image references follow. */
  function takeBack(prompts: QueuedPrompt[]) {
    let offset = attachments.length;
    const shifted = prompts.map((prompt) => {
      const text = shiftImageReferences(prompt.text, offset);
      offset += prompt.images.length;
      return { ...prompt, text };
    });
    setText((current) => appendPromptTexts(current, shifted));
    attach(prompts.flatMap((prompt) => prompt.images));
    textareaRef.current?.focus();
  }

  /** Attaches `screenshots` that are not attached yet; returns the attached ones. */
  function attach(screenshots: Screenshot[]): Screenshot[] {
    const known = new Set(attachments.map((attachment) => attachment.path));
    const added = screenshots.filter((screenshot) => !known.has(screenshot.path));
    if (added.length) {
      setAttachments([...attachments, ...added]);
    }
    return added;
  }

  /** Attaches `screenshots`, writes a `[Image #n]` reference for each at the caret and returns the focus to the text. */
  function addAttachments(screenshots: Screenshot[]) {
    const added = attach(screenshots);
    let next = text;
    let caret = textareaRef.current?.selectionStart ?? text.length;
    added.forEach((_, offset) => {
      ({ text: next, caret } = insertImageReference(next, caret, attachments.length + offset + 1));
    });
    if (added.length) {
      setText(next);
      pendingCaretRef.current = caret;
    }
    textareaRef.current?.focus();
  }

  /** Detaches the image at `index` and drops its reference from the text, renumbering the ones after it. */
  function removeAttachment(index: number) {
    setAttachments(attachments.filter((_, other) => other !== index));
    setText(removeImageReference(text, index + 1));
  }

  function startHeightDrag() {
    const height = textareaRef.current?.offsetHeight ?? 0;
    dragRef.current = { start: height, height };
  }

  function dragHeightBy(dy: number) {
    const height = Math.max(0, Math.min(dragRef.current.start + dy, window.innerHeight * MAX_PROMPT_HEIGHT_SHARE));
    dragRef.current.height = height;
    setDragHeight(height);
  }

  /** Remembers the dragged height; dragged down to the box's own two lines, the box follows its text again. */
  function endHeightDrag() {
    const element = textareaRef.current;
    const { height } = dragRef.current;
    setPromptHeight(element && height > rowsHeight(element, element.rows) ? height : null);
    setDragHeight(null);
  }

  function completeSuggestion() {
    if (!selectedSuggestion) return;
    setText(`/${selectedSuggestion.name} `);
    setSuggestionIndex(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      onCycleMode();
      return;
    }
    if (suggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSuggestionIndex((current) => (current + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
        return;
      }
      const isCompleteName = selectedSuggestion?.name.toLowerCase() === slashQuery?.toLowerCase();
      if (event.key === "Tab" || (event.key === "Enter" && !isCompleteName)) {
        event.preventDefault();
        completeSuggestion();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.defaultPrevented) {
      event.preventDefault();
      submit(event.metaKey);
    }
  }

  return (
    <div ref={rootRef} className="px-9 pb-6 pt-2">
      <div className="chat-column min-w-[400px]">
        <QueuedPrompts
          queue={queue}
          onSendNow={(prompt) => {
            onUnqueue(prompt.id);
            onSendNow(prompt.text, prompt.images);
          }}
          onTakeBack={(prompt) => {
            onUnqueue(prompt.id);
            takeBack([prompt]);
          }}
        />
        <div
          className={`relative z-10 rounded-2xl border bg-(--surface-input) shadow-lg shadow-black/20 ${isDropTarget ? "border-dashed border-neutral-400" : "border-(--line) focus-within:border-neutral-500"}`}
        >
          {isDropTarget ? (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-2xl bg-(--surface-input)/90 text-sm text-neutral-200">
              Drop images to attach them
            </div>
          ) : null}
          {attachments.length ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((attachment, index) => (
                <span key={attachment.path} className="group relative block" title={`${attachment.name} – [Image #${index + 1}]`}>
                  <img src={screenshotUrl(attachment)} alt="" className="size-16 rounded-md border border-white/10 bg-black/30 object-cover" />
                  <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[12px] leading-4 text-neutral-200">#{index + 1}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => removeAttachment(index)}
                    className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-neutral-500 bg-neutral-800 text-neutral-200 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-700"
                  >
                    <CloseIcon className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            disabled={isBlocked}
            onChange={(event) => {
              setText(event.target.value);
              setSuggestionIndex(0);
              setIsSuggestionsDismissed(false);
            }}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={isBusy ? "Enter queues the prompt for after this turn" : placeholder}
            className="block w-full resize-none bg-transparent px-4 py-3 outline-none placeholder:text-neutral-600 disabled:opacity-50"
          />
          {suggestions.length ? (
            <ul
              ref={suggestionsRef}
              role="listbox"
              aria-label="Slash commands"
              className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-xl border border-neutral-600 bg-(--surface-chat) p-1 text-sm shadow-xl shadow-black/50"
            >
              {suggestions.map((command, index) => (
                <li key={command.name} role="option" aria-selected={index === suggestionIndex}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setSuggestionIndex(index)}
                    onClick={() => {
                      setText(`/${command.name} `);
                      textareaRef.current?.focus();
                    }}
                    className={`flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left ${index === suggestionIndex ? "bg-(--row-active) text-neutral-100" : "text-neutral-200"}`}
                  >
                    <span className="shrink-0 font-medium">/{command.name}</span>
                    <span className="min-w-0 flex-1 truncate text-neutral-500">{command.description}</span>
                    {command.input?.hint ? <span className="max-w-[40%] truncate text-[12px] text-neutral-500">{command.input.hint}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center border-t border-white/15 px-2 py-1.5">
            {configSelects.map((select) => (
              <Fragment key={select.id}>
                <PillSelect title={select.name} value={select.value} options={select.choices} onChange={(value) => onConfigChange(select.id, value)} />
                <PillSeparator />
              </Fragment>
            ))}
            <PillSelect
              title="Mode (shift+tab to cycle)"
              value={modeId}
              options={modes}
              onChange={onModeChange}
              className={MODE_CLASS[modeId] ?? ""}
            />
            <span className="flex-1" />
            {pullRequest ? (
              <button
                type="button"
                onClick={() => void openUrl(pullRequest.url)}
                title={`Reviewing pull request #${pullRequest.number}; open on GitHub`}
                aria-label={`Open pull request #${pullRequest.number} on GitHub`}
                className="mr-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-neutral-400 transition-colors hover:bg-(--row-hover) hover:text-white"
              >
                <GitHubIcon className="size-4" />#{pullRequest.number}
              </button>
            ) : null}
            <ScreenshotTrigger onPick={addAttachments} className="mr-3" />
            {onClear ? (
              <button
                type="button"
                onClick={onClear}
                disabled={isBusy || isBlocked}
                title="Clear conversation (/clear)"
                className={`${CLEAR_BUTTON} mr-3`}
              >
                <EraserIcon />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => submit()}
              disabled={!canSend}
              title={isBusy ? "Queue for after this turn (enter); ⌘↩ sends now, esc stops the turn" : "Send (enter)"}
              className={SEND_BUTTON}
            >
              <SendIcon />
            </button>
          </div>
          <ResizeGrips edges={{ top: true }} onStart={startHeightDrag} onDrag={({ dy }) => dragHeightBy(dy)} onEnd={endHeightDrag} />
        </div>
        {extension}
        {dropError ? <div className="px-1 pt-4 text-[13px] text-red-300">{dropError}</div> : null}
        {hint ? <div className="px-1 pt-4 text-[13px] text-neutral-500">{hint}</div> : null}
      </div>
    </div>
  );
}

/** Thin vertical rule between the toolbar pills. */
function PillSeparator() {
  return <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-white/15" />;
}
