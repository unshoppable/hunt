import { create } from "zustand";
import type { ContentBlock, SessionConfigOption, SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { assetUrl, commands } from "../ipc/commands";
import type {
  AvailableCommand,
  ChatItem,
  ClosedEvent,
  HuntChunkMeta,
  PendingPermission,
  PermissionEvent,
  PermissionWithdrawnEvent,
  PlanEntry,
  PreviewStatus,
  PullRequestRef,
  RemoteProgressEvent,
  RemoteStep,
  RemoteSyncEvent,
  Screenshot,
  SelectionContext,
  SessionView,
  Workspace,
  SummaryEvent,
  ToolCallView,
} from "../ipc/types";
import { imageDataUrl, imagePlaceholder } from "../chat/imageData";
import { repoName } from "../ui/path";
import { titleFromPrompt } from "../sessions/sessionLabels";
import { HANDOFF_START_PROMPT, hasRunningService } from "../preview/services";
import { useAgentDefaultsStore } from "./agentDefaults";
import { usePlanUsageStore } from "./planUsage";
import { advanceRemoteRun, type RemoteRun } from "./remoteRun";
import { configuredVmSettings, useSettingsStore } from "./settings";

export type SessionMode = { id: string; name: string; description?: string | null };

/** Fill level of the agent's context window in tokens, as last reported by the agent. */
export type ContextUsage = { used: number; size: number };

/**
 * Views of the inspector pane: the changelist diff, the built-in editor, the component diagram or the reviewed pull
 * request, and for a remote session also its preview and a terminal on its VM.
 */
export type RightTab = "diff" | "editor" | "graph" | "pullRequest" | "preview" | "terminal";

/** The sync of a remote session's files with its VM: whether one runs, when the last one succeeded and what the last one failed with. */
export type FileSync = { isRunning: boolean; syncedAt: string | null; error: string | null };

/** The last adoption of session VMs (see `syncRemoteSessions`): whether one runs and what the last one failed with. */
export type RemoteSync = { isRunning: boolean; error: string | null };

/** Text and screenshots of a prompt before it is sent. */
export type PromptDraft = { text: string; images: Screenshot[] };

/** A prompt sent while the agent was busy; it waits in the chat's queue and is sent once the running turn ends. */
export type QueuedPrompt = PromptDraft & { id: string };

/** Agent settings a new session starts with: the value of every select option by option id, and the mode. */
export type AgentSetup = { configValues: Record<string, string>; modeId: string };

/** What a new session starts with: the agent setup, applied first, and the prompt shown in its chat at once and sent as soon as the agent runs. */
export type SessionStart = { setup: AgentSetup; prompt: PromptDraft | null };

/**
 * Where a new top-level session works: a worktree off `baseRef` of the repository (for a pull request review on the
 * pull request's branch), or the repository's own checkout, where `baseRef` is its current branch.
 */
export type WorktreeTarget = {
  repoPath: string;
  baseRef: string;
  workspace: Workspace;
  /** Marks the session as the review of that pull request; `diffBaseRef` is then its target branch. */
  pullRequest: PullRequestRef | null;
  diffBaseRef: string | null;
  /**
   * The pull request's own branch, which a review worktree works on instead of a new branch; `baseRef` names it
   * locally or on a remote (`origin/<branch>`).
   */
  pullRequestBranch: string | null;
};

/** The agent setup a chat currently runs with, so a sub session can start like its parent. */
export function agentSetupOf(chat: SessionChat): AgentSetup {
  const configValues: Record<string, string> = {};
  for (const option of chat.configOptions) {
    if (option.type !== "select") continue;
    configValues[option.id] = option.currentValue;
  }
  return { configValues, modeId: chat.modeId };
}

/**
 * The listing of a session whose creation is still running in the backend: everything the UI knows already, with
 * the fields the backend fills in (worktree, branch, commits) left blank until the stored record replaces it.
 */
function placeholderSession(id: string, title: string, target: WorktreeTarget, parent: SessionView | null, selection: SelectionContext | null): SessionView {
  return {
    id,
    title,
    repoPath: target.repoPath,
    worktreePath: parent?.worktreePath ?? (target.workspace === "checkout" ? target.repoPath : ""),
    branch: parent?.branch ?? target.pullRequestBranch ?? "",
    baseRef: target.baseRef,
    baseCommit: parent?.baseCommit ?? "",
    acpSessionId: null,
    createdAt: new Date().toISOString(),
    isLive: false,
    parentId: parent ? (parent.parentId ?? parent.id) : null,
    selection,
    summary: [],
    touchedFiles: [],
    worktreeChangedAt: null,
    pullRequest: target.pullRequest,
    diffBase: null,
    reviewComments: [],
    workspace: target.workspace,
    keepsBranch: false,
    remote: null,
    leftoverVm: null,
    dependencies: null,
    hasLocalWorktree: false,
  };
}

/** Full mode catalog of claude-agent-acp, used until the agent announces its `mode` config option; `current_mode_update` keeps the selection in sync. */
export const SESSION_MODES: SessionMode[] = [
  { id: "default", name: "Manual", description: "Always ask before making changes" },
  { id: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
  { id: "plan", name: "Plan", description: "Create a plan before making changes" },
  { id: "auto", name: "Auto", description: "Claude handles permission decisions" },
  { id: "bypassPermissions", name: "Bypass permissions", description: "Accepts all permissions" },
];

export type SessionChat = {
  items: ChatItem[];
  plan: PlanEntry[];
  commands: AvailableCommand[];
  modeId: string;
  /** Agent-side settings such as model and effort, as advertised by the agent. */
  configOptions: SessionConfigOption[];
  permission: PendingPermission | null;
  /** Unknown until the agent finished its first turn. */
  contextUsage: ContextUsage | null;
  isBusy: boolean;
  /**
   * Prompts sent while a turn was running, in sending order; each one starts the next turn as soon as the previous
   * turn ends. A stopped or failed turn leaves them here for the composer to take back.
   */
  queue: QueuedPrompt[];
  /** Whether a turn finished while the session was not the active one and the user has not opened it since. */
  hasUnseenActivity: boolean;
  isLoading: boolean;
  error: string | null;
  /** Bumped whenever the agent finished an edit or a turn so the diff panel refetches. */
  editVersion: number;
  /** Bumped when the watcher reports a rewritten graph file. */
  graphVersion: number;
  /** A diagram refresh turn is running; the graph panel shows it as generating. */
  isGeneratingGraph: boolean;
  /**
   * Whether the latest turn is one Hunt sent itself (a diagram refresh). The chat shows neither its prompt nor its
   * output nor a working indicator; the next turn of the user ends it.
   */
  isHiddenTurn: boolean;
  /**
   * Whether `items` hold the whole conversation. False for a chat record that live events or `ensureChat` created
   * ahead of `loadHistory`, which then still rebuilds it from the backend.
   */
  hasHistory: boolean;
  /** The step a handoff, retrieval or connect of a remote session is at; `null` while none runs. */
  remoteStep: RemoteStep | null;
  /** The gateway's last log line about `remoteStep`; `null` while it sent none. */
  remoteDetail: string | null;
  /** The steps and run time of the remote operation, or of the move, that runs; `null` while none runs. */
  remoteRun: RemoteRun | null;
  /** The items show the conversation from before a restart of the agent; its first update replaces them (see `restartChat`). */
  isStale: boolean;
  /** The move to or from the VM the user asked for, from the click until it ended; `null` while none is asked for. */
  move: SessionMove | null;
  /** The file sync of a remote session; idle for a local one. */
  fileSync: FileSync;
};

/** Where a session moves: to a VM of its own (`handOff`) or back into its local worktree (`retrieve`). */
export type SessionMove = "handOff" | "retrieve";

type HuntState = {
  sessions: SessionView[];
  /** Ids of listed sessions whose creation (worktree, agent) still runs in the backend; they have no worktree or agent yet. */
  creatingIds: string[];
  /** Ids of sessions already taken off the list whose deletion (agent, worktree, branch) still runs in the backend. */
  removingIds: string[];
  activeSessionId: string | null;
  chats: Record<string, SessionChat>;
  rightTab: RightTab;
  /**
   * Set while the chat pane shows the start view for a new session; `parentId` names the session a sub session is
   * drafted for. A failed creation brings the view back with its `error` and the `prompt` that was not sent.
   */
  draft: { parentId: string | null; error?: string; prompt?: PromptDraft | null } | null;
  /** Ids of sessions created without a prompt, titled after their repository until their first prompt names them. */
  untitledIds: string[];
  remoteSync: RemoteSync;

  /** Reloads the stored sessions; a session still being created stays listed until the backend lists it itself. */
  refreshSessions: () => Promise<void>;
  /**
   * Adopts the session VMs no local session knows (started by the swf poller or another person's Hunt) as remote
   * sessions, in the local checkout of their repository among the recently used ones. Does nothing while the remote
   * settings are incomplete or an adoption runs; a failure lands in `remoteSync.error`.
   */
  syncRemoteSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  /** Starts the agent of a stopped session again; its chat starts empty because the agent's conversation is gone. */
  resumeSession: (id: string) => Promise<void>;
  /** Starts the conversation over (`/clear`): the agent is restarted with a new, empty conversation. */
  clearSession: (id: string) => Promise<void>;
  /**
   * Hands the session off to the VM from the settings once its agent finished the running turn; the VM comes up
   * meanwhile. The chat starts over and fills again from the relay's replay.
   */
  handOffSession: (id: string) => Promise<void>;
  /**
   * Brings a remote session back into its local worktree once its agent finished the running turn; the chat starts over
   * and fills again from the local agent.
   */
  retrieveSession: (id: string) => Promise<void>;
  /** Opens the start view in which the first prompt or the choice of a repository creates the session, or a sub session of `parentId`. */
  startDraft: (parentId?: string) => void;
  /**
   * Creates a session in a fresh worktree of `target` and makes it the active session at once; the worktree and the
   * agent come up in the background, then `start` is applied. A `null` title names the session after its repository
   * until its first prompt names it. Resolves with the id once the backend created the session and rejects with the
   * error when it could not; the start view then comes back with the error and the prompt.
   */
  createSession: (target: WorktreeTarget, title: string | null, start: SessionStart) => Promise<string>;
  /**
   * Starts a sub session in the parent's worktree, listed under the parent at once (and active with `isActivated`);
   * the agent comes up in the background, then `start` is applied. A `null` title names the session after its
   * repository until its first prompt names it. Resolves with the id once the backend created the session and rejects
   * with the error when it could not.
   */
  createSubSession: (parentId: string, title: string | null, selection: SelectionContext | null, start: SessionStart, isActivated: boolean) => Promise<string>;
  /**
   * Stops the agent and, with `removeWorktree`, deletes the session together with its sub sessions. A deleted session
   * leaves the list at once while the backend still cleans up; a failed deletion lists it again with the error in its
   * chat. A session still being created cannot be closed.
   */
  closeSession: (id: string, removeWorktree: boolean) => Promise<void>;
  /** Rebuilds the chat of a live session from the backend's history when this store has none (after a webview reload). */
  loadHistory: (id: string) => Promise<void>;
  /**
   * Sends `text` with `images` as one turn. While a turn is running or the session moves, the prompt is queued instead
   * and sent once the running turn or the move ended; the returned promise then resolves at once. `/clear` starts the
   * conversation over instead.
   */
  sendPrompt: (id: string, text: string, images?: Screenshot[]) => Promise<void>;
  /** Takes every queued prompt out of the queue and returns them, for the composer to show them again. */
  takeQueue: (id: string) => QueuedPrompt[];
  /** Takes the queued prompt `promptId` out of the queue. */
  unqueuePrompt: (id: string, promptId: string) => void;
  /** Asks the agent for a fresh component diagram as a hidden turn (see `SessionChat.isHiddenTurn`). */
  refreshGraph: (id: string) => Promise<void>;
  cancelPrompt: (id: string) => Promise<void>;
  setMode: (id: string, modeId: string) => Promise<void>;
  setConfigOption: (id: string, configId: string, value: string) => Promise<void>;
  answerPermission: (id: string, requestId: string, optionId: string) => Promise<void>;
  setRightTab: (tab: RightTab) => void;
  /** Bumps `editVersion` after a local write to the worktree (a save in the diff or editor pane) so every view reloads. */
  noteWorktreeChanged: (id: string) => void;
  /** Creates the empty chat record of `id` when there is none, so worktree-change events reach a window that shows the session without its chat (the editor window). */
  ensureChat: (id: string) => void;

  applyUpdate: (huntSessionId: string, notification: SessionNotification) => void;
  applyPermission: (event: PermissionEvent) => void;
  /** Drops the chat's permission request when it is the withdrawn one. */
  applyPermissionWithdrawn: (event: PermissionWithdrawnEvent) => void;
  applyClosed: (event: ClosedEvent) => void;
  applyRemoteProgress: (event: RemoteProgressEvent) => void;
  /** Records the state of a remote session's file sync; a sync that changed local files reloads the views. */
  applyRemoteSync: (event: RemoteSyncEvent) => void;
  applyGraphChanged: (huntSessionId: string) => void;
  applySummary: (event: SummaryEvent) => void;
  /** Reloads the changes of every open session that works in the worktree a tool call just changed. */
  applyAttributionChanged: (worktreePath: string) => void;
};

export function createEmptyChat(): SessionChat {
  return {
    items: [],
    plan: [],
    commands: [],
    modeId: "default",
    configOptions: [],
    permission: null,
    contextUsage: null,
    isBusy: false,
    queue: [],
    hasUnseenActivity: false,
    isLoading: false,
    error: null,
    editVersion: 0,
    graphVersion: 0,
    isGeneratingGraph: false,
    isHiddenTurn: false,
    hasHistory: false,
    remoteStep: null,
    remoteDetail: null,
    remoteRun: null,
    isStale: false,
    move: null,
    fileSync: { isRunning: false, syncedAt: null, error: null },
  };
}

/** The turn state the relay of a remote session reports in `_meta.hunt.turn` of a `session_info_update`, if any. */
function huntTurnOf(meta: unknown): "running" | "idle" | null {
  const turn = (meta as { hunt?: { turn?: unknown } } | null | undefined)?.hunt?.turn;
  return turn === "running" || turn === "idle" ? turn : null;
}

/** Stop reason the backend reports for a turn the user interrupted (the Debug form of the ACP `StopReason::Cancelled`). */
const CANCELLED_STOP_REASON = "Cancelled";

/** Whether `text` is the `/clear` command, which restarts the conversation instead of being sent to the agent. */
function isClearPrompt(text: string): boolean {
  return text.trim() === "/clear";
}

let itemCounter = 0;
function nextItemId(): string {
  itemCounter += 1;
  return `item-${itemCounter}`;
}

function describeContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return `[${block.name ?? block.uri}]`;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    default:
      return "";
  }
}

