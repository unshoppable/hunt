import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AvailableCommand, PullRequestRef, Screenshot } from "../ipc/types";
import type { ContextUsage, PromptDraft } from "../state/store";
import { PillSelect, type PillOption } from "./PillSelect";
import { ScreenshotTrigger, screenshotUrl } from "./ScreenshotPicker";
import { CLEAR_BUTTON, SEND_BUTTON, STOP_BUTTON } from "../ui/buttons";
import { CloseIcon, EraserIcon, GitHubIcon } from "../ui/icons";
import { useAutoGrow } from "../ui/useAutoGrow";
import { useDismiss } from "../ui/useDismiss";
import { matchCommands, slashQueryOf } from "./slashCommands";

/** One agent config dropdown (model, effort, …) shown in the prompt toolbar. */
export type ConfigSelect = { id: string; name: string; value: string; choices: PillOption[] };

/** Accent color of the mode pill, matching the Claude Code dark theme (autoAccept, planMode, warning, error); manual mode stays neutral. */
const MODE_CLASS: Record<string, string | undefined> = {
  acceptEdits: "text-[#af87ff]",
  plan: "text-[#48968c]",
  auto: "text-[#ffc107]",
  bypassPermissions: "text-[#ff6b80]",
};

/**
 * The prompt box: a rounded card with the text area, attached screenshots, slash-command suggestions and a toolbar of
 * model, effort and mode pills. Used inside a session and, with an `extension` bar for repository and branch, as the
 * start view's composer. The screenshot picker sits in the left margin of the box.
 */
export function PromptInput({
  isBusy,
  isBlocked,
  modeId,
  modes,
  configSelects,
  commands,
  onSend,
  onCancel,
  onClear,
  onCycleMode,
  onModeChange,
  onConfigChange,
  pullRequest,
  extension,
  contextUsage,
  initialDraft = null,
  placeholder = "Ask anything, / for commands",
  hint = "",
}: {
  isBusy: boolean;
  /** A pending permission request owns the keyboard; the prompt is disabled until it is answered. */
  isBlocked: boolean;
  modeId: string;
  modes: PillOption[];
  configSelects: ConfigSelect[];
  commands: AvailableCommand[];
  onSend: (text: string, images: Screenshot[]) => void;
  onCancel: () => void;
  /** Clears the conversation like typing `/clear`; the clear button is only shown when this is given. */
  onClear?: () => void;
  onCycleMode: () => void;
  onModeChange: (modeId: string) => void;
  onConfigChange: (configId: string, value: string) => void;
  /** The pull request the session reviews; shown as a GitHub badge in the toolbar that opens it in the browser. */
  pullRequest?: PullRequestRef | null;
  /** Secondary bar attached below the box, e.g. the repository and base branch of a session to be created. */
  extension?: ReactNode;
  /** Fill level of the context window shown under the box; nothing is shown while it is unknown. */
  contextUsage?: ContextUsage | null;
  /** Text and attachments the box starts with, e.g. a prompt whose session could not be created. */
  initialDraft?: PromptDraft | null;
  placeholder?: string;
  /** Text under the box, e.g. what is still missing before a session can start; none inside a session. */
  hint?: string;
}) {
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [attachments, setAttachments] = useState<Screenshot[]>(initialDraft?.images ?? []);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  /** Set when Escape or a click outside closed the suggestions for the current text; typing shows them again. */
  const [isSuggestionsDismissed, setIsSuggestionsDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);

  const slashQuery = isSuggestionsDismissed ? null : slashQueryOf(text);
  const suggestions = slashQuery === null ? [] : matchCommands(commands, slashQuery);
  const selectedSuggestion = suggestions[Math.min(suggestionIndex, suggestions.length - 1)];
  const canSend = Boolean(text.trim() || attachments.length) && !isBusy && !isBlocked;

  useDismiss(suggestionsRef, () => setIsSuggestionsDismissed(true), { anchorRefs: [textareaRef], isEnabled: suggestions.length > 0 });
  useAutoGrow(textareaRef, text, 8);

  useEffect(() => {
    if (!isBlocked) {
      textareaRef.current?.focus();
    }
  }, [isBlocked]);

  function submit() {
    const trimmed = text.trim();
    const images = attachments;
    if ((!trimmed && !images.length) || isBusy || isBlocked) return;
    onSend(trimmed, images);
    setText("");
    setAttachments([]);
  }

  /** Attaches `screenshots` that are not attached yet and returns the focus to the text. */
  function addAttachments(screenshots: Screenshot[]) {
    setAttachments((current) => {
      const known = new Set(current.map((attachment) => attachment.path));
      return [...current, ...screenshots.filter((screenshot) => !known.has(screenshot.path))];
    });
    textareaRef.current?.focus();
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
      submit();
    }
  }

  return (
    <div className="px-9 pb-4 pt-2">
      <div className="chat-column min-w-[400px]">
        <div className="relative z-10 rounded-2xl border border-(--line) bg-(--surface-inset) shadow-lg shadow-black/20 focus-within:border-neutral-500">
          {attachments.length ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((attachment) => (
                <span key={attachment.path} className="group relative block" title={attachment.name}>
                  <img src={screenshotUrl(attachment)} alt="" className="size-16 rounded-md border border-white/10 bg-black/30 object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => setAttachments((current) => current.filter((other) => other.path !== attachment.path))}
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
            placeholder={placeholder}
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 outline-none placeholder:text-neutral-600 disabled:opacity-50"
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
          <div className="flex items-center px-2 pb-2">
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
            {isBusy ? (
              <button
                type="button"
                onClick={onCancel}
                title="Stop (esc)"
                className={STOP_BUTTON}
              >
                <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                title="Send (enter)"
                className={SEND_BUTTON}
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 13V3M4 7l4-4 4 4" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {extension}
        {contextUsage ? (
          <div className="flex justify-end px-2 pt-1.5 text-[12px] text-neutral-500" title="Context window: used / size">
            {formatContextUsage(contextUsage)}
          </div>
        ) : null}
        {hint ? <div className="px-1 pt-4 text-[13px] text-neutral-500">{hint}</div> : null}
      </div>
    </div>
  );
}

/** `42.3k / 200k (21%)`: tokens in context, window size and fill level. */
export function formatContextUsage({ used, size }: ContextUsage): string {
  const percent = size > 0 ? Math.round((used / size) * 100) : 0;
  return `${formatTokens(used)} / ${formatTokens(size)} (${percent}%)`;
}

/** Token counts as `9.5k`, `200k` or `1M`: one decimal below ten units, none above. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${trimScaled(count / 1_000_000)}M`;
  if (count >= 1000) return `${trimScaled(count / 1000)}k`;
  return String(count);
}

function trimScaled(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

/** Thin vertical rule between the toolbar pills. */
function PillSeparator() {
  return <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-(--line)" />;
}
