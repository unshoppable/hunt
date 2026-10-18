import { useEffect, useRef, useState } from "react";
import { useIdeStore } from "../ide/ideStore";
import { hasPendingQuestion, useHuntStore } from "../state/store";
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
import { AGENT_CHIP, Chip } from "../ui/Chip";
import { PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { ShieldIcon } from "../ui/icons";
import { OpenInWebstormButton } from "./OpenInWebstormButton";
import { RemoteToggle } from "./RemoteToggle";
import { remoteDeleteQuestion } from "../sessions/remoteOrigin";
import { confirmDestructive } from "../ui/confirm";
import { continueLocallyQuestion, moveStatus, remoteOf, worktreeLock } from "./remoteSession";
import { RemoteRunStatus, RemoteStepProgress } from "./RemoteProgress";

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
  /** The VM the agent runs on; `null` for an agent on this Mac, which a sub chat's always is. */
  const remote = session?.remote ?? null;
  /** The VM the worktree lives on: the session's own, or its parent's for a sub chat; `null` for a local worktree. */
  const worktreeRemote = useHuntStore((state) => {
    const current = state.sessions.find((candidate) => candidate.id === sessionId);
    return current ? remoteOf(current, state.sessions) : null;
  });
  /** Why the local worktree is read-only while this Mac cannot sync with the VM; `null` while it may change. */
  const lock = useHuntStore((state) => worktreeLock(state.sessions, state.remoteLinks, sessionId));
  const chat = useHuntStore((state) => state.chats[sessionId]);
  const isCreating = useHuntStore((state) => state.creatingIds.includes(sessionId));
  const sendPrompt = useHuntStore((state) => state.sendPrompt);
  const sendPromptNow = useHuntStore((state) => state.sendPromptNow);
  const takeQueue = useHuntStore((state) => state.takeQueue);
  const unqueuePrompt = useHuntStore((state) => state.unqueuePrompt);
  const promptDraft = useHuntStore((state) => state.promptDrafts[sessionId]);
  const setPromptDraft = useHuntStore((state) => state.setPromptDraft);
  const cancelPrompt = useHuntStore((state) => state.cancelPrompt);
  const closeSession = useHuntStore((state) => state.closeSession);
  const resumeSession = useHuntStore((state) => state.resumeSession);
  const continueLocally = useHuntStore((state) => state.continueLocally);
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
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [isVerbose, setIsVerbose] = useState(false);
  const hasSession = Boolean(session);
  const isBusy = chat?.isBusy ?? false;
  const guardrailSuggestion = isBusy ? null : findGuardrailSuggestion(chat?.items ?? []);
  const hasQuestion = !!chat && !isCreating && hasPendingQuestion(chat);
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
    if (!session?.isLive || remote) return;
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
  // A session still being created has no record in the backend yet; an agent on a VM reads CLAUDE.md there only when it
  // starts, so the offer waits until the session runs here again.
  const worktreePath = remote ? undefined : session?.worktreePath;
  useEffect(() => {
    if (!worktreePath || isCreating) return;
    void ensureAdrInstruction(sessionId, worktreePath);
  }, [sessionId, worktreePath, isCreating]);

  const followEnd = useFollowScroll(scrollRef, columnRef, `${sessionId}:${hasSession}`);

  /** Deletes the remote session with its VM after confirmation; the sidebar's × only takes it out of the sidebar. */
  async function deleteRemoteSession() {
    const current = useHuntStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    if (!current?.remote || !(await confirmDestructive(remoteDeleteQuestion(current), "Delete"))) return;
    await closeSession(sessionId, "delete");
  }

  /** The remote session that owns the VM: this one, or the parent of a sub chat. */
  const ownerId = session?.parentId ?? sessionId;

  /** Continues the remote session, whose VM cannot be reached, on this Mac after confirmation. */
  async function continueOwnerLocally() {
    if (!(await confirmDestructive(continueLocallyQuestion(ownerId), "Continue locally"))) return;
    await continueLocally(ownerId);
  }

  if (!session) return null;
  /** A session whose agent runs on a VM takes prompts while not connected: the first one starts its VM and connects. */
  const canPromptRemote = Boolean(remote) && !session.isLive && !isCreating && !chat?.isLoading;

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
    <div ref={panelRef} className="chat flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <header data-tauri-drag-region="" className={`${HEADER_BAR} gap-3 border-b border-(--line) px-4`}>
        <div data-tauri-drag-region="" className="min-w-0 flex-1">
          <div data-tauri-drag-region="" className="truncate text-sm font-semibold">{session.title}</div>
        </div>
        {hasQuestion ? (
          <Chip className={AGENT_CHIP.question} title="The agent waits for your answer">
            Question
          </Chip>
        ) : null}
        {worktreeRemote ? null : <OpenInWebstormButton sessionId={sessionId} disabled={isCreating} />}
        <RemoteToggle sessionId={sessionId} />
        <button type="button" onClick={() => void openGuardrailsWindow(sessionId)} disabled={isCreating} className={SECONDARY_BUTTON_MD}>
          <ShieldIcon />
          Guardrails
        </button>
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
          <MessageList items={chat?.items ?? []} plan={chat?.plan ?? []} isBusy={(isBusy && !chat?.isHiddenTurn) || isCreating} isVerbose={isVerbose} basePath={remote?.worktreePath ?? session.worktreePath} />
          {chat?.isLoading ? (
            <div className="text-neutral-500">{chat.remoteStep ? <RemoteStepProgress chat={chat} showsDetail /> : <p>Loading session…</p>}</div>
          ) : null}
          {chat?.permission ? (
            <PermissionPrompt
              permission={chat.permission}
              onAnswer={(optionId) => void answerPermission(sessionId, chat.permission!.requestId, optionId)}
            />
          ) : null}
          {hasQuestion ? (
            <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-amber-200 break-words">The agent waits for your answer.</div>
          ) : null}
          {chat?.error ? <div className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">{chat.error}</div> : null}
          {session.remote && chat?.fileSync.error ? (
            <div className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">
              Syncing the files with the VM failed: {chat.fileSync.error}
            </div>
          ) : null}
          {session.remote && chat?.fileSync.conflicts.length ? (
            <div className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-amber-200 break-words">
              These files do not sync with the VM until both sides agree:
              <ul className="mt-1 list-disc pl-5">
                {chat.fileSync.conflicts.map((conflict) => (
                  <li key={conflict}>{conflict}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {lock ? (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-amber-200">
              <span className="min-w-0 break-words">
                {lock === "vmRunning"
                  ? "Not connected to the VM. Local files are read-only while the agent may be working there."
                  : "The VM cannot be reached. Local files are read-only so that this Mac and the VM cannot diverge."}
              </span>
              <button
                type="button"
                onClick={() => void (lock === "vmRunning" ? resumeSession(ownerId) : continueOwnerLocally())}
                disabled={isCreating || Boolean(chat?.isLoading) || Boolean(chat?.move)}
                className={SECONDARY_BUTTON_XS}
              >
                {lock === "vmRunning" ? "Connect" : "Continue locally"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {moveText ? (
        <div className="px-9 pt-2">
          <div className="chat-column text-[13px] text-neutral-500">
            {chat?.remoteStep ? <RemoteStepProgress chat={chat} /> : null}
            <p className={chat?.remoteStep ? "mt-1.5" : ""}>{moveText}</p>
          </div>
        </div>
      ) : null}
      {session.isLive ? (
        <div className="px-9 pt-2">
          <div className="chat-column flex items-center gap-3">
            {chat?.contextUsage ? <ContextMeter usage={chat.contextUsage} /> : null}
            <SaveGuardrailButton isSuggested={!!guardrailSuggestion} isDisabled={hasPermission} onOpen={(bounds) => void openGuardrailChat(bounds)} />
          </div>
        </div>
      ) : canPromptRemote ? (
        <div className="px-9 pt-2">
          <p className="chat-column text-[13px] text-neutral-500">
            Runs on the VM {remote?.vm.instance}. Your next prompt starts the VM and connects again; files you change here meanwhile
            go to the VM then and win over the agent's changes to the same files.
          </p>
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
        // Keyed by the session so that a switch shows the other session's own draft instead of carrying this one over.
        <PromptInput
          key={sessionId}
          initialDraft={promptDraft}
          onDraftChange={(draft) => setPromptDraft(sessionId, draft)}
          isBusy={isBusy || Boolean(chat?.move)}
          isBlocked={hasPermission}
          queue={chat?.queue ?? []}
          onTakeQueue={() => takeQueue(sessionId)}
          onUnqueue={(promptId) => unqueuePrompt(sessionId, promptId)}
          modeId={remote ? null : modeId}
          modes={modes}
          configSelects={configSelects}
          commands={[CLEAR_COMMAND, ...(chat?.commands ?? [])]}
          onSend={(text, images) => {
            followEnd();
            void sendPrompt(sessionId, text, images);
          }}
          onSendNow={(text, images) => {
            followEnd();
            void sendPromptNow(sessionId, text, images);
          }}
          onClear={() => {
            followEnd();
            void sendPrompt(sessionId, "/clear");
          }}
          onDelete={session.remote && !session.parentId ? () => void deleteRemoteSession() : undefined}
          onCycleMode={cycleMode}
          onModeChange={(nextModeId) => void setMode(sessionId, nextModeId)}
          onConfigChange={(configId, value) => void setConfigOption(sessionId, configId, value)}
          pullRequest={session.pullRequest}
          dropZoneRef={panelRef}
        />
      ) : isCreating || chat?.isLoading ? (
        <div className="px-5 pb-4 pt-2">
          <div className="chat-column rounded-xl border border-(--line) bg-(--surface-inset) px-4 py-3 text-sm text-neutral-400">
            {chat?.remoteStep
              ? <RemoteRunStatus chat={chat} />
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
