import { useEffect, useRef, useState } from "react";
import { useIdeStore } from "../ide/ideStore";
import { useHuntStore } from "../state/store";
import { findSelectOption, listChoices, listModes } from "./configOptions";
import { MessageList } from "./MessageList";
import { PermissionPrompt } from "./PermissionPrompt";
import { PromptInput, type ConfigSelect } from "./PromptInput";
import { CLEAR_COMMAND } from "./slashCommands";
import { describeSelection, SelectionCard } from "./SelectionCard";
import { useFileIconUrl } from "../diff/fileIcons";
import { useFollowScroll } from "./useFollowScroll";
import { SessionSummary, SessionSummaryToggle } from "./SessionSummary";
import { useSettingsStore } from "../state/settings";
import { openGuardrailsWindow } from "../guardrails/openGuardrailsWindow";
import { ensureAdrInstruction } from "../guardrails/adrInstruction";
import { HEADER_BAR } from "../ui/bars";
import { PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { ShieldIcon } from "../ui/icons";
import { OpenInWebstormButton } from "./OpenInWebstormButton";

/** Order in which shift+tab cycles the session mode, as in the terminal; modes the agent does not offer are skipped. */
const MODE_CYCLE = ["default", "acceptEdits", "plan", "auto"];

/** Agent config options shown as dropdowns in the prompt toolbar, in display order. */
const TOOLBAR_CONFIG_IDS = ["model", "effort"];

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
  const showSummary = useSettingsStore((state) => state.showSummary);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [isVerbose, setIsVerbose] = useState(false);
  const hasSession = Boolean(session);
  const isBusy = chat?.isBusy ?? false;
  const hasPermission = Boolean(chat?.permission);
  const modeId = chat?.modeId ?? "default";
  const modes = listModes(chat?.configOptions ?? []);

  const configSelects: ConfigSelect[] = TOOLBAR_CONFIG_IDS.flatMap((id) => {
    const option = findSelectOption(chat?.configOptions ?? [], id);
    if (!option) return [];
    return [{ id, name: option.name, value: option.currentValue, choices: listChoices(option).map((choice) => ({ id: choice.value, name: choice.name })) }];
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
  const worktreePath = session?.worktreePath;
  useEffect(() => {
    if (!worktreePath) return;
    void ensureAdrInstruction(sessionId, worktreePath);
  }, [sessionId, worktreePath]);

  const followEnd = useFollowScroll(scrollRef, columnRef, `${sessionId}:${hasSession}`);

  if (!session) return null;

  /** Shows the lines the sub chat is about, selected, in the "Editor" tab. */
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
        <OpenInWebstormButton sessionId={sessionId} disabled={isCreating} />
        <button type="button" onClick={() => void openGuardrailsWindow(sessionId)} disabled={isCreating} className={SECONDARY_BUTTON_MD}>
          <ShieldIcon />
          Guardrails
        </button>
        <SessionSummaryToggle />
      </header>

      {showSummary ? <SessionSummary session={session} /> : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div ref={columnRef} className="chat-column">
          {chat?.isLoading ? <p className="text-neutral-500">Loading session…</p> : null}
          {session.selection ? (
            <div className="mb-5">
              <SelectionCard selection={session.selection} />
            </div>
          ) : null}
          <MessageList items={chat?.items ?? []} plan={chat?.plan ?? []} isBusy={isBusy || isCreating} isVerbose={isVerbose} basePath={session.worktreePath} />
          {chat?.permission ? (
            <PermissionPrompt
              permission={chat.permission}
              onAnswer={(optionId) => void answerPermission(sessionId, chat.permission!.requestId, optionId)}
            />
          ) : null}
          {chat?.error ? <div className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">{chat.error}</div> : null}
        </div>
      </div>

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
      {session.isLive ? (
        <PromptInput
          isBusy={isBusy}
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
          contextUsage={chat?.contextUsage}
        />
      ) : isCreating || chat?.isLoading ? (
        <div className="px-5 pb-4 pt-2">
          <div className="chat-column rounded-xl border border-(--line) bg-(--surface-inset) px-4 py-3 text-sm text-neutral-400">
            {isCreating && !session.parentId ? "Creating the worktree and starting the agent…" : "Starting the agent…"}
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
    </div>
  );
}
