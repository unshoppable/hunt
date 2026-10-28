import type { StoreApi } from "zustand";
import { emit } from "@tauri-apps/api/event";
import type { AvailableCommand, PlanEntry, SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { assetUrl, commands } from "../ipc/commands";
import type { StoredBrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import type { ChatItem, MessageTimesEvent, PendingPermission, PermissionEvent, PermissionWithdrawnEvent, Screenshot } from "./chat.types";
import type { GuardrailDeclineReason } from "./guardrail/guardrail-suggestion.types";
import type { GuardrailSuggestion } from "./guardrail/guardrail-suggestion.utils";
import type { DiagramType } from "../common/diagram/diagram.types";
import type { HuntGet, HuntSet, HuntState } from "../sessions/hunt.store";
import type { RemoteStep } from "../sessions/remote/remote-session.types";
import type { FileSync, SessionMove } from "../sessions/remote/remote-session.store-slice";
import type { RemoteRun } from "../sessions/remote/remote-run.utils";
import type { AnnotationEvent, SessionView } from "../sessions/session.types";
import { asksQuestion } from "../../../../libs/domain/src/shared/question.utils.ts";
import { createEmptyChat, huntTurnOf, nextItemId, reduceChat, replacedChat, type MessageItem } from "./chat-reducer.utils";
import { createSessionNaming } from "../sessions/session.store-slice";
import { useAgentDefaultsStore } from "./agent-defaults.store";
import { usePlanUsageStore } from "../accounts/plan-usage.store";
import { useSettingsStore } from "../settings/settings.store";

export type SessionMode = { id: string; name: string; description?: string | null };

/** Fill level of the agent's context window in tokens, as last reported by the agent. */
export type ContextUsage = { used: number; size: number };

/** Text and screenshots of a prompt before it is sent. */
export type PromptDraft = { text: string; images: Screenshot[] };

/** A prompt sent while the agent was busy or starting; it waits in the chat's queue and is sent once the agent is idle. */
export type QueuedPrompt = PromptDraft & { id: string };

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
   * Prompts sent while a turn was running or the agent was starting, in sending order; each one starts the next turn as
   * soon as the previous turn ends or the agent runs. A stopped or failed turn, or a failed start, leaves them here for
   * the composer to take back.
   */
  queue: QueuedPrompt[];
  /**
   * Whether a turn finished while the session was not the active one and the user has not opened it since, in the
   * sidebar or, for a sub chat, in its popover (see `markChatSeen`).
   */
  hasUnseenActivity: boolean;
  /**
   * The `messageId` of the prompt whose reply began the unseen activity; the chat opened for it draws its "unread" line
   * below that prompt. `null` without unseen activity or when the prompt has no `messageId`.
   */
  unseenAfterMessageId: string | null;
  isLoading: boolean;
  error: string | null;
  /** Bumped whenever the agent finished an edit or a turn so the diff panel refetches. */
  editVersion: number;
  /** Bumped when the watcher reports a rewritten graph file. */
  graphVersion: number;
  /** The diagram types a background agent is generating right now (see `refreshGraph`). */
  generatingDiagrams: DiagramType[];
  /** Why the last generation of a diagram type failed; cleared when that type is generated again. */
  diagramErrors: Partial<Record<DiagramType, string>>;
  /**
   * Whether the latest turn is one Hunt sent itself (a diagram refresh, which older sessions replay from their transcript).
   * The chat shows neither its prompt nor its output nor a working indicator; the next turn of the user ends it.
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
  /**
   * The items show the conversation from before a restart of the agent; its first update replaces them, or the backend's
   * history does once the start ended without one (see `restartChat`).
   */
  isStale: boolean;
  /** The move to or from the VM the user asked for, from the click until it ended; `null` while none is asked for. */
  move: SessionMove | null;
  /** The file sync of a remote session; idle for a local one. */
  fileSync: FileSync;
  /** The reply whose guardrail suggestion the user took up or declined; the "Guardrail" button no longer offers it. */
  dismissedGuardrailId: string | null;
};

/** The chat slice of the Hunt store: the chat of every session, its unsent prompt and its browser annotations. */
export type ChatSlice = {
  chats: Record<string, SessionChat>;
  /** What the prompt box of a session holds but has not sent yet, by session id; the box shows it again when the session is opened again. */
  promptDrafts: Record<string, PromptDraft>;
  /**
   * The annotations of the review widget a remote session's status channel delivered, by session id, in arrival order;
   * the composer shows them and sends them along with the next prompt.
   */
  annotations: Record<string, StoredBrowserAnnotation[]>;

  /** Rebuilds the chat of a live session from the backend's history when this store has none (after a webview reload). */
  loadHistory: (id: string) => Promise<void>;
  /**
   * Sends `text` with `images` as one turn. While a turn is running or the session moves, the prompt is queued instead
   * and sent once the running turn or the move ended; the returned promise then resolves at once. `/clear` starts the
   * conversation over instead.
   */
  sendPrompt: (id: string, text: string, images?: Screenshot[]) => Promise<void>;
  /**
   * Sends `text` with `images` without waiting: a running turn is interrupted and the prompt sent before every other
   * queued prompt; otherwise it is sent like `sendPrompt`. A running turn the agent has not answered yet goes on and
   * the prompt follows it ahead of the queue, since cancelling a turn Claude Code has not started drops its prompt.
   */
  sendPromptNow: (id: string, text: string, images?: Screenshot[]) => Promise<void>;
  /** Takes every queued prompt out of the queue and returns them, for the composer to show them again. */
  takeQueue: (id: string) => QueuedPrompt[];
  /** Takes the queued prompt `promptId` out of the queue. */
  unqueuePrompt: (id: string, promptId: string) => void;
  /** Remembers what the prompt box of `id` holds (see `promptDrafts`); an empty draft forgets it. */
  setPromptDraft: (id: string, draft: PromptDraft) => void;
  /** Adds the delivered annotation to its session's (see `annotations`); one whose id the session has already is ignored. */
  applyAnnotation: (event: AnnotationEvent) => void;
  /** Takes the annotation `annotationId` out of the session `id`'s. */
  removeAnnotation: (id: string, annotationId: string) => void;
  /** Forgets every annotation of the session `id`, once the composer sent them. */
  clearAnnotations: (id: string) => void;
  /**
   * Declines the guardrail `suggestion` of `id` for `reason`: hides it (see `SessionChat.dismissedGuardrailId`) and records
   * it in the repository's `.claude/declined-guardrails.jsonl`, which agents search before they suggest a guardrail.
   */
  declineGuardrail: (id: string, suggestion: GuardrailSuggestion, reason: GuardrailDeclineReason) => void;
  /** Hides the guardrail `suggestion` of `id` once the user took it up (see `SessionChat.dismissedGuardrailId`). */
  acceptGuardrail: (id: string, suggestion: GuardrailSuggestion) => void;
  /**
   * Generates the diagram of `diagramType` in a background agent, independent of the chat agent, which may run a turn
   * meanwhile; one run per type at a time (see `SessionChat.generatingDiagrams` and `diagramErrors`).
   */
  refreshGraph: (id: string, diagramType: DiagramType, instructions?: string) => Promise<void>;
  cancelPrompt: (id: string) => Promise<void>;
  setMode: (id: string, modeId: string) => Promise<void>;
  setConfigOption: (id: string, configId: string, value: string) => Promise<void>;
  answerPermission: (id: string, requestId: string, optionId: string) => Promise<void>;
  /** Bumps `editVersion` after a local write to the worktree (a save in the diff or editor pane) so every view reloads. */
  noteWorktreeChanged: (id: string) => void;
  /** Creates the empty chat record of `id` when there is none, so worktree-change events reach a window that shows the session without its chat (the editor window). */
  ensureChat: (id: string) => void;

  /** Clears the unseen activity of `id` once the user looked at its chat, in this window and, through `chat:seen`, in every other. */
  markChatSeen: (id: string) => void;
  /** Clears the unseen activity of `id` that another window's `markChatSeen` announced. */
  applyChatSeen: (id: string) => void;

  /** Applies a live update; a turn another window started that ends while the session is not the active one leaves unseen activity. */
  applyUpdate: (huntSessionId: string, notification: SessionNotification) => void;
  /** Applies the updates a load replayed in one step, as `applyUpdate` would one by one. */
  applyReplay: (huntSessionId: string, notifications: SessionNotification[]) => void;
  applyPermission: (event: PermissionEvent) => void;
  /** Drops the chat's permission request when it is the withdrawn one. */
  applyPermissionWithdrawn: (event: PermissionWithdrawnEvent) => void;
  /** Gives the chat items of the event's messages their transcript times. */
  applyMessageTimes: (event: MessageTimesEvent) => void;
  applyGraphChanged: (huntSessionId: string) => void;
  /** Reloads the changes of every open session that works in `worktreePath`, after a tool call or a change from outside Hunt changed it. */
  applyWorktreeChanged: (worktreePath: string) => void;
};

/**
 * Whether the agent of `chat` waits for the user's answer: its last turn ended (nothing running, queued or asked for
 * permission) with a message the agent marked as a question (`<!-- hunt:question -->`) or whose last paragraph ends
 * with a question mark. Derived from the items, so it holds for a replayed remote session too and ends by itself once
 * the user's answer follows.
 */
export function hasPendingQuestion(chat: SessionChat): boolean {
  if (chat.isBusy || chat.queue.length > 0 || chat.permission) return false;
  const last = chat.items[chat.items.length - 1];
  return last?.kind === "agent" && asksQuestion(last.text);
}

/** Stop reason the backend reports for a turn the user interrupted (the Debug form of the ACP `StopReason::Cancelled`). */
const CANCELLED_STOP_REASON = "Cancelled";

/** The `messageId` of the last prompt in `items`; `null` without a prompt or when it has none. */
function lastPromptMessageId(items: ChatItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "user") return item.messageId ?? null;
  }
  return null;
}