function appendThought(items: ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "thought") {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { kind: "thought", id: nextItemId(), text }];
}

/** A user turn or an agent reply: the items that show images next to their text. */
type MessageItem = Extract<ChatItem, { kind: "user" | "agent" }>;

/** `message` with `block` added; an image block adds its data URL, or its placeholder text when the chat does not show it. */
function withBlock(message: MessageItem, block: ContentBlock): MessageItem {
  if (block.type !== "image") return { ...message, text: message.text + describeContentBlock(block) };
  const url = imageDataUrl(block);
  return url ? { ...message, images: [...message.images, url] } : { ...message, text: message.text + imagePlaceholder(block) };
}

/** Adds one block to the last item when it is a message of `kind`, or starts a new message of `kind` with it. */
function appendMessageBlock(items: ChatItem[], kind: MessageItem["kind"], block: ContentBlock): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === kind) return [...items.slice(0, -1), withBlock(last, block)];
  return [...items, withBlock({ kind, id: nextItemId(), text: "", images: [] }, block)];
}

/** Adds one block of a user turn to the last user item; an image block becomes a data URL the bubble can show. */
function appendUserBlock(items: ChatItem[], block: ContentBlock): ChatItem[] {
  // A resource block is the file content Hunt attaches to a prompt (see the backend's `send_prompt`), not something the user typed.
  if (block.type === "resource") return items;
  return appendMessageBlock(items, "user", block);
}

