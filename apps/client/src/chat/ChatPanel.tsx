import { useEffect, useRef, useState } from "react";
import { useIdeStore } from "../ide/ideStore";
import { useHuntStore } from "../state/store";
import { findSelectOption, listChoiceOptions, listModes } from "./configOptions";
import { MessageList } from "./MessageList";
import { PermissionPrompt } from "./PermissionPrompt";
import { PromptInput, type ConfigSelect } from "./PromptInput";
import { CLEAR_COMMAND } from "./slashCommands";
import { describeSelection, SelectionCard } from "./SelectionCard";
import { useFileIconUrl } from "../diff/fileIcons";
import { useFollowScroll } from "./useFollowScroll";
import { SessionSummary, SessionSummaryToggle } from "./SessionSummary";
import type { SelectionRequest } from "../diff/selectionContext";
import { useSettingsStore } from "../state/settings";
import { openGuardrailsWindow } from "../guardrails/openGuardrailsWindow";
import { ensureAdrInstruction } from "../guardrails/adrInstruction";
import { GUARDRAIL_CHAT_PATH, guardrailTask, KIND_LABELS, listGuardrails } from "../guardrails/guardrails";
import { buildGuardrailRequest, buildTranscript, findGuardrailSuggestion, transcriptTail } from "./guardrailSuggestion";
import { SubChatPopover, useSubChatPopover } from "./SubChatPopover";
import { SaveGuardrailButton } from "./SaveGuardrailButton";
import { ContextMeter } from "./ContextMeter";
import { HEADER_BAR } from "../ui/bars";
import { PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { ShieldIcon } from "../ui/icons";
import { OpenInWebstormButton } from "./OpenInWebstormButton";
import { RemoteMenu } from "./RemoteMenu";
import { moveStatus, REMOTE_STEP_LABELS } from "./remoteSession";

/** Order in which shift+tab cycles the session mode, as in the terminal; modes the agent does not offer are skipped. */
const MODE_CYCLE = ["default", "acceptEdits", "plan", "auto"];

/** Agent config options shown as dropdowns in the prompt toolbar, in display order. */
const TOOLBAR_CONFIG_IDS = ["model", "effort"];

/** Lines of this session's conversation the guardrail chat shows as the context its agent gets. */
const CONTEXT_PREVIEW_LINES = 8;

/** Gap between the guardrail chat and the "Guardrail" button below it when the chat opens at its default place. */
const GUARDRAIL_CHAT_GAP = 24;

/** Where the guardrail chat's bottom right corner goes: above the "Guardrail" button, moved by where the user last left it. */
function guardrailChatAnchor(bounds: DOMRect): SelectionRequest["anchor"] {
  const { x, y } = useSettingsStore.getState().guardrailChatOffset;
  return { x: bounds.right + x, y: bounds.top - GUARDRAIL_CHAT_GAP + y, corner: "bottomRight" };
}

export function ChatPanel({ sessionId }: { sessionId: string }) {
  const fileIconUrl = useFileIconUrl();
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const chat = useHuntStore((state) => state.chats[sessionId]);
  const isCreating = useHuntStore((state) => state.creatingIds.includes(sessionId));
  const sendPrompt = useHuntStore((state) => state.sendPrompt);
  const takeQueue = useHuntStore((state) => state.takeQueue);
  const unqueuePrompt = useHuntStore((state) => state.unqueuePrompt);
  const cancelPrompt = useHuntStore((state) => state.cancelPrompt);
  const setMode = useHuntStore((state) => state.setMode);
  const setConfigOption = useHuntStore((state) => state.setConfigOption);
  const answerPermission = useHuntStore((state) => state.answerPermission);
  const selectSession = useHuntStore((state) => state.selectSession);
  const setRightTab = useHuntStore((state) => state.setRightTab);
  const openFile = useIdeStore((state) => state.openFile);
  const guardrailChat = useSubChatPopover();
  const [guardrailRequest, setGuardrailRequest] = useState("");
  /** The end of this session's conversation, shown in the guardrail chat as the context its agent gets. */
  const [guardrailContext, setGuardrailContext] = useState("");
  const showSummary = useSettingsStore((state) => state.showSummary);
  const setGuardrailChatOffset = useSettingsStore((state) => state.setGuardrailChatOffset);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [isVerbose, setIsVerbose] = useState(false);
  const hasSession = Boolean(session);
  const isBusy = chat?.isBusy ?? false;
  const guardrailSuggestion = isBusy ? null : findGuardrailSuggestion(chat?.items ?? []);
  const hasPermission = Boolean(chat?.permission);
  const moveText = chat ? moveStatus(chat) : null;
  const modeId = chat?.modeId ?? "default";
  const modes = listModes(chat?.configOptions ?? []);

  const configSelects: ConfigSelect[] = TOOLBAR_CONFIG_IDS.flatMap((id) => {
    const option = findSelectOption(chat?.configOptions ?? [], id);
    if (!option) return [];
    return [{ id, name: option.name, value: option.currentValue, choices: listChoiceOptions(option) }];
  });

  function cycleMode() {
    if (!session?.isLive) return;
    const cycle = MODE_CYCLE.filter((id) => modes.some((mode) => mode.id === id));
    const index = cycle.indexOf(modeId);
    void setMode(sessionId, cycle[(index + 1) % cycle.length]);
  }

  // Terminal shortcuts: esc interrupts the turn, ctrl+o toggles verbose tool output, shift+tab cycles the mode.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isBusy && !hasPermission) {
        event.preventDefault();
        void cancelPrompt(sessionId);
      } else if (event.key.toLowerCase() === "o" && event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setIsVerbose((current) => !current);
      } else if (event.key === "Tab" && event.shiftKey && !hasPermission) {
        event.preventDefault();
        cycleMode();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Opening a session checks once that its CLAUDE.md points the agent at the ADR folder and offers to add the section.
  // A session still being created has no record in the backend yet, and a remote session no local files to read.
  const worktreePath = session?.remote ? undefined : session?.worktreePath;
  useEffect(() => {
    if (!worktreePath || isCreating) return;
    void ensureAdrInstruction(sessionId, worktreePath);
  }, [sessionId, worktreePath, isCreating]);

  const followEnd = useFollowScroll(scrollRef, columnRef, `${sessionId}:${hasSession}`);

  if (!session) return null;
  /** A remote session not connected right now takes prompts anyway: the first one starts its VM and connects. */
  const canPromptRemote = Boolean(session.remote) && !session.isLive && !isCreating && !chat?.isLoading;

  /** Shows the lines the sub chat is about, selected, in the "Editor" tab. */
  /**
   * Opens the guardrail sub chat right above the "Guardrail" button, flush with its right edge: its first question is
   * prefilled with the guardrail the agent suggested (or the bare request), and its agent gets the whole conversation
   * of this session as context.
   */
  async function openGuardrailChat(bounds: DOMRect) {
    const listing = await listGuardrails(sessionId, useSettingsStore.getState().guardrailDirs);
    const transcript = buildTranscript(chat?.items ?? []);
    const task = `${guardrailTask(listing)}\n\n## Conversation the guardrail comes from\nThe user opened this chat from the session below; use it as the context of the request.\n\n${transcript}`;
    setGuardrailContext(transcriptTail(transcript, CONTEXT_PREVIEW_LINES));
    setGuardrailRequest(buildGuardrailRequest(guardrailSuggestion, guardrailSuggestion ? KIND_LABELS[guardrailSuggestion.kind].singular : ""));
    guardrailChat.open({ selection: { path: GUARDRAIL_CHAT_PATH, startLine: 1, endLine: 1, text: "", task }, anchor: guardrailChatAnchor(bounds) });
  }

  function openSelectionInEditor() {
    if (!session?.selection) return;
    const { path, startLine, endLine } = session.selection;
    setRightTab("editor");
    openFile(sessionId, path, { line: startLine, endLine });
  }

  return (
    <div className="chat flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <header data-tauri-drag-region="" className={`${HEADER_BAR} gap-3 border-b border-(--line) px-4`}>
        <div data-tauri-drag-region="" className="min-w-0 flex-1">
          <div data-tauri-drag-region="" className="truncate text-sm font-semibold">{session.title}</div>
        </div>
        {session.remote ? null : <OpenInWebstormButton sessionId={sessionId} disabled={isCreating} />}
        <RemoteMenu sessionId={sessionId} />
        {session.remote ? null : (
          <button type="button" onClick={() => void openGuardrailsWindow(sessionId)} disabled={isCreating} className={SECONDARY_BUTTON_MD}>
            <ShieldIcon />
            Guardrails
          </button>
        )}
        <SessionSummaryToggle />
      </header>

      {showSummary ? <SessionSummary session={session} /> : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div ref={columnRef} className="chat-column">
          {session.selection ? (
            <div className="mb-5">
              <SelectionCard selection={session.selection} />
            </div>
          ) : null}
          <MessageList items={chat?.items ?? []} plan={chat?.plan ?? []} isBusy={(isBusy && !chat?.isHiddenTurn) || isCreating} isVerbose={isVerbose} basePath={session.remote?.worktreePath ?? session.worktreePath} />
          {chat?.isLoading ? <p className="text-neutral-500">{chat.remoteStep ? REMOTE_STEP_LABELS[chat.remoteStep] : "Loading session…"}</p> : null}
          {chat?.isLoading && chat.remoteDetail ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-snug text-neutral-500">{chat.remoteDetail}</pre>
          ) : null}
          {chat?.permission ? (
            <PermissionPrompt
              permission={chat.permission}
              onAnswer={(optionId) => void answerPermission(sessionId, chat.permission!.requestId, optionId)}
            />
          ) : null}
          {chat?.error ? <div className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">{chat.error}</div> : null}
        </div>
      </div>

      {moveText ? (
        <div className="px-9 pt-2">
          <p className="chat-column text-[13px] text-neutral-500">{moveText}</p>
        </div>
      ) : null}
      {session.isLive ? (
        <div className="px-9 pt-2">
          <div className="chat-column flex items-center gap-3">
            {chat?.contextUsage ? <ContextMeter usage={chat.contextUsage} /> : null}
            {session.remote ? null : <SaveGuardrailButton isSuggested={!!guardrailSuggestion} isDisabled={hasPermission} onOpen={(bounds) => void openGuardrailChat(bounds)} />}
          </div>
        </div>
      ) : canPromptRemote ? (
        <div className="px-9 pt-2">
          <p className="chat-column text-[13px] text-neutral-500">Runs on the VM {session.remote?.vm.instance}. Your next prompt starts the VM and connects again.</p>
        </div>
      ) : null}
      {session.selection ? (
        <div className="px-9 pt-2">
          <div className="chat-column flex items-center gap-3 rounded-xl border border-(--line) bg-(--surface-inset) px-4 py-2 text-[13px]">
            <img src={fileIconUrl(session.selection.path)} alt="" className="size-[18px] shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-neutral-300" title={describeSelection(session.selection)}>
              {describeSelection(session.selection)}
            </span>
            <button type="button" onClick={openSelectionInEditor} className={SECONDARY_BUTTON_XS} title="Show the selected lines in the Editor tab">
              Open in editor
            </button>
          </div>
        </div>
      ) : null}
      {session.isLive || canPromptRemote ? (
        <PromptInput
          isBusy={isBusy || Boolean(chat?.move)}
          isBlocked={hasPermission}
          queue={chat?.queue ?? []}
          onTakeQueue={() => takeQueue(sessionId)}
          onUnqueue={(promptId) => unqueuePrompt(sessionId, promptId)}
          modeId={modeId}
          modes={modes}
          configSelects={configSelects}
          commands={[CLEAR_COMMAND, ...(chat?.commands ?? [])]}
          onSend={(text, images) => {
            followEnd();
            void sendPrompt(sessionId, text, images);
          }}
          onClear={() => {
            followEnd();
            void sendPrompt(sessionId, "/clear");
          }}
          onCycleMode={cycleMode}
          onModeChange={(nextModeId) => void setMode(sessionId, nextModeId)}
          onConfigChange={(configId, value) => void setConfigOption(sessionId, configId, value)}
          pullRequest={session.pullRequest}
        />
      ) : isCreating || chat?.isLoading ? (
        <div className="px-5 pb-4 pt-2">
          <div className="chat-column rounded-xl border border-(--line) bg-(--surface-inset) px-4 py-3 text-sm text-neutral-400">
            {chat?.remoteStep
              ? REMOTE_STEP_LABELS[chat.remoteStep]
              : isCreating && !session.parentId
                ? "Creating the worktree and starting the agent…"
                : "Starting the agent…"}
          </div>
        </div>
      ) : (
        <div className="px-5 pb-4 pt-2">
          <div className="chat-column flex items-center justify-between rounded-xl border border-(--line) bg-(--surface-inset) px-4 py-3 text-sm text-neutral-400">
            <span>Agent is not running.</span>
            <button type="button" onClick={() => void selectSession(sessionId)} className={PRIMARY_BUTTON_MD}>
              Resume
            </button>
          </div>
        </div>
      )}
      {guardrailChat.shown ? (
        <SubChatPopover
          key={guardrailChat.shown.key}
          parentSessionId={sessionId}
          request={guardrailChat.shown.request}
          title="New guardrail"
          placeholder="Describe the guardrail you want: what should Claude know or do, and where?"
          context={{ label: "This conversation", text: guardrailContext }}
          initialText={guardrailRequest}
          onPlaced={(offset) => {
            const { x, y } = useSettingsStore.getState().guardrailChatOffset;
            setGuardrailChatOffset({ x: x + offset.x, y: y + offset.y });
          }}
          onClose={guardrailChat.close}
        />
      ) : null}
    </div>
  );
}