/** Whether the agent answered the last prompt in `items` with a message, a thought or a tool call. */
function hasAnsweredLastPrompt(items: ChatItem[]): boolean {
  const last = items[items.length - 1];
  return Boolean(last) && last.kind !== "user";
}

/** Whether `text` is the `/clear` command, which restarts the conversation instead of being sent to the agent. */
function isClearPrompt(text: string): boolean {
  return text.trim() === "/clear";
}

/**
 * The turn machinery every slice of the Hunt store sends prompts and (re)starts agents through: the session slice for
 * the first prompt of a new session, the remote session slice for a move to or from the VM, the chat slice for the
 * prompts the user sends. It keeps which turns this window runs, so `useHuntStore` creates it once and hands it to every slice.
 */
export type ChatTurns = ReturnType<typeof createChatTurns>;

export function createChatTurns(set: HuntSet, get: HuntGet, store: StoreApi<HuntState>) {
  /** Sessions with a turn this client runs (see `runTurn`). */
  const runningTurnIds = new Set<string>();
  /** Sessions whose running turn `sendPromptNow` interrupted; the queue goes on after the interrupted turn. */
  const interruptedToSendIds = new Set<string>();
  /** Message ids of the prompts this window shows itself; the backend's echo of them goes to the other windows. */
  const ownMessageIds = new Set<string>();

  function updateChat(id: string, updater: (chat: SessionChat) => SessionChat) {
    set((state) => {
      const current = state.chats[id] ?? createEmptyChat();
      return { chats: { ...state.chats, [id]: updater(current) } };
    });
  }

  const { nameAfterPrompt } = createSessionNaming(set, updateChat);

  /** Applies the agent's `notifications` to the chat of `id` in one store update, which renders the chat once. */
  function applyUpdates(id: string, notifications: SessionNotification[]) {
    // The backend and the relay report a turn as idle before the prompt call of this window returns; that return ends
    // the turn and sends the next queued prompt, so the reported turn state counts only for turns this window did not start.
    const applied = notifications.filter((notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "session_info_update") return !(huntTurnOf(update._meta) && runningTurnIds.has(id));
      return !(update.sessionUpdate === "user_message_chunk" && update.messageId && ownMessageIds.has(update.messageId));
    });
    for (const notification of applied) {
      if (notification.update.sessionUpdate === "config_option_update") {
        useAgentDefaultsStore.getState().rememberOptions(notification.update.configOptions);
      }
    }
    if (!applied.length) return;
    updateChat(id, (chat) => applied.reduce((current, notification) => reduceChat(current.isStale ? replacedChat(current) : current, notification), chat));
    if (applied.some((notification) => notification.update.sessionUpdate === "available_commands_update")) {
      rememberCommandsOf(id);
    }
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
   * refreshes the plan usage (throttled, see `accounts/plan-usage.store.ts`). A completed turn, or one `sendPromptNow`
   * interrupted, sends the next queued prompt in the same step, so the chat never shows as idle in between; a stopped
   * or failed turn, or one the session moves after, leaves the queue alone.
   */
  async function runTurn(id: string, item: ChatItem | null, request: () => Promise<string>) {
    updateChat(id, (chat) => ({
      ...chat,
      items: item ? [...chat.items, item] : chat.items,
      isHiddenTurn: item ? false : chat.isHiddenTurn,
      isBusy: true,
      error: null,
    }));
    runningTurnIds.add(id);
    let next: QueuedPrompt | null = null;
    try {
      const stopReason = await request();
      const sendsQueue = stopReason !== CANCELLED_STOP_REASON || interruptedToSendIds.has(id);
      next = updateChatTakingQueue(id, (chat) => ({ ...chat, isBusy: false, editVersion: chat.editVersion + 1 }), sendsQueue);
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, isBusy: false, error: String(error) }));
    } finally {
      runningTurnIds.delete(id);
      interruptedToSendIds.delete(id);
    }
    noteTurnEnded(id);
    usePlanUsageStore.getState().refresh();
    if (next) {
      await runPrompt(id, next);
    }
  }

  /**
   * Marks the chat of `id` as having unseen activity after a turn ended, unless it is the active session; the first such
   * turn since the user last looked remembers the prompt its reply follows (see `SessionChat.unseenAfterMessageId`).
   */
  function noteTurnEnded(id: string) {
    if (get().activeSessionId === id) return;
    updateChat(id, (chat) => (chat.hasUnseenActivity ? chat : { ...chat, hasUnseenActivity: true, unseenAfterMessageId: lastPromptMessageId(chat.items) }));
  }

  /**
   * Applies `updater` to the chat of `id` and, with `sendsQueue`, takes the first queued prompt out when the updated chat
   * runs no turn and no move, marking the chat busy for it in the same step so that the composer never sees the chat idle
   * with a queue (it would take the queue back then). Returns the taken prompt, which the caller runs with `runPrompt`.
   */
  function updateChatTakingQueue(id: string, updater: (chat: SessionChat) => SessionChat, sendsQueue: boolean): QueuedPrompt | null {
    let next: QueuedPrompt | null = null;
    updateChat(id, (chat) => {
      const updated = updater(chat);
      next = sendsQueue && !updated.isBusy && !updated.move ? (updated.queue[0] ?? null) : null;
      return next ? { ...updated, isBusy: true, queue: updated.queue.slice(1) } : updated;
    });
    return next;
  }

  /**
   * Runs `prompt` as the next turn; `/clear` starts the conversation over instead of being sent. The first prompt of an
   * untitled session names it.
   */
  async function runPrompt(id: string, prompt: PromptDraft) {
    if (isClearPrompt(prompt.text)) {
      await get().clearSession(id);
      return;
    }
    if (get().untitledIds.includes(id)) {
      void nameAfterPrompt(id, prompt.text);
    }
    await runPromptTurn(id, prompt);
  }

  /**
   * Starts the agent of `id` through `start` with an empty chat, which is complete as soon as the agent runs: the
   * agent's conversation starts fresh. With `keepsItems` the chat goes on showing its conversation until the first
   * update of the started agent, which replays the conversation it loads, replaces it; a start that sends nothing
   * leaves the chat empty. With `mayAttach` the start may have found the agent running already (an open while another
   * open of the session runs, or of a session the list did not show as live yet) and attached to it without an update:
   * the chat is then rebuilt from the backend's history, which holds what that agent replayed. A failed start leaves
   * its error in the chat, next to the conversation it kept. Prompts queued while the agent started go to it once it
   * runs, unless the session is moving (the move sends them). Resolves with whether the agent started.
   */
  async function restartChat(id: string, start: () => Promise<SessionView>, keepsItems = false, mayAttach = false): Promise<boolean> {
    updateChat(id, (chat) =>
      keepsItems && chat.items.length
        ? { ...chat, isLoading: true, isStale: true, isBusy: false, isHiddenTurn: false, permission: null, error: null }
        : { ...replacedChat(chat), isLoading: true, isStale: true, remoteStep: null, remoteDetail: null },
    );
    try {
      await start();
      if (mayAttach && get().chats[id]?.isStale) {
        const history = await commands.sessionHistory(id);
        updateChat(id, (chat) => history.reduce(reduceChat, replacedChat(chat)));
        rememberCommandsOf(id);
      }
      await get().refreshSessions();
      const isLive = Boolean(get().sessions.find((candidate) => candidate.id === id)?.isLive);
      const next = updateChatTakingQueue(id, (chat) => ({ ...(chat.isStale ? replacedChat(chat) : chat), isLoading: false }), isLive);
      if (next) {
        void runPrompt(id, next);
      }
      return true;
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, isLoading: false, isStale: false, error: String(error) }));
      return false;
    }
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

  /** Runs the turn of `prompt`, shown as the user's message in the chat. */
  async function runPromptTurn(id: string, prompt: PromptDraft) {
    const item = ownPromptItem(prompt);
    await runTurn(id, item, () => commands.sendPrompt(id, prompt.text, prompt.images.map((image) => image.path), item.messageId));
  }

  /** The chat item of a prompt this window sends, under a fresh message id that tells the backend's echo of it apart. */
  function ownPromptItem({ text, images }: PromptDraft): MessageItem & { messageId: string } {
    const messageId = crypto.randomUUID();
    ownMessageIds.add(messageId);
    return { kind: "user", id: nextItemId(), text, images: images.map((image) => assetUrl(image.path)), messageId };
  }

  return {
    runningTurnIds,
    interruptedToSendIds,
    updateChat,
    applyUpdates,
    rememberCommandsOf,
    runTurn,
    noteTurnEnded,
    updateChatTakingQueue,
    runPrompt,
    restartChat,
    whenIdle,
    runPromptTurn,
    ownPromptItem,
  };
}