/** Updates that carry the agent's output for the running turn; the chat leaves them out of a turn Hunt sent itself. */
const TURN_OUTPUT_UPDATES = new Set<SessionNotification["update"]["sessionUpdate"]>(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

/** Whether a user message chunk belongs to a turn Hunt sent itself. */
function isHiddenChunk(meta: unknown): boolean {
  const chunkMeta = meta as HuntChunkMeta | null | undefined;
  // Turns replayed from a transcript older than the name Hunt still carry the meta under `harness`.
  const hunt = chunkMeta?.hunt ?? chunkMeta?.harness;
  return Boolean(hunt?.hidden);
}

function toToolCallView(toolCall: ToolCall): ToolCallView {
  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    kind: toolCall.kind ?? "other",
    status: toolCall.status ?? "pending",
    content: toolCall.content ?? [],
    locations: toolCall.locations ?? [],
    rawInput: toolCall.rawInput,
    rawOutput: toolCall.rawOutput,
  };
}

type TerminalMeta = {
  terminal_output?: { data?: unknown } | string;
  terminal_exit?: { exit_code?: number | null; signal?: string | null };
};

/** claude-agent-acp puts Bash output into `_meta.terminal_output` when the client opted in. */
function readTerminalOutput(update: ToolCallUpdate): string | undefined {
  const meta = update._meta as TerminalMeta | undefined;
  const output = meta?.terminal_output;
  let text: string | undefined;
  if (typeof output === "string") {
    text = output;
  } else if (output && typeof output.data === "string") {
    text = output.data;
  }

  const exit = meta?.terminal_exit;
  if (exit && (exit.exit_code ?? null) !== null && exit.exit_code !== 0) {
    text = `${text ?? ""}\n[exit code ${exit.exit_code}]`;
  }
  return text;
}

