import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SelectionRequest } from "../diff/selectionContext";
import type { SelectionContext } from "../ipc/types";
import { agentSetupOf, useHuntStore } from "../state/store";
import { MessageList } from "./MessageList";
import { PermissionPrompt } from "./PermissionPrompt";
import { describeLines, describeSelection, SelectionCard } from "./SelectionCard";
import { useFollowScroll } from "./useFollowScroll";
import { titleFromPrompt } from "../sessions/sessionLabels";
import { CLEAR_BUTTON, GHOST_BUTTON_SM, ICON_BUTTON_SM, PRIMARY_BUTTON_SM, SEND_BUTTON, STOP_BUTTON } from "../ui/buttons";
import { CloseIcon, EraserIcon } from "../ui/icons";
import { useAutoGrow } from "../ui/useAutoGrow";

const WIDTH = 640;
const MAX_HEIGHT = 760;
const MARGIN = 12;

/** The popover a code view shows: a new sub chat about `request`, or the existing sub session `subSessionId` about it. */
export type ShownSubChat = { key: number; request: SelectionRequest; subSessionId?: string };

/**
 * State of a code view's sub chat popover. `open` shows a new sub chat about a selection or, with `subSessionId`,
 * an existing one; every call remounts the popover (see `key`).
 */
export function useSubChatPopover(): {
  shown: ShownSubChat | null;
  open: (request: SelectionRequest, subSessionId?: string) => void;
  /** Opens the popover for `request`, or closes it when it already shows a chat about the same lines. */
  toggle: (request: SelectionRequest) => void;
  close: () => void;
} {
  const [shown, setShown] = useState<ShownSubChat | null>(null);
  const counter = useRef(0);
  const open = useCallback((request: SelectionRequest, subSessionId?: string) => {
    counter.current += 1;
    setShown({ key: counter.current, request, subSessionId });
  }, []);
  const toggle = useCallback((request: SelectionRequest) => {
    setShown((current) => {
      if (current && isSameLines(current.request.selection, request.selection)) return null;
      counter.current += 1;
      return { key: counter.current, request };
    });
  }, []);
  const close = useCallback(() => setShown(null), []);
  return { shown, open, toggle, close };
}

function isSameLines(a: SelectionContext, b: SelectionContext): boolean {
  return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
}

type SubChatPopoverProps = {
  /** The session whose code view shows the popover; a new sub chat becomes its sub session. */
  parentSessionId: string;
  request: SelectionRequest;
  /** An existing sub session to show; without it, the first question creates one. */
  subSessionId?: string;
  /** Header text instead of "Sub chat about <lines>"; the selection card is left out then, the title says what the chat is about. */
  title?: string;
  /** Placeholder of the first question's textarea. */
  placeholder?: string;
  /** Whether the window has the sidebar the "Open in sidebar" button switches to; off in secondary windows. */
  hasSidebar?: boolean;
  onClose: () => void;
};

/**
 * Floating chat next to a code selection. A new sub session is created with the first question, takes over the
 * parent chat's agent settings and mode, and then behaves like any session: it runs in the background, shows up
 * under its parent in the sidebar and can be opened there in full. Closing the popover keeps the session; the
 * glyph on the selection's first line reopens it with the whole conversation.
 */