export function createChatSlice(set: HuntSet, get: HuntGet, turns: ChatTurns): ChatSlice {
  const { runningTurnIds, interruptedToSendIds, updateChat, applyUpdates, rememberCommandsOf, noteTurnEnded, updateChatTakingQueue, runPrompt } = turns;

  /** Drops the "unread" line of the session `id`; a prompt the user sends there shows they read what the line marked. */
  function dropUnreadLine(id: string) {
    if (get().unreadLine?.sessionId !== id) return;
    set({ unreadLine: null });
  }

  return {
    chats: {},
    promptDrafts: {},
    annotations: {},

    loadHistory: async (id) => {
      // The agent survives a webview reload but this store does not: rebuild the chat from the backend's history.
      if (get().chats[id]?.hasHistory) return;
      updateChat(id, (chat) => ({ ...chat, isLoading: true }));
      try {
        const history = await commands.sessionHistory(id);
        const next = updateChatTakingQueue(id, (chat) => ({ ...history.reduce(reduceChat, createEmptyChat()), queue: chat.queue, isLoading: false, hasHistory: true }), true);
        rememberCommandsOf(id);
        if (next) {
          void runPrompt(id, next);
        }
      } catch (error) {
        updateChat(id, (chat) => ({ ...chat, isLoading: false, error: String(error) }));
      }
    },

    sendPrompt: async (id, text, images = []) => {
      dropUnreadLine(id);
      const chat = get().chats[id];
      const queued = { id: nextItemId(), text, images };
      // A running turn, a move or a starting agent (the session is loading or being created) gets the prompt once it ended.
      if (chat?.isBusy || chat?.move || chat?.isLoading || get().creatingIds.includes(id)) {
        updateChat(id, (current) => ({ ...current, queue: [...current.queue, queued] }));
        return;
      }
      const session = get().sessions.find((candidate) => candidate.id === id);
      if (session && !session.isLive) {
        // The agent is not running (a VM shuts down when idle, a local agent is gone after the app restarted): the prompt
        // waits in the queue while the session starts again, which sends it. A failed start keeps it in the queue, so the
        // composer can take it back.
        updateChat(id, (current) => ({ ...current, queue: [...current.queue, queued] }));
        await get().resumeSession(id);
        return;
      }
      await runPrompt(id, { text, images });
    },

    sendPromptNow: async (id, text, images = []) => {
      const chat = get().chats[id];
      if (!chat?.isBusy || !runningTurnIds.has(id)) {
        await get().sendPrompt(id, text, images);
        return;
      }
      dropUnreadLine(id);
      updateChat(id, (current) => ({ ...current, queue: [{ id: nextItemId(), text, images }, ...current.queue] }));
      // claude-agent-acp drops the prompt of a cancelled turn that Claude Code has not started, e.g. while it still starts its MCP servers.
      if (!hasAnsweredLastPrompt(chat.items)) return;
      interruptedToSendIds.add(id);
      await get().cancelPrompt(id);
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

    declineGuardrail: (id, suggestion, reason) => {
      updateChat(id, (chat) => ({ ...chat, dismissedGuardrailId: suggestion.replyId }));
      commands.declineGuardrail(id, suggestion.kind, suggestion.summary, reason).catch((error) => updateChat(id, (chat) => ({ ...chat, error: String(error) })));
    },

    acceptGuardrail: (id, suggestion) => {
      updateChat(id, (chat) => ({ ...chat, dismissedGuardrailId: suggestion.replyId }));
    },

    setPromptDraft: (id, draft) => {
      set((state) => {
        const current = state.promptDrafts[id];
        if (current && current.text === draft.text && current.images === draft.images) return state;
        const promptDrafts = { ...state.promptDrafts };
        if (!draft.text && !draft.images.length) {
          if (!current) return state;
          delete promptDrafts[id];
        } else {
          promptDrafts[id] = draft;
        }
        return { promptDrafts };
      });
    },

    applyAnnotation: ({ huntSessionId, annotation }) => {
      set((state) => {
        const current = state.annotations[huntSessionId] ?? [];
        if (current.some((known) => known.id === annotation.id)) return state;
        return { annotations: { ...state.annotations, [huntSessionId]: [...current, annotation] } };
      });
    },

    removeAnnotation: (id, annotationId) => {
      set((state) => {
        const current = state.annotations[id];
        if (!current?.some((annotation) => annotation.id === annotationId)) return state;
        const remaining = current.filter((annotation) => annotation.id !== annotationId);
        const annotations = { ...state.annotations };
        if (remaining.length) {
          annotations[id] = remaining;
        } else {
          delete annotations[id];
        }
        return { annotations };
      });
    },

    clearAnnotations: (id) => {
      set((state) => {
        if (!state.annotations[id]) return state;
        const annotations = { ...state.annotations };
        delete annotations[id];
        return { annotations };
      });
    },

    refreshGraph: async (id, diagramType, instructions = "") => {
      const current = get().chats[id];
      if (current?.move || current?.generatingDiagrams.includes(diagramType)) return;
      const { model, effort } = useSettingsStore.getState().graphAgent;
      updateChat(id, (chat) => ({
        ...chat,
        generatingDiagrams: [...chat.generatingDiagrams, diagramType],
        diagramErrors: { ...chat.diagramErrors, [diagramType]: undefined },
      }));
      try {
        await commands.refreshGraph(id, diagramType, instructions, model, effort);
      } catch (error) {
        updateChat(id, (chat) => ({ ...chat, diagramErrors: { ...chat.diagramErrors, [diagramType]: String(error) } }));
      } finally {
        updateChat(id, (chat) => ({ ...chat, generatingDiagrams: chat.generatingDiagrams.filter((type) => type !== diagramType) }));
        usePlanUsageStore.getState().refresh();
      }
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

    noteWorktreeChanged: (id) => {
      updateChat(id, (chat) => ({ ...chat, editVersion: chat.editVersion + 1 }));
    },

    ensureChat: (id) => {
      if (get().chats[id]) return;
      updateChat(id, (chat) => chat);
    },

    markChatSeen: (id) => {
      if (!get().chats[id]?.hasUnseenActivity) return;
      get().applyChatSeen(id);
      void emit("chat:seen", { sessionId: id });
    },

    applyChatSeen: (id) => {
      if (!get().chats[id]?.hasUnseenActivity) return;
      updateChat(id, (chat) => ({ ...chat, hasUnseenActivity: false, unseenAfterMessageId: null }));
    },

    applyUpdate: (huntSessionId, notification) => {
      const update = notification.update;
      // A turn this window runs ends with its prompt call (see `runTurn`), which notes it then.
      const endsTurn =
        update.sessionUpdate === "session_info_update" &&
        huntTurnOf(update._meta) === "idle" &&
        !runningTurnIds.has(huntSessionId) &&
        (get().chats[huntSessionId]?.isBusy ?? false);
      applyUpdates(huntSessionId, [notification]);
      if (endsTurn) {
        noteTurnEnded(huntSessionId);
      }
    },

    applyReplay: (huntSessionId, notifications) => applyUpdates(huntSessionId, notifications),

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

    applyMessageTimes: ({ huntSessionId, times }) => {
      if (!get().chats[huntSessionId]) return;
      updateChat(huntSessionId, (chat) => ({
        ...chat,
        items: chat.items.map((item) => ((item.kind === "user" || item.kind === "agent") && item.messageId && times[item.messageId] ? { ...item, at: times[item.messageId] } : item)),
      }));
    },

    applyGraphChanged: (huntSessionId) => {
      updateChat(huntSessionId, (chat) => ({ ...chat, graphVersion: chat.graphVersion + 1 }));
    },

    applyWorktreeChanged: (worktreePath) => {
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
  };
}