function mergeToolCallUpdate(items: ChatItem[], update: ToolCallUpdate): ChatItem[] {
  const index = items.findIndex((item) => item.kind === "tool" && item.toolCall.toolCallId === update.toolCallId);
  const terminalOutput = readTerminalOutput(update);

  if (index === -1) {
    const toolCall: ToolCallView = {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? "other",
      status: update.status ?? "pending",
      content: update.content ?? [],
      locations: update.locations ?? [],
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
      terminalOutput,
    };
    return [...items, { kind: "tool", id: nextItemId(), toolCall }];
  }

  const existing = items[index] as Extract<ChatItem, { kind: "tool" }>;
  const toolCall: ToolCallView = {
    ...existing.toolCall,
    title: update.title ?? existing.toolCall.title,
    kind: update.kind ?? existing.toolCall.kind,
    status: update.status ?? existing.toolCall.status,
    content: update.content ?? existing.toolCall.content,
    locations: update.locations ?? existing.toolCall.locations,
    rawInput: update.rawInput ?? existing.toolCall.rawInput,
    rawOutput: update.rawOutput ?? existing.toolCall.rawOutput,
    terminalOutput: terminalOutput ?? existing.toolCall.terminalOutput,
  };
  const next = [...items];
  next[index] = { ...existing, toolCall };
  return next;
}

function reduceChat(chat: SessionChat, notification: SessionNotification): SessionChat {
  const update = notification.update;
  if (TURN_OUTPUT_UPDATES.has(update.sessionUpdate) && chat.isHiddenTurn) return chat;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      if (isHiddenChunk(update._meta)) return { ...chat, isHiddenTurn: true };
      return { ...chat, items: appendUserBlock(chat.items, update.content), isHiddenTurn: false };
    case "agent_message_chunk":
      return { ...chat, items: appendMessageBlock(chat.items, "agent", update.content) };
    case "agent_thought_chunk":
      return { ...chat, items: appendThought(chat.items, describeContentBlock(update.content)) };
    case "tool_call":
      return { ...chat, items: [...chat.items, { kind: "tool", id: nextItemId(), toolCall: toToolCallView(update) }] };
    case "tool_call_update": {
      const items = mergeToolCallUpdate(chat.items, update);
      const merged = items.find((item) => item.kind === "tool" && item.toolCall.toolCallId === update.toolCallId);
      const kind = merged?.kind === "tool" ? merged.toolCall.kind : "other";
      const isFinishedEdit = update.status === "completed" && (kind === "edit" || kind === "delete" || kind === "move");
      return { ...chat, items, editVersion: isFinishedEdit ? chat.editVersion + 1 : chat.editVersion };
    }
    case "plan":
      return { ...chat, plan: update.entries };
    case "available_commands_update":
      return { ...chat, commands: update.availableCommands };
    case "current_mode_update":
      return { ...chat, modeId: update.currentModeId };
    case "config_option_update": {
      // The `mode` option carries the current mode too, so a loaded session shows the mode its agent resumed in.
      const mode = update.configOptions.find((option) => option.id === "mode");
      return { ...chat, configOptions: update.configOptions, modeId: mode?.type === "select" ? mode.currentValue : chat.modeId };
    }
    case "usage_update":
      return { ...chat, contextUsage: { used: update.used, size: update.size } };
    case "session_info_update": {
      const turn = huntTurnOf(update._meta);
      if (!turn) return chat;
      // A turn that ends, whoever on the relay sent it, may have changed the worktree on the VM.
      const hasEnded = turn === "idle" && chat.isBusy;
      return { ...chat, isBusy: turn === "running", editVersion: hasEnded ? chat.editVersion + 1 : chat.editVersion };
    }
    default:
      return chat;
  }
}

