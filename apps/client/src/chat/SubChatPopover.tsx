import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { SelectionRequest } from "../diff/selectionContext";
import type { SelectionContext } from "../ipc/types";
import { useAgentDefaultsStore } from "../state/agentDefaults";
import { useSettingsStore } from "../state/settings";
import { agentSetupOf, useHuntStore } from "../state/store";
import type { QueuedPrompt } from "../state/store";
import { DeleteSessionDialog } from "../sessions/DeleteSessionDialog";
import { findSelectOption, listChoiceOptions } from "./configOptions";
import { MessageList } from "./MessageList";
import { PillSelect } from "./PillSelect";
import { PermissionPrompt } from "./PermissionPrompt";
import { appendPromptTexts, QueuedPrompts, useReturnedPrompts } from "./QueuedPrompts";
import { ContextCard, describeLines, describeSelection, SelectionCard } from "./SelectionCard";
import { useFollowScroll } from "./useFollowScroll";
import { useVmConnect } from "./useVmConnect";
import { titleFromPrompt } from "../sessions/sessionLabels";
import { DANGER_CLEAR_BUTTON, GHOST_BUTTON_XS, ICON_BUTTON_SM, PRIMARY_BUTTON_XS, SEND_BUTTON } from "../ui/buttons";
import { CloseIcon, SendIcon, TrashIcon } from "../ui/icons";
import { trackDrag } from "../ui/pointerDrag";
import { ResizeGrips } from "../ui/ResizeGrips";
import { useAutoGrow, useTextareaDrag } from "../ui/useAutoGrow";
import { isShortcut, useShortcutLabel } from "../ui/shortcuts";
import { usePopupSize } from "../ui/usePopupSize";
import { useViewportSize } from "../ui/useViewportSize";

const MIN_SIZE = { width: 420, height: 240 };
/** Height the conversation keeps when the text area is dragged taller. */
const MIN_MESSAGES_HEIGHT = 80;
/** Space the popover keeps from the window's edges. */
const MARGIN = 12;
/**
 * Floating surfaces of the window (popovers, menus, dialogs) and buttons that toggle the popover; a mouse press on
 * one of them does not close it.
 */
const FLOATING_SURFACE = '[role="dialog"], [role="menu"], [role="listbox"], [data-popover-toggle]';

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
  /** Context the new sub chat's agent gets besides the question, shown as a card until the first question is sent. */
  context?: { label: string; text: string };
  /** Text the first question's textarea starts with; the caret is placed after it. */
  initialText?: string;
  /** Whether the window has the sidebar the "Open in sidebar" button switches to; off in secondary windows. */
  hasSidebar?: boolean;
  /** Called after the user moved or resized the popover, with how far its anchored corner now sits from the anchor. */
  onPlaced?: (offset: { x: number; y: number }) => void;
  onClose: () => void;
};

/**
 * Floating chat next to a code selection. A new sub session is created with the first question, takes over the
 * parent chat's agent settings and mode, and then behaves like any session: it runs in the background, shows up
 * under its parent in the sidebar and can be opened there in full. Escape and a mouse press outside every floating
 * surface close the popover; closing keeps the session, and the glyph on the selection's first line reopens it with
 * the whole conversation. The model pill in the footer picks the model of a new sub chat or switches the model of the
 * existing one. The popover is resized by dragging its edges (the size is remembered across sessions); until it is
 * dragged taller, it is as tall as its content, up to the remembered height. Dragging the top edge of the input area
 * makes the text area taller at the expense of the conversation, remembered until it is dragged back to one line. A
 * question sent while a turn runs is queued for the end of that turn.
 */
