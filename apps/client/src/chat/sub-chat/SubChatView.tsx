import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useAgentDefaultsStore } from "../agent-defaults.store";
import { useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../../sessions/hunt.store";
import { agentSetupOf } from "../../sessions/session.store-slice";
import type { QueuedPrompt, SessionChat } from "../chat.store-slice";
import { DeleteSessionDialog } from "../../sessions/DeleteSessionDialog";
import { PopupModeButton, PopupWindowTitleBar } from "../../ui/PopupTitleBar";
import { findSelectOption, listChoiceOptions } from "../config-options.utils";
import { MessageList } from "../messages/MessageList";
import type { FileTarget } from "../change-references.utils";
import { useFileIndex } from "../file-index.hook";
import { useFileModelLoader } from "../file-model.hook";
import { FileModelContext } from "../../editor/highlighted-code.hook";
import { openInEditorWindow } from "../../ide/editor-window.utils";
import { commands } from "../../ipc/commands";
import type { ConfigSelect } from "../prompt/PromptInput";
import { PermissionPrompt } from "../PermissionPrompt";
import { appendPromptTexts, useReturnedPrompts } from "../prompt/QueuedPrompts";
import { ContextCard, ContextSummaryCard, describeLines, describeSelection, SelectionCard } from "../SelectionCard";
import { SuggestedGuardrailCard } from "../guardrail/SuggestedGuardrailCard";
import { useFollowScroll } from "../follow-scroll.hook";
import { useVmConnect } from "../../sessions/remote/vm-connect.hook";
import { titleFromPrompt } from "../../sessions/session-labels.utils";
import { showSessionInMainWindow } from "../../sessions/show-session.hook";
import { DANGER_CLEAR_BUTTON, ICON_BUTTON_SM, ICON_BUTTON_XS, PRIMARY_BUTTON_XS } from "../../ui/buttons.constants";
import { CloseIcon, LinkIcon, TrashIcon } from "../../ui/Icons";
import { baseName } from "../../common/path/path.utils";
import { useFileIconUrl } from "../../ui/file-icons/file-icons.hook";
import { ResizeGrips } from "../../ui/ResizeGrips";
import { useAutoGrow, useTextareaDrag } from "../../ui/auto-grow.hook";
import { isShortcut } from "../../ui/shortcuts.utils";
import type { SubChatPopoverProps } from "./SubChatPopover";
import { SubChatComposer } from "./SubChatComposer";
import { useSubChatPlacement } from "./sub-chat-placement.hook";

/** Height the conversation keeps when the text area is dragged taller. */
const MIN_MESSAGES_HEIGHT = 80;
/**
 * Floating surfaces of the window (popovers, menus, dialogs) and buttons that toggle the popover; a mouse press on
 * one of them does not close it.
 */
const FLOATING_SURFACE = '[role="dialog"], [role="menu"], [role="listbox"], [data-popover-toggle]';
/** Agent config options the footer offers, in display order. */
const FOOTER_CONFIG_IDS = ["model", "effort"];

/** The parent's agent settings a new sub chat starts from; a popup window has no chat of the parent and gets them from its host. */
export type ParentAgent = Pick<SessionChat, "configOptions" | "modeId">;

export type SubChatViewProps = Omit<SubChatPopoverProps, "onAccept"> & {
  isDetached: boolean;
  /** Overrides the parent's chat in this window's store. */
  parentAgent?: ParentAgent | null;
  /** The `messageId` of the prompt below which the conversation draws its "unread" line; `null` without one. */
  unreadAfterMessageId?: string | null;
  /** Called once the first question created the sub session. */
  onCreated: (subSessionId: string) => void;
};

/**
 * Chat about a code selection. A new sub session is created with the first question, takes over the parent chat's
 * agent settings and mode, and then behaves like any session: it runs in the background, shows up under its parent in
 * the sidebar and can be opened there in full. Closing keeps the session, and the glyph on the selection's first line
 * reopens it with the whole conversation. The model and effort pills in the footer switch those of the existing sub
 * chat or pick them for a new one; either way every later session and sub chat starts with them. Dragging the top edge of the input area makes the text area taller at the expense of
 * the conversation, remembered until it is dragged back to one line. A question sent while a turn runs is queued for
 * the end of that turn.
 * Inside the app it floats at the selection: Escape and a mouse press outside every floating surface close it, and it
 * is resized by dragging its edges (the size is remembered across sessions); until it is dragged taller, it is as tall
 * as its content, up to the remembered height. `isDetached` fills a popup window instead, which only its own Escape,
 * ⌘W and traffic light close.
 */
export function SubChatView({
  parentSessionId,
  request,
  subSessionId: initialSubSessionId,
  title,
  placeholder,
  context,
  suggestedGuardrail,
  initialText = "",
  isDetached,
  parentAgent,
  unreadAfterMessageId = null,
  onPlaced,
  onDecline,
  onCreated,
  onClose,
}: SubChatViewProps) {
  const [subSessionId, setSubSessionId] = useState<string | null>(initialSubSessionId ?? null);
  const [text, setText] = useState(initialText);
  const [isCreating, setIsCreating] = useState(false);
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
  const closeSession = useHuntStore((state) => state.closeSession);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const chat = useHuntStore((state) => (subSessionId ? state.chats[subSessionId] : undefined));
  const storedParentChat = useHuntStore((state) => state.chats[parentSessionId]);
  const parentChat = parentAgent ?? storedParentChat;
  const subSession = useHuntStore((state) => state.sessions.find((session) => session.id === subSessionId));
  const parent = useHuntStore((state) => state.sessions.find((session) => session.id === parentSessionId));
  // A remote session's worktree that is locked for want of a connection connects on its own while the popover is open.
  useVmConnect(parentSessionId);
  // The sub chat works in its parent's worktree; the files its replies name open in the parent's editor window.
  const fileIndex = useFileIndex(subSessionId);
  const openFile = useCallback(
    (target: FileTarget) => void openInEditorWindow(parentSessionId, { path: target.path, line: target.startLine }),
    [parentSessionId],
  );
  const readFile = useCallback((path: string) => commands.readFile(parentSessionId, path), [parentSessionId]);
  const loadFileModel = useFileModelLoader(parentSessionId, parent?.remote ? undefined : parent?.worktreePath);
  const isBusy = isCreating || (chat?.isBusy ?? false);
  const isLive = !subSessionId || (subSession?.isLive ?? false);
  const [isResuming, setIsResuming] = useState(false);
  const queue = chat?.queue ?? [];

  // The sub session's own options once it announced them, before that the parent's, in a secondary window without
  // the parent's chat the options the agent announced last.
  const configOptions = [chat?.configOptions, parentChat?.configOptions, knownOptions].find((options) => options?.length) ?? [];
  const preferred = useAgentDefaultsStore((state) => state.preferred);
  const pickConfig = useAgentDefaultsStore((state) => state.pickConfig);
  // An existing sub chat shows its own values; a new one the values picked last anywhere while the agent still offers
  // them, else the parent's.
  const configSelects: ConfigSelect[] = FOOTER_CONFIG_IDS.flatMap((id) => {
    const option = findSelectOption(configOptions, id);
    if (!option) return [];
    const choices = listChoiceOptions(option);
    const picked = preferred[id];
    const value = !subSessionId && picked && choices.some((choice) => choice.id === picked) ? picked : option.currentValue;
    return [{ id, name: option.name, value, choices }];
  });

  /** Remembers a footer pick and applies it to an existing sub session one change after the other, the model switch first. */
  async function changeConfig(configId: string, value: string) {
    const model = configSelects.find((select) => select.id === "model")?.value ?? null;
    const changes = pickConfig(configId, value, model);
    if (!subSessionId) return;
    for (const [changedId, changedValue] of changes) {
      await setConfigOption(subSessionId, changedId, changedValue);
    }
  }

  const { size, isHeightSet, grips, left, top, reportPlace, beginMove } = useSubChatPlacement(request.anchor, rootRef, onPlaced);

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
    return (isDetached ? root.offsetHeight : size.height) - chrome - MIN_MESSAGES_HEIGHT;
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

  /** Shows the sub chat in the main window's chat pane, also from a secondary window, and closes the popover. */
  function jumpToChat(id: string) {
    showSessionInMainWindow(id);
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
    // The first question creates the session, which starts with the parent's agent setup and the footer's values and
    // sends the question itself.
    setIsCreating(true);
    try {
      const parentSetup = parentChat ? agentSetupOf(parentChat) : { configValues: {}, modeId: "default" };
      const footerValues = Object.fromEntries(configSelects.map((select) => [select.id, select.value]));
      const setup = { ...parentSetup, configValues: { ...parentSetup.configValues, ...footerValues } };
      const id = await createSubSession(parentSessionId, titleFromPrompt(trimmed), request.selection, { setup, prompt: { text: trimmed, images: [] } }, false);
      setSubSessionId(id);
      onCreated(id);
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
    if (isDetached) {
      // The window's own Escape closes it (see PopupWindow.tsx), except while the permission prompt reads its keys from this element.
      if (event.key === "Escape" && chat?.permission) {
        event.stopPropagation();
      }
      return;
    }
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
    if (isConfirmingDelete || isDetached) return;
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
  }, [hasPermission, isConfirmingDelete, isDetached]);

  // A mouse press outside every floating surface closes the popover as well.
  useEffect(() => {
    if (isConfirmingDelete || isDetached) return;
    function onWindowMouseDown(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest(FLOATING_SURFACE)) return;
      onEscapeRef.current();
    }
    window.addEventListener("mousedown", onWindowMouseDown, true);
    return () => window.removeEventListener("mousedown", onWindowMouseDown, true);
  }, [isConfirmingDelete, isDetached]);

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

  const fileIconUrl = useFileIconUrl();
  const isFolder = !!request.selection.isFolder;
  /** What the header names: the selected lines, or the folder of a chat about a whole folder. */
  const subject = isFolder ? `${baseName(request.selection.path)}/` : describeLines(request.selection);
  const fullSubject = isFolder ? `${request.selection.path}/` : describeSelection(request.selection);
  /**
   * The selected code stays above the conversation, collapsed when an existing sub chat is reopened; a folder has no
   * selected text, and a `title` says what the chat is about instead.
   */
  const showsSelection = !title && !isFolder;
  const showsContext = !subSessionId && Boolean(context?.text);
  const showsSuggestedGuardrail = !subSessionId && Boolean(suggestedGuardrail);
  const hasBody = showsSelection || showsSuggestedGuardrail || showsContext || Boolean(chat && (chat.isLoading || chat.items.length || chat.permission || chat.error)) || Boolean(error);
  const heading = (
    <>
      {title ? (
        <span className="min-w-0 truncate text-[13px] text-neutral-400" title={fullSubject}>
          {title}
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-neutral-400" title={fullSubject}>
          <span className="shrink-0">Sub chat about</span>
          {isFolder ? (
            <span className="min-w-0 truncate font-mono text-neutral-300">{subject}</span>
          ) : (
            <>
              <img src={fileIconUrl(request.selection.path)} alt="" className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-neutral-200">{baseName(request.selection.path)}</span>
              <span className="shrink-0 font-mono text-neutral-300">{subject}</span>
            </>
          )}
        </span>
      )}
      {subSessionId && subSessionId !== activeSessionId ? (
        <button type="button" onClick={() => jumpToChat(subSessionId)} className={`${ICON_BUTTON_XS} shrink-0`} title="Jump to chat" aria-label="Jump to chat">
          <LinkIcon className="size-3.5" />
        </button>
      ) : null}
    </>
  );

  return (
    <div
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
      aria-label={title ?? `Sub chat about ${fullSubject}`}
      style={isDetached ? undefined : { left, top, width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
      onKeyDown={onKeyDown}
      // Inside the app the presses stay off the panes beneath; in a window they must reach Tauri's drag region handler.
      onMouseDown={isDetached ? undefined : (event) => event.stopPropagation()}
      className={`chat flex flex-col overflow-hidden bg-(--surface-chat) text-sm outline-none ${
        isDetached ? "h-screen" : "fixed z-50 rounded-xl border border-neutral-600 shadow-2xl shadow-black/50"
      }`}
    >
      {isDetached ? (
        <PopupWindowTitleBar popupKey="subChat">
          <div className="flex min-w-0 flex-1 items-center gap-2">{heading}</div>
        </PopupWindowTitleBar>
      ) : (
        <header className="flex cursor-grab items-center gap-2 border-b border-(--line) pr-9 pl-12 py-2.5 select-none active:cursor-grabbing" onPointerDown={beginMove}>
          {heading}
          <div className="ml-auto flex items-center gap-1">
            <PopupModeButton popupKey="subChat" isDetached={false} />
            <button type="button" onClick={onClose} className={ICON_BUTTON_SM} title="Close (esc)" aria-label="Close">
              <CloseIcon />
            </button>
          </div>
        </header>
      )}

      <div ref={scrollRef} className={`min-h-0 flex-1 overflow-y-auto px-12 ${hasBody ? "py-3" : ""}`}>
        <div ref={contentRef} className="flex flex-col gap-3">
          {showsSelection ? <SelectionCard selection={request.selection} isOpen={!initialSubSessionId} label={subject} /> : null}
          {showsSuggestedGuardrail && suggestedGuardrail ? <SuggestedGuardrailCard {...suggestedGuardrail} /> : null}
          {showsContext && context?.summary?.length ? <ContextSummaryCard label={context.label} lines={context.summary} /> : null}
          {showsContext && context ? <ContextCard label={context.label} text={context.text} /> : null}
          {chat?.isLoading ? <p className="text-neutral-500">Loading session…</p> : null}
          {chat ? (
            <FileModelContext value={loadFileModel}>
              <MessageList
                items={chat.items}
                plan={chat.plan}
                isBusy={chat.isBusy}
                isVerbose={false}
                basePath={parent?.worktreePath ?? ""}
                fileIndex={fileIndex}
                onOpenFile={openFile}
                readFile={readFile}
                unreadAfterMessageId={unreadAfterMessageId}
              />
            </FileModelContext>
          ) : null}
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
        <SubChatComposer
          textareaRef={textareaRef}
          text={text}
          onTextChange={setText}
          onTextareaKeyDown={onTextareaKeyDown}
          subSessionId={subSessionId}
          isTurnRunning={chat?.isBusy ?? false}
          isCreating={isCreating}
          hasPermission={hasPermission}
          placeholder={placeholder}
          queue={queue}
          onSendQueuedNow={sendQueuedNow}
          onTakeBack={(prompt) => takeBack(prompt.id, prompt.text)}
          configSelects={configSelects}
          onConfigChange={(configId, value) => void changeConfig(configId, value)}
          onDecline={onDecline}
          onDelete={requestDelete}
          onSubmit={() => void submit()}
          onClose={onClose}
          heightGrips={heightDrag.grips}
        />
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
      {isDetached ? null : (
        <ResizeGrips
          edges={{ left: true, top: true, right: true, bottom: true }}
          {...grips}
          onEnd={() => {
            grips.onEnd();
            reportPlace();
          }}
        />
      )}
    </div>
  );
}