export function SubChatPopover({ parentSessionId, request, subSessionId: initialSubSessionId, title, placeholder, hasSidebar = true, onClose }: SubChatPopoverProps) {
  const [subSessionId, setSubSessionId] = useState<string | null>(initialSubSessionId ?? null);
  const [text, setText] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const createSubSession = useHuntStore((state) => state.createSubSession);
  const loadHistory = useHuntStore((state) => state.loadHistory);
  const resumeSession = useHuntStore((state) => state.resumeSession);
  const sendPrompt = useHuntStore((state) => state.sendPrompt);
  const cancelPrompt = useHuntStore((state) => state.cancelPrompt);
  const answerPermission = useHuntStore((state) => state.answerPermission);
  const selectSession = useHuntStore((state) => state.selectSession);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const chat = useHuntStore((state) => (subSessionId ? state.chats[subSessionId] : undefined));
  const parentChat = useHuntStore((state) => state.chats[parentSessionId]);
  const subSession = useHuntStore((state) => state.sessions.find((session) => session.id === subSessionId));
  const parent = useHuntStore((state) => state.sessions.find((session) => session.id === parentSessionId));
  const isBusy = isCreating || (chat?.isBusy ?? false);
  const isLive = !subSessionId || (subSession?.isLive ?? false);
  const [isResuming, setIsResuming] = useState(false);

  async function resume() {
    if (!subSessionId || isResuming) return;
    setIsResuming(true);
    try {
      await resumeSession(subSessionId);
    } finally {
      setIsResuming(false);
    }
  }

  // An existing sub session's chat may be missing after a webview reload; the backend's history rebuilds it. A
  // stopped agent has no history to load and is started again right away, so the reopened chat is ready to use.
  // An agent that stops while the popover is open shows the "Resume" button instead of restarting on its own.
  useEffect(() => {
    if (!initialSubSessionId) return;
    if (isLive) {
      void loadHistory(initialSubSessionId);
    } else {
      void resume();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // A pending permission disables the textarea; the popover itself takes the focus so its keys still arrive here.
  const hasPermission = Boolean(chat?.permission);
  useEffect(() => {
    if (hasPermission) {
      rootRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [hasPermission]);

  useFollowScroll(scrollRef, contentRef, subSessionId);
  useAutoGrow(textareaRef, text, 5);

  function showInMainPane(id: string) {
    void selectSession(id);
    onClose();
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    setText("");
    setError(null);
    if (subSessionId) {
      void sendPrompt(subSessionId, trimmed);
      return;
    }
    // The first question creates the session, which starts with the parent's agent setup and sends the question itself.
    setIsCreating(true);
    try {
      const setup = parentChat ? agentSetupOf(parentChat) : { configValues: {}, modeId: "default" };
      const id = await createSubSession(parentSessionId, titleFromPrompt(trimmed), request.selection, { setup, prompt: { text: trimmed, images: [] } }, false);
      setSubSessionId(id);
    } catch (reason) {
      setError(String(reason));
      setText(trimmed);
    } finally {
      setIsCreating(false);
    }
  }

  /** Escape stops a running turn, otherwise closes the popover. */
  const onEscape = () => {
    if (subSessionId && chat?.isBusy) {
      void cancelPrompt(subSessionId);
    } else {
      onClose();
    }
  };
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The popover owns the keyboard: the main chat's esc / shift+tab shortcuts must not fire from here.
    event.stopPropagation();
    // The permission prompt reads its own keys (digits, enter, esc) from this element.
    if (event.key !== "Escape" || chat?.permission) return;
    event.preventDefault();
    onEscapeRef.current();
  }

  // Escape pressed outside the popover (e.g. in the code view) belongs to it as well, taken in the capture phase like
  // every popover's (see useDismiss) so that the window-wide Escape shortcuts stay quiet. With a permission pending
  // it only moves the focus here, where the prompt answers the next Escape.
  useEffect(() => {
    function onWindowKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || rootRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      if (hasPermission) {
        rootRef.current?.focus();
      } else {
        onEscapeRef.current();
      }
    }
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [hasPermission]);

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const maxHeight = Math.min(MAX_HEIGHT, window.innerHeight - 2 * MARGIN);
  const left = Math.max(MARGIN, Math.min(request.anchor.x, window.innerWidth - WIDTH - MARGIN));
  const top = Math.max(MARGIN, Math.min(request.anchor.y, window.innerHeight - maxHeight - MARGIN));
  const lines = describeLines(request.selection);
  /** A stopped sub session has nothing to show between the header and the footer. */
  const showsSelection = !subSessionId && !title;
  const hasBody = showsSelection || Boolean(chat && (chat.isLoading || chat.items.length || chat.permission || chat.error)) || Boolean(error);

  return (
    <div
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
      aria-label={title ?? `Sub chat about ${describeSelection(request.selection)}`}
      style={{ left, top, width: WIDTH, maxHeight }}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      className="chat fixed z-50 flex flex-col overflow-hidden rounded-xl border border-neutral-600 bg-(--surface-chat) text-sm shadow-2xl shadow-black/50 outline-none"
    >
      <header className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-400" title={describeSelection(request.selection)}>
          {title ?? (
            <>
              Sub chat about <span className="font-mono text-neutral-300">{lines}</span>
            </>
          )}
        </span>
        {hasSidebar && subSessionId && subSessionId !== activeSessionId ? (
          <button
            type="button"
            onClick={() => showInMainPane(subSessionId)}
            className={GHOST_BUTTON_SM}
            title="Show this sub chat in the main pane"
          >
            Open in sidebar
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={ICON_BUTTON_SM} title="Close (esc)" aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto px-4 ${hasBody ? "py-3" : ""}`}>
        <div ref={contentRef} className="flex flex-col gap-3">
          {showsSelection ? <SelectionCard selection={request.selection} isOpen label={lines} /> : null}
          {chat?.isLoading ? <p className="text-neutral-500">Loading session…</p> : null}
          {chat ? <MessageList items={chat.items} plan={chat.plan} isBusy={chat.isBusy} isVerbose={false} basePath={parent?.worktreePath ?? ""} /> : null}
          {subSessionId && chat?.permission ? (
            <PermissionPrompt
              permission={chat.permission}
              keyTarget={rootRef}
              onAnswer={(optionId) => void answerPermission(subSessionId, chat.permission!.requestId, optionId)}
            />
          ) : null}
          {error || chat?.error ? <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">{error ?? chat?.error}</div> : null}
        </div>
      </div>

      {isLive ? (
        <div className="flex items-end gap-2 border-t border-(--line) px-4 py-2">
          <textarea
            ref={textareaRef}
            value={text}
            disabled={Boolean(chat?.permission)}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onTextareaKeyDown}
            rows={1}
            placeholder={subSessionId ? "Follow up…" : (placeholder ?? "Ask about the selected code…")}
            className="block min-w-0 flex-1 resize-none bg-transparent py-1 outline-none placeholder:text-neutral-600 disabled:opacity-50"
          />
          {subSessionId ? (
            <button
              type="button"
              onClick={() => void sendPrompt(subSessionId, "/clear")}
              disabled={isBusy || hasPermission}
              title="Clear conversation (/clear)"
              className={CLEAR_BUTTON}
            >
              <EraserIcon />
            </button>
          ) : null}
          {isBusy && subSessionId ? (
            <button
              type="button"
              onClick={() => void cancelPrompt(subSessionId)}
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
              onClick={() => void submit()}
              disabled={!text.trim() || isBusy}
              title="Send (enter)"
              className={SEND_BUTTON}
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 13V3M4 7l4-4 4 4" />
              </svg>
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 border-t border-(--line) px-4 py-2 text-[13px] text-neutral-400">
          <span>Agent is not running.</span>
          <button type="button" disabled={isResuming} onClick={() => void resume()} className={PRIMARY_BUTTON_SM}>
            {isResuming ? "Resuming…" : "Resume"}
          </button>
        </div>
      )}
    </div>
  );
}