export function SubChatPopover({ parentSessionId, request, subSessionId: initialSubSessionId, title, placeholder, context, initialText = "", hasSidebar = true, onPlaced, onClose }: SubChatPopoverProps) {
  const [subSessionId, setSubSessionId] = useState<string | null>(initialSubSessionId ?? null);
  const [text, setText] = useState(initialText);
  const [isCreating, setIsCreating] = useState(false);
  /** Model picked for a sub chat that does not exist yet; `null` keeps the parent's model. */
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the "Delete session" dialog for the sub session is open. */
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const createSubSession = useHuntStore((state) => state.createSubSession);
  const loadHistory = useHuntStore((state) => state.loadHistory);
  const resumeSession = useHuntStore((state) => state.resumeSession);
  const sendPrompt = useHuntStore((state) => state.sendPrompt);
  const sendPromptNow = useHuntStore((state) => state.sendPromptNow);
  const takeQueue = useHuntStore((state) => state.takeQueue);
  const unqueuePrompt = useHuntStore((state) => state.unqueuePrompt);
  const answerPermission = useHuntStore((state) => state.answerPermission);
  const setConfigOption = useHuntStore((state) => state.setConfigOption);
  const knownOptions = useAgentDefaultsStore((state) => state.knownOptions);
  const selectSession = useHuntStore((state) => state.selectSession);
  const closeSession = useHuntStore((state) => state.closeSession);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const chat = useHuntStore((state) => (subSessionId ? state.chats[subSessionId] : undefined));
  const parentChat = useHuntStore((state) => state.chats[parentSessionId]);
  const subSession = useHuntStore((state) => state.sessions.find((session) => session.id === subSessionId));
  const parent = useHuntStore((state) => state.sessions.find((session) => session.id === parentSessionId));
  // A remote session's worktree that is locked for want of a connection connects on its own while the popover is open.
  useVmConnect(parentSessionId);
  const isBusy = isCreating || (chat?.isBusy ?? false);
  const isLive = !subSessionId || (subSession?.isLive ?? false);
  const [isResuming, setIsResuming] = useState(false);
  const queue = chat?.queue ?? [];
  const sendNowShortcut = useShortcutLabel("chat.sendNow");

  // The sub session's own options once it announced them, before that the parent's, in a secondary window without
  // the parent's chat the options the agent announced last.
  const configOptions = [chat?.configOptions, parentChat?.configOptions, knownOptions].find((options) => options?.length) ?? [];
  const modelOption = findSelectOption(configOptions, "model");
  const model = modelOption ? (subSessionId ? modelOption.currentValue : (pickedModel ?? modelOption.currentValue)) : null;

  function changeModel(value: string) {
    if (subSessionId) {
      void setConfigOption(subSessionId, "model", value);
    } else {
      setPickedModel(value);
    }
  }

  const viewport = useViewportSize();
  // Once the height was dragged, the popover keeps that height instead of following its content.
  const { size, shift, isHeightSet, grips } = usePopupSize("subChat", {
    min: MIN_SIZE,
    max: { width: viewport.width - 2 * MARGIN, height: viewport.height - 2 * MARGIN },
    room: (rendered) => ({ left: left - MARGIN, top: top - MARGIN, right: viewport.width - MARGIN - left - rendered.width, bottom: viewport.height - MARGIN - top - rendered.height }),
  });
  // The popover opens with its anchored corner at the anchor, its remembered size counted from there, moved as far as
  // needed to stay inside the window's margin, so that it can grow with its content without moving. From there a
  // dragged left or top edge moves it by `shift`.
  const isBottomRight = request.anchor.corner === "bottomRight";
  const [origin] = useState(() => {
    const x = isBottomRight ? request.anchor.x - size.width : request.anchor.x;
    const y = isBottomRight ? request.anchor.y - size.height : request.anchor.y;
    return {
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - size.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - size.height - MARGIN)),
    };
  });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // A popover as tall as its content may be moved down as far as its rendered height, not its remembered one, allows.
  const [renderedHeight, setRenderedHeight] = useState(size.height);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setRenderedHeight(root.offsetHeight);
    const observer = new ResizeObserver(() => setRenderedHeight(root.offsetHeight));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  // A bottom-anchored popover as tall as its content keeps its bottom edge in place and grows upwards; `slack` is the
  // remembered height its content does not use yet.
  const slack = isBottomRight && !isHeightSet ? Math.max(0, size.height - renderedHeight) : 0;
  const latestSlack = useRef(slack);
  // A dragged height drops the slack; the offset takes it over so that the popover does not jump.
  useLayoutEffect(() => {
    if (!isHeightSet || !latestSlack.current) return;
    const taken = latestSlack.current;
    setOffset((current) => ({ x: current.x, y: current.y + taken }));
  }, [isHeightSet]);
  useLayoutEffect(() => {
    latestSlack.current = slack;
  });
  const left = Math.max(MARGIN, Math.min(origin.x + offset.x + shift.x, viewport.width - size.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(origin.y + slack + offset.y + shift.y, viewport.height - (isHeightSet ? size.height : renderedHeight) - MARGIN));
  const height = isHeightSet ? size.height : renderedHeight;
  const latestPlace = useRef({ left, top, shift, slack, height });
  latestPlace.current = { left, top, shift, slack, height };

  /** Hands `onPlaced` the anchored corner's distance from the anchor. */
  function reportPlace() {
    if (!onPlaced) return;
    const { left: placedLeft, top: placedTop, height: placedHeight } = latestPlace.current;
    const corner = isBottomRight ? { x: placedLeft + size.width, y: placedTop + placedHeight } : { x: placedLeft, y: placedTop };
    onPlaced({ x: corner.x - request.anchor.x, y: corner.y - request.anchor.y });
  }

  /** Drags the popover by its header; on release the offset snaps to where it stopped at the window's margin. */
  function beginMove(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const start = { ...offset };
    trackDrag(
      event,
      (dx, dy) => setOffset({ x: start.x + dx, y: start.y + dy }),
      () => {
        const { left: endLeft, top: endTop, shift: moved, slack: unused } = latestPlace.current;
        setOffset({ x: endLeft - origin.x - moved.x, y: endTop - origin.y - unused - moved.y });
        reportPlace();
      },
    );
  }

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
    textareaRef.current?.setSelectionRange(initialText.length, initialText.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const followEnd = useFollowScroll(scrollRef, contentRef, subSessionId);
  const subChatPromptHeight = useSettingsStore((state) => state.subChatPromptHeight);
  const setSubChatPromptHeight = useSettingsStore((state) => state.setSubChatPromptHeight);
  // The text area may take the popover's height but for its header, the input area's own chrome and a strip of the conversation.
  const heightDrag = useTextareaDrag(textareaRef, subChatPromptHeight, setSubChatPromptHeight, () => {
    const root = rootRef.current;
    const textarea = textareaRef.current;
    if (!root || !textarea) return 0;
    const chrome = root.offsetHeight - (scrollRef.current?.offsetHeight ?? 0) - textarea.offsetHeight;
    return size.height - chrome - MIN_MESSAGES_HEIGHT;
  });
  useAutoGrow(textareaRef, text, 5, heightDrag.minHeight);
  useReturnedPrompts(
    chat?.isBusy ?? false,
    queue,
    () => (subSessionId ? takeQueue(subSessionId) : []),
    (prompts) => setText((current) => appendPromptTexts(current, prompts)),
  );

  function takeBack(promptId: string, promptText: string) {
    if (!subSessionId) return;
    unqueuePrompt(subSessionId, promptId);
    setText((current) => appendPromptTexts(current, [{ id: promptId, text: promptText, images: [] }]));
  }

  function showInMainPane(id: string) {
    void selectSession(id);
    onClose();
  }

  /** Deletes the sub session with its history and closes the popover; the glyph on the selection disappears with it. */
  function deleteSubSession() {
    if (!subSessionId) return;
    setIsConfirmingDelete(false);
    void closeSession(subSessionId, "delete");
    onClose();
  }

  /** Asks before deleting unless the user turned the dialog off (see DeleteSessionDialog). */
  function requestDelete() {
    if (!subSessionId) return;
    if (useSettingsStore.getState().confirmSessionDelete) {
      setIsConfirmingDelete(true);
    } else {
      deleteSubSession();
    }
  }

  /** Sends the queued `prompt` at once, interrupting the running turn. */
  function sendQueuedNow(prompt: QueuedPrompt) {
    if (!subSessionId) return;
    unqueuePrompt(subSessionId, prompt.id);
    followEnd();
    void sendPromptNow(subSessionId, prompt.text, prompt.images);
  }

  /** Sends the question; while a turn of the sub session runs, it is queued instead, unless `sendsNow` interrupts the turn. */
  async function submit(sendsNow = false) {
    const trimmed = text.trim();
    if (!trimmed || (isBusy && !subSessionId)) return;
    setText("");
    setError(null);
    followEnd();
    if (subSessionId) {
      void (sendsNow ? sendPromptNow(subSessionId, trimmed) : sendPrompt(subSessionId, trimmed));
      return;
    }
    // The first question creates the session, which starts with the parent's agent setup and sends the question itself.
    setIsCreating(true);
    try {
      const parentSetup = parentChat ? agentSetupOf(parentChat) : { configValues: {}, modeId: "default" };
      const setup = pickedModel ? { ...parentSetup, configValues: { ...parentSetup.configValues, model: pickedModel } } : parentSetup;
      const id = await createSubSession(parentSessionId, titleFromPrompt(trimmed), request.selection, { setup, prompt: { text: trimmed, images: [] } }, false);
      setSubSessionId(id);
    } catch (reason) {
      setError(String(reason));
      setText(trimmed);
    } finally {
      setIsCreating(false);
    }
  }

  // Escape closes the popover like every floating surface; a running turn goes on and the glyph reopens the chat.
  const onEscapeRef = useRef(onClose);
  onEscapeRef.current = onClose;

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
  // it only moves the focus here, where the prompt answers the next Escape. The delete dialog takes its own Escape.
  useEffect(() => {
    if (isConfirmingDelete) return;
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
  }, [hasPermission, isConfirmingDelete]);

  // A mouse press outside every floating surface closes the popover as well.
  useEffect(() => {
    if (isConfirmingDelete) return;
    function onWindowMouseDown(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest(FLOATING_SURFACE)) return;
      onEscapeRef.current();
    }
    window.addEventListener("mousedown", onWindowMouseDown, true);
    return () => window.removeEventListener("mousedown", onWindowMouseDown, true);
  }, [isConfirmingDelete]);

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isShortcut(event, "chat.sendNow")) {
      event.preventDefault();
      if (text.trim()) {
        void submit(true);
      } else if (queue[0]) {
        sendQueuedNow(queue[0]);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const lines = describeLines(request.selection);
  /** A stopped sub session has nothing to show between the header and the footer. */
  const showsSelection = !subSessionId && !title;
  const showsContext = !subSessionId && Boolean(context?.text);
  const hasBody = showsSelection || showsContext || Boolean(chat && (chat.isLoading || chat.items.length || chat.permission || chat.error)) || Boolean(error);

  return (
    <div
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
      aria-label={title ?? `Sub chat about ${describeSelection(request.selection)}`}
      style={{ left, top, width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      className="chat fixed z-50 flex flex-col overflow-hidden rounded-xl border border-neutral-600 bg-(--surface-chat) text-sm shadow-2xl shadow-black/50 outline-none"
    >
      <header className="flex cursor-grab items-center gap-2 border-b border-(--line) pr-9 pl-12 py-2.5 select-none active:cursor-grabbing" onPointerDown={beginMove}>
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
            className={GHOST_BUTTON_XS}
            title="Show this sub chat in the main pane"
          >
            Open in sidebar
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={ICON_BUTTON_SM} title="Close (esc)" aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto px-12 ${hasBody ? "py-3" : ""}`}>
        <div ref={contentRef} className="flex flex-col gap-3">
          {showsSelection ? <SelectionCard selection={request.selection} isOpen label={lines} /> : null}
          {showsContext && context ? <ContextCard label={context.label} text={context.text} /> : null}
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
        <div className="relative border-t border-(--line) bg-(--surface-input) px-12 py-3">
          <QueuedPrompts queue={queue} shortcutLabel={text.trim() ? null : sendNowShortcut} onSendNow={sendQueuedNow} onTakeBack={(prompt) => takeBack(prompt.id, prompt.text)} />
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              disabled={Boolean(chat?.permission)}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onTextareaKeyDown}
              rows={1}
              placeholder={chat?.isBusy ? "Enter queues the question for after this turn" : subSessionId ? "Follow up…" : (placeholder ?? "Ask about the selected code…")}
              className="block min-w-0 flex-1 resize-none bg-transparent py-[calc((36px-1lh)/2)] outline-none placeholder:text-neutral-600 disabled:opacity-50"
            />
            {modelOption && model ? (
              <PillSelect
                title={modelOption.name}
                value={model}
                options={listChoiceOptions(modelOption)}
                onChange={changeModel}
                disabled={isCreating}
              />
            ) : null}
            {subSessionId ? (
              <button type="button" onClick={requestDelete} disabled={isCreating} title="Delete this sub chat" aria-label="Delete this sub chat" className={DANGER_CLEAR_BUTTON}>
                <TrashIcon />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!text.trim() || isCreating || hasPermission}
              title={chat?.isBusy ? "Queue for after this turn (enter); ⌘↩ sends now" : "Send (enter)"}
              className={SEND_BUTTON}
            >
              <SendIcon />
            </button>
          </div>
          <ResizeGrips edges={{ top: true }} {...heightDrag.grips} />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 border-t border-(--line) px-12 py-2 text-[13px] text-neutral-400">
          <span className="flex-1">Agent is not running.</span>
          <button type="button" onClick={requestDelete} title="Delete this sub chat" aria-label="Delete this sub chat" className={DANGER_CLEAR_BUTTON}>
            <TrashIcon />
          </button>
          <button type="button" disabled={isResuming} onClick={() => void resume()} className={PRIMARY_BUTTON_XS}>
            {isResuming ? "Resuming…" : "Resume"}
          </button>
        </div>
      )}
      {isConfirmingDelete && subSession ? (
        <DeleteSessionDialog question={`Delete sub session "${subSession.title}"?`} onConfirm={deleteSubSession} onClose={() => setIsConfirmingDelete(false)} />
      ) : null}
      <ResizeGrips
        edges={{ left: true, top: true, right: true, bottom: true }}
        {...grips}
        onEnd={() => {
          grips.onEnd();
          reportPlace();
        }}
      />
    </div>
  );
}