export const useHuntStore = create<HuntState>((set, get, store) => {
  function updateChat(id: string, updater: (chat: SessionChat) => SessionChat) {
    set((state) => {
      const current = state.chats[id] ?? createEmptyChat();
      return { chats: { ...state.chats, [id]: updater(current) } };
    });
  }

  /** Keeps the slash commands of the session's chat for the start view of its repository. */
  function rememberCommandsOf(id: string) {
    const session = get().sessions.find((candidate) => candidate.id === id);
    const chatCommands = get().chats[id]?.commands;
    // An adopted remote session may have no local checkout to remember the commands for.
    if (!session?.repoPath || !chatCommands) return;
    useAgentDefaultsStore.getState().rememberCommands(session.repoPath, chatCommands);
  }

  /**
   * Shows `item` for the turn (none when it is shown already or the turn is hidden), runs `request` and marks the chat
   * busy meanwhile. A shown item ends a hidden turn before it. A turn that ends while another session is active leaves the chat marked as having unseen activity; every ended turn
   * refreshes the plan usage (throttled, see `state/planUsage.ts`). A completed turn sends the next queued prompt in
   * the same step, so the chat never shows as idle in between; a stopped or failed turn, or one the session moves
   * after, leaves the queue alone.
   */
  async function runTurn(id: string, item: ChatItem | null, request: () => Promise<string>) {
    updateChat(id, (chat) => ({
      ...chat,
      items: item ? [...chat.items, item] : chat.items,
      isHiddenTurn: item ? false : chat.isHiddenTurn,
      isBusy: true,
      error: null,
    }));
    let next: QueuedPrompt | null = null;
    try {
      const stopReason = await request();
      updateChat(id, (chat) => {
        next = stopReason === CANCELLED_STOP_REASON || chat.move ? null : (chat.queue[0] ?? null);
        return { ...chat, isBusy: Boolean(next), queue: next ? chat.queue.slice(1) : chat.queue, editVersion: chat.editVersion + 1 };
      });
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, isBusy: false, error: String(error) }));
    }
    if (get().activeSessionId !== id) {
      updateChat(id, (chat) => ({ ...chat, hasUnseenActivity: true }));
    }
    usePlanUsageStore.getState().refresh();
    if (next) {
      await runPrompt(id, next);
    }
  }

  /** Runs `prompt` as the next turn; `/clear` starts the conversation over instead of being sent. */
  async function runPrompt(id: string, prompt: PromptDraft) {
    if (isClearPrompt(prompt.text)) {
      await get().clearSession(id);
    } else {
      await runPromptTurn(id, prompt);
    }
  }

  /**
   * Starts the agent of `id` through `start` with an empty chat, which is complete as soon as the agent runs: the
   * agent's conversation starts fresh. With `keepsItems` the chat goes on showing its conversation until the first
   * update of the started agent, which replays the conversation it loads, replaces it; a start that sends nothing
   * leaves the chat empty. A failed start leaves its error in the chat, next to the conversation it kept. Resolves with
   * whether the agent started.
   */
  async function restartChat(id: string, start: () => Promise<SessionView>, keepsItems = false): Promise<boolean> {
    updateChat(id, (chat) =>
      keepsItems && chat.items.length
        ? { ...chat, isLoading: true, isStale: true, isBusy: false, isHiddenTurn: false, permission: null, error: null }
        : { ...replacedChat(chat), isLoading: true, remoteStep: null, remoteDetail: null },
    );
    try {
      await start();
      updateChat(id, (chat) => ({ ...(chat.isStale ? replacedChat(chat) : chat), isLoading: false }));
      await get().refreshSessions();
      return true;
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, isLoading: false, isStale: false, error: String(error) }));
      return false;
    }
  }

  /**
   * The empty chat a restarted agent fills; the mode, the queued prompts, a running remote operation or move and the file
   * sync carry over.
   */
  function replacedChat(chat: SessionChat): SessionChat {
    const { modeId, queue, isLoading, remoteStep, remoteDetail, remoteRun, move, fileSync } = chat;
    return { ...createEmptyChat(), modeId, queue, hasHistory: true, isLoading, remoteStep, remoteDetail, remoteRun, move, fileSync };
  }

  /** Resolves once the chat of `id` runs no turn, also when there is no such chat (any more). */
  function whenIdle(id: string): Promise<void> {
    return new Promise((resolve) => {
      const isIdle = (state: HuntState) => !state.chats[id]?.isBusy;
      if (isIdle(get())) return resolve();
      const unsubscribe = store.subscribe((state) => {
        if (!isIdle(state)) return;
        unsubscribe();
        resolve();
      });
    });
  }

  /**
   * Moves the session `id` to or from its VM through `start` once its agent finished the running turn, which `prepare`
   * (if any) accompanies. Prompts sent until the move ended stay queued: after a successful move the agent the session
   * runs with now gets them, after a failed one the composer takes them back. A failed `prepare` leaves the session where
   * it is, with the error in its chat. A handoff without queued prompts of a session whose chat holds a prompt ends with
   * `startServicesAfterHandoff`.
   */
  async function moveSession(id: string, move: SessionMove, prepare: (() => Promise<void>) | null, start: () => Promise<SessionView>) {
    const hasTask = move === "handOff" && Boolean(get().chats[id]?.items.some((item) => item.kind === "user"));
    updateChat(id, (chat) => ({ ...chat, move, error: null }));
    let isMoved = false;
    try {
      if (prepare && get().chats[id]?.isBusy) {
        await prepare();
      }
      await whenIdle(id);
      isMoved = await restartChat(id, start, true);
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: String(error) }));
    }
    const isLive = Boolean(get().sessions.find((candidate) => candidate.id === id)?.isLive);
    let next: QueuedPrompt | null = null;
    updateChat(id, (chat) => {
      next = isMoved && isLive && !chat.isBusy ? (chat.queue[0] ?? null) : null;
      return { ...chat, move: null, remoteRun: null, isBusy: chat.isBusy || Boolean(next), queue: next ? chat.queue.slice(1) : chat.queue };
    });
    if (next) {
      await runPrompt(id, next);
    } else if (isMoved && isLive && hasTask) {
      await startServicesAfterHandoff(id);
    }
  }

  /**
   * Sends the agent of the session `id`, which has just moved to its VM, `HANDOFF_START_PROMPT` when hunt.json declares
   * services and none of them runs or starts. Sends nothing once a prompt of the user ran or queued meanwhile, since its
   * turn starts the services.
   */
  async function startServicesAfterHandoff(id: string) {
    let status: PreviewStatus;
    try {
      status = await commands.previewStatus(id);
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: `failed to check the services on the VM: ${String(error)}` }));
      return;
    }
    const chat = get().chats[id];
    if (!chat || chat.isBusy || chat.move || chat.queue.length) return;
    if (!status.services.length || hasRunningService(status)) return;
    await runPromptTurn(id, { text: HANDOFF_START_PROMPT, images: [] });
  }

  /** Runs the turn of `prompt`, shown as the user's message in the chat. */
  async function runPromptTurn(id: string, { text, images }: PromptDraft) {
    const item: ChatItem = { kind: "user", id: nextItemId(), text, images: images.map((image) => assetUrl(image.path)) };
    await runTurn(id, item, () => commands.sendPrompt(id, text, images.map((image) => image.path)));
  }

  /**
   * Lists the placeholder of a session the backend is creating, with the chat its first prompt is already shown in.
   * With `isActivated` it becomes the active session and replaces the start view.
   */
  function listPlaceholder(placeholder: SessionView, prompt: PromptDraft | null, isActivated: boolean) {
    const items: ChatItem[] = prompt ? [{ kind: "user", id: nextItemId(), text: prompt.text, images: prompt.images.map((image) => assetUrl(image.path)) }] : [];
    set((state) => ({
      sessions: [placeholder, ...state.sessions],
      creatingIds: [...state.creatingIds, placeholder.id],
      chats: { ...state.chats, [placeholder.id]: { ...createEmptyChat(), items, hasHistory: true } },
      ...(isActivated ? { activeSessionId: placeholder.id, draft: null } : {}),
    }));
  }

  /**
   * Runs the backend creation of the placeholder `id` and swaps in the stored session, then applies `start` in the
   * background: its setup first, then its prompt. A failed creation drops the placeholder; when it was the active
   * session, the start view for `draftParentId` comes back with the error and the unsent prompt. Rejects with that error.
   */
  async function completeCreation(id: string, create: () => Promise<SessionView>, start: SessionStart, draftParentId: string | null): Promise<string> {
    let session: SessionView;
    try {
      session = await create();
    } catch (error) {
      set((state) => {
        const chats = { ...state.chats };
        delete chats[id];
        const isActive = state.activeSessionId === id;
        return {
          sessions: state.sessions.filter((candidate) => candidate.id !== id),
          creatingIds: state.creatingIds.filter((candidate) => candidate !== id),
          untitledIds: state.untitledIds.filter((candidate) => candidate !== id),
          chats,
          ...(isActive ? { activeSessionId: null, draft: { parentId: draftParentId, error: String(error), prompt: start.prompt } } : {}),
        };
      });
      // A record stored before the agent failed to start is a stopped session now; the reload lists it.
      void get().refreshSessions();
      throw error;
    }
    set((state) => ({
      sessions: state.sessions.map((candidate) => (candidate.id === id ? session : candidate)),
      creatingIds: state.creatingIds.filter((candidate) => candidate !== id),
    }));
    void applyStart(id, start);
    return id;
  }

  /** Applies the setup to the freshly created session and sends its first prompt; a failure lands in the chat's error. */
  async function applyStart(id: string, { setup, prompt }: SessionStart) {
    try {
      for (const [configId, value] of Object.entries(setup.configValues)) {
        await get().setConfigOption(id, configId, value);
      }
      if (setup.modeId !== "default") {
        await get().setMode(id, setup.modeId);
      }
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: String(error) }));
    }
    if (!prompt) return;
    const images = prompt.images.map((image) => image.path);
    await runTurn(id, null, () => commands.sendPrompt(id, prompt.text, images));
  }

  /** The title a session is created with: `title`, or for an untitled session (`null`) the name of its repository. */
  function placeholderTitle(id: string, title: string | null, repoPath: string): string {
    if (title !== null) return title;
    set((state) => ({ untitledIds: [...state.untitledIds, id] }));
    return repoName(repoPath);
  }

  /** Names the untitled session `id` after its first prompt; the backend keeps the branch slug of the placeholder title. */
  async function nameAfterPrompt(id: string, text: string) {
    set((state) => ({ untitledIds: state.untitledIds.filter((candidate) => candidate !== id) }));
    try {
      const session = await commands.renameSession(id, titleFromPrompt(text) || "Screenshot");
      set((state) => ({ sessions: state.sessions.map((candidate) => (candidate.id === id ? session : candidate)) }));
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: String(error) }));
    }
  }

  return {
    sessions: [],
    creatingIds: [],
    removingIds: [],
    activeSessionId: null,
    chats: {},
    rightTab: "diff",
    draft: null,
    untitledIds: [],
    remoteSync: { isRunning: false, error: null },

    refreshSessions: async () => {
      const listed = await commands.listSessions();
      set((state) => {
        const creating = state.sessions.filter((session) => state.creatingIds.includes(session.id) && !listed.some((candidate) => candidate.id === session.id));
        return { sessions: [...creating, ...listed.filter((session) => !state.removingIds.includes(session.id))] };
      });
    },

    syncRemoteSessions: async () => {
      const settings = configuredVmSettings(useSettingsStore.getState().remote);
      if (!settings || get().remoteSync.isRunning) return;
      set({ remoteSync: { isRunning: true, error: null } });
      try {
        await commands.adoptSessionVms(settings, useAgentDefaultsStore.getState().recentRepoPaths);
        set({ remoteSync: { isRunning: false, error: null } });
        await get().refreshSessions();
      } catch (error) {
        set({ remoteSync: { isRunning: false, error: String(error) } });
      }
    },

    startDraft: (parentId) => {
      set({ draft: { parentId: parentId ?? null } });
    },

    selectSession: async (id) => {
      set({ activeSessionId: id, draft: null });
      if (get().chats[id]?.hasUnseenActivity) {
        updateChat(id, (chat) => ({ ...chat, hasUnseenActivity: false }));
      }
      const session = get().sessions.find((candidate) => candidate.id === id);
      if (!session || get().creatingIds.includes(id)) return;
      if (session.isLive) {
        await get().loadHistory(id);
      } else {
        await get().resumeSession(id);
      }
    },

    resumeSession: async (id) => {
      await restartChat(id, () => commands.openSession(id), true);
    },

    clearSession: async (id) => {
      await restartChat(id, () => commands.clearSession(id));
    },

    handOffSession: async (id) => {
      const { remote } = useSettingsStore.getState();
      const settings = configuredVmSettings(remote);
      if (!settings) {
        updateChat(id, (chat) => ({ ...chat, error: "Set the project in Settings → Remote VM first." }));
        return;
      }
      await moveSession(
        id,
        "handOff",
        () => commands.prepareHandOff(id, settings),
        () => commands.handOffSession(id, settings, remote.filePatterns),
      );
    },

    retrieveSession: (id) => moveSession(id, "retrieve", null, () => commands.retrieveSession(id)),

    loadHistory: async (id) => {
      // The agent survives a webview reload but this store does not: rebuild the chat from the backend's history.
      if (get().chats[id]?.hasHistory) return;
      updateChat(id, (chat) => ({ ...chat, isLoading: true }));
      try {
        const history = await commands.sessionHistory(id);
        updateChat(id, () => ({ ...history.reduce(reduceChat, createEmptyChat()), isLoading: false, hasHistory: true }));
        rememberCommandsOf(id);
      } catch (error) {
        updateChat(id, (chat) => ({ ...chat, isLoading: false, error: String(error) }));
      }
    },

    createSession: async (target, title, start) => {
      const id = crypto.randomUUID();
      const { repoPath, baseRef, pullRequest, diffBaseRef, pullRequestBranch, workspace } = target;
      const listedTitle = placeholderTitle(id, title, repoPath);
      useAgentDefaultsStore.getState().rememberRepoPath(repoPath);
      listPlaceholder(placeholderSession(id, listedTitle, target, null, null), start.prompt, true);
      const create = () => commands.createSession(id, repoPath, baseRef, listedTitle, pullRequest, diffBaseRef, pullRequestBranch, workspace);
      return completeCreation(id, create, start, null);
    },

    createSubSession: async (parentId, title, selection, start, isActivated) => {
      const parent = get().sessions.find((candidate) => candidate.id === parentId);
      if (!parent) throw new Error(`failed to create sub session: the session ${parentId} is not listed`);
      if (parent.remote) throw new Error("failed to create sub session: its parent runs on the remote VM");
      const id = crypto.randomUUID();
      const target: WorktreeTarget = {
        repoPath: parent.repoPath,
        baseRef: parent.baseRef,
        workspace: parent.workspace,
        pullRequest: parent.pullRequest,
        diffBaseRef: parent.diffBase,
        pullRequestBranch: null,
      };
      const listedTitle = placeholderTitle(id, title, parent.repoPath);
      listPlaceholder(placeholderSession(id, listedTitle, target, parent, selection), start.prompt, isActivated);
      return completeCreation(id, () => commands.createSubSession(id, parentId, listedTitle, selection), start, parentId);
    },

    closeSession: async (id, removeWorktree) => {
      if (get().creatingIds.includes(id)) return;
      if (!removeWorktree) {
        await commands.closeSession(id, false);
        set((state) => {
          const chats = { ...state.chats };
          delete chats[id];
          return { chats };
        });
        await get().refreshSessions();
        return;
      }

      const { sessions, activeSessionId: previousActiveId } = get();
      const removedIds = [id, ...sessions.filter((session) => session.parentId === id).map((session) => session.id)];
      set((state) => {
        const chats = { ...state.chats };
        for (const removedId of removedIds) {
          delete chats[removedId];
        }
        return {
          chats,
          sessions: state.sessions.filter((session) => !removedIds.includes(session.id)),
          removingIds: [...state.removingIds, ...removedIds],
          activeSessionId: state.activeSessionId && removedIds.includes(state.activeSessionId) ? null : state.activeSessionId,
        };
      });
      try {
        await commands.closeSession(id, true);
      } catch (error) {
        set((state) => ({
          removingIds: state.removingIds.filter((candidate) => !removedIds.includes(candidate)),
          ...(previousActiveId && removedIds.includes(previousActiveId) && !state.activeSessionId ? { activeSessionId: previousActiveId } : {}),
        }));
        await get().refreshSessions();
        updateChat(id, (chat) => ({ ...chat, error: `Deleting the session failed: ${String(error)}` }));
        return;
      }
      set((state) => ({ removingIds: state.removingIds.filter((candidate) => !removedIds.includes(candidate)) }));
      await get().refreshSessions();
    },

    sendPrompt: async (id, text, images = []) => {
      if (get().chats[id]?.isBusy || get().chats[id]?.move) {
        updateChat(id, (chat) => ({ ...chat, queue: [...chat.queue, { id: nextItemId(), text, images }] }));
        return;
      }
      const session = get().sessions.find((candidate) => candidate.id === id);
      if (session?.remote && !session.isLive) {
        // The VM shuts down when idle; a prompt starts it and the connection again. A failed start keeps the prompt
        // in the queue, so the composer can take it back.
        await get().resumeSession(id);
        if (!get().sessions.find((candidate) => candidate.id === id)?.isLive) {
          updateChat(id, (chat) => ({ ...chat, queue: [...chat.queue, { id: nextItemId(), text, images }] }));
          return;
        }
      }
      if (get().untitledIds.includes(id) && !isClearPrompt(text)) {
        void nameAfterPrompt(id, text);
      }
      await runPrompt(id, { text, images });
    },

    takeQueue: (id) => {
      const queue = get().chats[id]?.queue ?? [];
      if (queue.length) {
        updateChat(id, (chat) => ({ ...chat, queue: [] }));
      }
      return queue;
    },

    unqueuePrompt: (id, promptId) => {
      updateChat(id, (chat) => ({ ...chat, queue: chat.queue.filter((prompt) => prompt.id !== promptId) }));
    },

    refreshGraph: async (id) => {
      if (get().chats[id]?.move) return;
      updateChat(id, (chat) => ({ ...chat, isGeneratingGraph: true, isHiddenTurn: true }));
      const { model, effort } = useSettingsStore.getState().graphAgent;
      const request = () => commands.refreshGraph(id, model, effort).finally(() => updateChat(id, (chat) => ({ ...chat, isGeneratingGraph: false })));
      await runTurn(id, null, request);
    },

    cancelPrompt: async (id) => {
      await commands.cancelPrompt(id);
      updateChat(id, (chat) => ({ ...chat, permission: null }));
    },

    setMode: async (id, modeId) => {
      await commands.setSessionMode(id, modeId);
      updateChat(id, (chat) => ({ ...chat, modeId }));
    },

    setConfigOption: async (id, configId, value) => {
      updateChat(id, (chat) => ({
        ...chat,
        configOptions: chat.configOptions.map((option) =>
          option.id === configId && option.type === "select" ? { ...option, currentValue: value } : option,
        ),
      }));
      await commands.setSessionConfigOption(id, configId, value);
    },

    answerPermission: async (id, requestId, optionId) => {
      updateChat(id, (chat) => ({ ...chat, permission: null }));
      await commands.answerPermission(requestId, optionId);
    },

    setRightTab: (rightTab) => set({ rightTab }),

    noteWorktreeChanged: (id) => {
      updateChat(id, (chat) => ({ ...chat, editVersion: chat.editVersion + 1 }));
    },

    ensureChat: (id) => {
      if (get().chats[id]) return;
      updateChat(id, (chat) => chat);
    },

    applyUpdate: (huntSessionId, notification) => {
      if (notification.update.sessionUpdate === "config_option_update") {
        useAgentDefaultsStore.getState().rememberOptions(notification.update.configOptions);
      }
      updateChat(huntSessionId, (chat) => reduceChat(chat.isStale ? replacedChat(chat) : chat, notification));
      if (notification.update.sessionUpdate === "available_commands_update") {
        rememberCommandsOf(huntSessionId);
      }
    },

    applyPermission: (event) => {
      updateChat(event.huntSessionId, (chat) => ({
        ...chat,
        permission: { requestId: event.requestId, toolCall: event.request.toolCall, options: event.request.options },
      }));
    },

    applyPermissionWithdrawn: (event) => {
      if (get().chats[event.huntSessionId]?.permission?.requestId !== event.requestId) return;
      updateChat(event.huntSessionId, (chat) => ({ ...chat, permission: null }));
    },

    applyClosed: (event) => {
      if (!get().chats[event.huntSessionId]) return;
      // A remote session loses its connection whenever its idle VM shuts down; the chat says so without an error.
      const isRemote = Boolean(get().sessions.find((session) => session.id === event.huntSessionId)?.remote);
      updateChat(event.huntSessionId, (chat) => ({
        ...chat,
        isBusy: false,
        permission: null,
        error: event.error && !isRemote ? `Agent stopped: ${event.error}` : chat.error,
      }));
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === event.huntSessionId ? { ...session, isLive: false } : session,
        ),
      }));
    },

    applyRemoteProgress: (event) => {
      updateChat(event.huntSessionId, (chat) => ({
        ...chat,
        remoteStep: event.step,
        remoteDetail: event.detail,
        remoteRun: advanceRemoteRun(chat.remoteRun, event.step, Date.now(), Boolean(chat.move)),
      }));
    },

    applyRemoteSync: (event) => {
      // Only a chat that exists: creating one here would make `selectSession` skip the history rebuild.
      if (!get().chats[event.huntSessionId]) return;
      updateChat(event.huntSessionId, (chat) => ({
        ...chat,
        fileSync: event.isRunning
          ? { ...chat.fileSync, isRunning: true }
          : { isRunning: false, syncedAt: event.syncedAt ?? chat.fileSync.syncedAt, error: event.error },
        editVersion: event.changedLocal ? chat.editVersion + 1 : chat.editVersion,
      }));
    },

    applyGraphChanged: (huntSessionId) => {
      updateChat(huntSessionId, (chat) => ({ ...chat, graphVersion: chat.graphVersion + 1 }));
    },

    applyAttributionChanged: (worktreePath) => {
      set((state) => {
        const chats = { ...state.chats };
        for (const session of state.sessions) {
          // Only sessions whose chat exists: creating one here would make `selectSession` skip the history rebuild.
          const chat = chats[session.id];
          if (session.worktreePath !== worktreePath || !chat) continue;
          chats[session.id] = { ...chat, editVersion: chat.editVersion + 1 };
        }
        return { chats };
      });
    },

    applySummary: (event) => {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === event.huntSessionId ? { ...session, title: event.title, summary: event.summary } : session,
        ),
      }));
    },
  };
});

export function useActiveChat(): SessionChat | null {
  return useHuntStore((state) => (state.activeSessionId ? (state.chats[state.activeSessionId] ?? null) : null));
}

export function useActiveSession(): SessionView | null {
  return useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId) ?? null);
}
