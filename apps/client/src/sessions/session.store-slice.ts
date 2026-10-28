import { commands } from "../ipc/commands";
import type { ChatItem, ClosedEvent } from "../chat/chat.types";
import type { SelectionContext } from "../editor/selection-context.types";
import type { PullRequestState } from "./pull-requests.types";
import type { PullRequestRef, SessionEnding, SessionView, SummaryEvent, Workspace } from "./session.types";
import type { ChatTurns, PromptDraft, SessionChat } from "../chat/chat.store-slice";
import type { HuntGet, HuntSet, HuntState } from "./hunt.store";
import { createEmptyChat } from "../chat/chat-reducer.utils";
import { repoName } from "../common/path/path.utils";
import { issueFromPrompt, titleFromPrompt } from "./session-labels.utils";
import { useAgentDefaultsStore } from "../chat/agent-defaults.store";
import { createRemoteLinkLoader } from "./remote/remote-session.store-slice";

/** Agent settings a new session starts with: the value of every select option by option id, and the mode. */
export type AgentSetup = { configValues: Record<string, string>; modeId: string };

/**
 * What a new session starts with: the agent setup, applied first, and the prompt shown in its chat at once and sent as
 * soon as the agent runs; `draft` is text left unsent in the start view's prompt box, which the session's box starts with.
 */
export type SessionStart = { setup: AgentSetup; prompt: PromptDraft | null; draft?: PromptDraft | null };

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
  /**
   * A branch of that name the session creates instead of the generated one: off `baseRef` in a worktree, at `HEAD` of
   * the checkout. The session works on it as its base, pushes land on it under its own name and deleting the session
   * keeps it.
   */
  newBranch: string | null;
};

/** The agent setup a chat currently runs with, so a sub session can start like its parent. */
export function agentSetupOf(chat: Pick<SessionChat, "configOptions" | "modeId">): AgentSetup {
  const configValues: Record<string, string> = {};
  for (const option of chat.configOptions) {
    if (option.type !== "select") continue;
    configValues[option.id] = option.currentValue;
  }
  return { configValues, modeId: chat.modeId };
}

/** The session slice of the Hunt store: the listed sessions, their creation, selection and ending, and the start view. */
export type SessionSlice = {
  sessions: SessionView[];
  /** Ids of listed sessions whose creation (worktree, agent) still runs in the backend; they have no worktree or agent yet. */
  creatingIds: string[];
  /** Ids of sessions already taken off the list whose deletion (agent, worktree, branch) still runs in the backend. */
  removingIds: string[];
  activeSessionId: string | null;
  /**
   * The "unread" line of the active session's chat: below the prompt `afterMessageId`, where its unseen activity began
   * when the user selected it (see `SessionChat.unseenAfterMessageId`). It stays until the user sends a prompt there or
   * selects another session.
   */
  unreadLine: { sessionId: string; afterMessageId: string } | null;
  /**
   * Set while the chat pane shows the start view for a new session; `parentId` names the session a sub session is
   * drafted for. A failed creation brings the view back with its `error` and the `prompt` that was not sent.
   */
  draft: { parentId: string | null; error?: string; prompt?: PromptDraft | null } | null;
  /** The repository the user chose in the start view; `null` until they chose one (see `useStartRepoPath`). */
  startRepoPath: string | null;
  /** Ids of sessions created without a prompt, titled after their repository until their first prompt names them. */
  untitledIds: string[];
  /** State of the pull request each reviewing session works on, by session id, as last fetched from GitHub. */
  pullRequestStates: Record<string, PullRequestState>;

  /** Reloads the stored sessions; a session still being created stays listed until the backend lists it itself. */
  refreshSessions: () => Promise<void>;
  /**
   * Fetches the state of every reviewed pull request from GitHub for the sidebar's badges; a failed fetch keeps the
   * state last seen.
   */
  refreshPullRequestStates: () => Promise<void>;
  /** Records the state of the pull request `sessionId` reviews, as a view of its details just reported it. */
  notePullRequestState: (sessionId: string, state: PullRequestState) => void;
  selectSession: (id: string) => Promise<void>;
  /**
   * Loads the chat of every listed session, so that every mark shows the state of its agent before the session is opened:
   * a running agent's chat from the backend's history, a stopped local session's (sub sessions included) by starting its
   * agent. A stopped remote session stays as it is, since connecting would wake its VM; its mark takes the agent state
   * the gateway recorded (`syncRemoteSessions`).
   */
  loadAllChats: () => Promise<void>;
  /** Starts the agent of a stopped session again; its chat starts empty because the agent's conversation is gone. */
  resumeSession: (id: string) => Promise<void>;
  /** Starts the conversation over (`/clear`): the agent is restarted with a new, empty conversation. */
  clearSession: (id: string) => Promise<void>;
  /** Opens or focuses the Chrome of the local session `id`; a failure lands in the chat's `error`. */
  openBrowser: (id: string) => Promise<void>;
  /** Opens the start view in which the first prompt or the choice of a repository creates the session, or a sub session of `parentId`. */
  startDraft: (parentId?: string) => void;
  /** Makes `path` the repository of the start view, whose Git tab shows its checkout while no session is active. */
  setStartRepoPath: (path: string) => void;
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
  /** Ends the session as `ending` says (see `SessionEnding`); `delete` and `forget` take it off the list at once. */
  closeSession: (id: string, ending: SessionEnding) => Promise<void>;

  applyClosed: (event: ClosedEvent) => void;
  applySummary: (event: SummaryEvent) => void;
};

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
    branch: parent?.branch ?? target.pullRequestBranch ?? target.newBranch ?? "",
    baseRef: target.newBranch ?? target.baseRef,
    pushTarget: parent?.pushTarget ?? null,
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

/** The chats, prompt drafts and annotations of `state` without those of the sessions `ids`. */
function withoutSessions(state: HuntState, ids: string[]): Pick<HuntState, "chats" | "promptDrafts" | "annotations"> {
  const chats = { ...state.chats };
  const promptDrafts = { ...state.promptDrafts };
  const annotations = { ...state.annotations };
  for (const id of ids) {
    delete chats[id];
    delete promptDrafts[id];
    delete annotations[id];
  }
  return { chats, promptDrafts, annotations };
}

/**
 * The naming of sessions after the GitHub issue or the first prompt they start with; `updateChat` reports a failed
 * rename in the session's chat.
 */
export function createSessionNaming(set: HuntSet, updateChat: (id: string, updater: (chat: SessionChat) => SessionChat) => void) {
  /**
   * Names the session `id` after the GitHub issue or pull request its first prompt `text` starts with, `#<number>
   * <title>`, once `gh` looked the title up from `repoPath`; a prompt without one, or a failed lookup, which lands in
   * the chat's error, leaves the title as it is.
   */
  async function nameAfterIssue(id: string, repoPath: string, text: string) {
    const issue = issueFromPrompt(text);
    if (!issue) return;
    try {
      const title = await commands.issueTitle(repoPath, issue.repository.owner, issue.repository.name, issue.number);
      const session = await commands.renameSession(id, titleFromPrompt(`${issue.label} ${title}`));
      set((state) => ({ sessions: state.sessions.map((candidate) => (candidate.id === id ? session : candidate)) }));
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: String(error) }));
    }
  }

  /** Names the untitled session `id` after its first prompt; the backend keeps the branch slug of the placeholder title. */
  async function nameAfterPrompt(id: string, text: string) {
    set((state) => ({ untitledIds: state.untitledIds.filter((candidate) => candidate !== id) }));
    let session: SessionView;
    try {
      session = await commands.renameSession(id, titleFromPrompt(text) || "Screenshot");
      set((state) => ({ sessions: state.sessions.map((candidate) => (candidate.id === id ? session : candidate)) }));
    } catch (error) {
      updateChat(id, (chat) => ({ ...chat, error: String(error) }));
      return;
    }
    await nameAfterIssue(id, session.repoPath, text);
  }

  return { nameAfterIssue, nameAfterPrompt };
}

export function createSessionSlice(set: HuntSet, get: HuntGet, turns: ChatTurns): SessionSlice {
  const { updateChat, runTurn, updateChatTakingQueue, runPrompt, restartChat, ownPromptItem } = turns;
  const { nameAfterIssue } = createSessionNaming(set, updateChat);
  const loadRemoteLinks = createRemoteLinkLoader(set, get);

  /**
   * Lists the placeholder of a session the backend is creating, with the chat its first prompt is already shown in.
   * With `isActivated` it becomes the active session and replaces the start view.
   */
  function listPlaceholder(placeholder: SessionView, { prompt, draft }: SessionStart, isActivated: boolean) {
    const items: ChatItem[] = prompt ? [ownPromptItem(prompt)] : [];
    set((state) => ({
      sessions: [...state.sessions, placeholder],
      creatingIds: [...state.creatingIds, placeholder.id],
      chats: { ...state.chats, [placeholder.id]: { ...createEmptyChat(), items, hasHistory: true } },
      promptDrafts: draft ? { ...state.promptDrafts, [placeholder.id]: draft } : state.promptDrafts,
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
        const isActive = state.activeSessionId === id;
        return {
          sessions: state.sessions.filter((candidate) => candidate.id !== id),
          creatingIds: state.creatingIds.filter((candidate) => candidate !== id),
          untitledIds: state.untitledIds.filter((candidate) => candidate !== id),
          ...withoutSessions(state, [id]),
          ...(isActive ? { activeSessionId: null, draft: { parentId: draftParentId, error: String(error), prompt: start.prompt ?? start.draft ?? null } } : {}),
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
    if (start.prompt) {
      void nameAfterIssue(id, session.repoPath, start.prompt.text);
    }
    return id;
  }

  /**
   * Applies the setup to the freshly created session and sends its first prompt, or without one the first prompt queued
   * while the session was created (the turn of the first prompt sends the queue on); a failure lands in the chat's error.
   */
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
    if (prompt) {
      const images = prompt.images.map((image) => image.path);
      // The prompt shows since `listPlaceholder` listed the session, under the message id it got there.
      const shown = get().chats[id]?.items.find((item) => item.kind === "user");
      const messageId = (shown?.kind === "user" && shown.messageId) || crypto.randomUUID();
      await runTurn(id, null, () => commands.sendPrompt(id, prompt.text, images, messageId));
      return;
    }
    const isLive = Boolean(get().sessions.find((candidate) => candidate.id === id)?.isLive);
    const next = updateChatTakingQueue(id, (chat) => chat, isLive);
    if (next) {
      await runPrompt(id, next);
    }
  }

  /** The title a session is created with: `title`, or for an untitled session (`null`) the name of its repository. */
  function placeholderTitle(id: string, title: string | null, repoPath: string): string {
    if (title !== null) return title;
    set((state) => ({ untitledIds: [...state.untitledIds, id] }));
    return repoName(repoPath);
  }

  return {
    sessions: [],
    creatingIds: [],
    removingIds: [],
    activeSessionId: null,
    unreadLine: null,
    draft: null,
    startRepoPath: null,
    untitledIds: [],
    pullRequestStates: {},

    refreshSessions: async () => {
      const listed = await commands.listSessions();
      set((state) => {
        const creating = state.sessions.filter((session) => state.creatingIds.includes(session.id) && !listed.some((candidate) => candidate.id === session.id));
        return { sessions: [...listed.filter((session) => !state.removingIds.includes(session.id)), ...creating] };
      });
      loadRemoteLinks();
    },

    refreshPullRequestStates: async () => {
      const reviewing = get().sessions.filter((session) => session.pullRequest && !session.parentId);
      const states = await Promise.all(
        reviewing.map((session) => commands.pullRequestState(session.id).then((state) => [session.id, state] as const, () => null)),
      );
      set((state) => ({ pullRequestStates: { ...state.pullRequestStates, ...Object.fromEntries(states.filter((entry) => entry !== null)) } }));
    },

    notePullRequestState: (sessionId, state) => {
      set((current) => ({ pullRequestStates: { ...current.pullRequestStates, [sessionId]: state } }));
    },

    startDraft: (parentId) => {
      set({ draft: { parentId: parentId ?? null } });
    },

    setStartRepoPath: (path) => {
      set({ startRepoPath: path });
    },

    selectSession: async (id) => {
      const { activeSessionId, unreadLine, chats } = get();
      const afterMessageId = chats[id]?.unseenAfterMessageId;
      set({
        activeSessionId: id,
        unreadLine: id === activeSessionId ? unreadLine : afterMessageId ? { sessionId: id, afterMessageId } : null,
        draft: null,
      });
      get().markChatSeen(id);
      const session = get().sessions.find((candidate) => candidate.id === id);
      if (!session || get().creatingIds.includes(id)) return;
      if (session.isLive) {
        await get().loadHistory(id);
      } else {
        await get().resumeSession(id);
      }
    },

    loadAllChats: async () => {
      const { sessions, creatingIds } = get();
      const loads = sessions.map((session) => {
        if (creatingIds.includes(session.id)) return null;
        if (session.isLive) return get().loadHistory(session.id);
        if (session.remote || !session.hasLocalWorktree) return null;
        return get().resumeSession(session.id);
      });
      await Promise.all(loads);
    },

    resumeSession: async (id) => {
      await restartChat(id, () => commands.openSession(id), true, true);
    },

    clearSession: async (id) => {
      await restartChat(id, () => commands.clearSession(id));
    },

    openBrowser: async (id) => {
      try {
        await commands.browserOpen(id);
      } catch (error) {
        updateChat(id, (chat) => ({ ...chat, error: String(error) }));
      }
    },

    createSession: async (target, title, start) => {
      const id = crypto.randomUUID();
      const { repoPath, baseRef, pullRequest, diffBaseRef, pullRequestBranch, newBranch, workspace } = target;
      const listedTitle = placeholderTitle(id, title, repoPath);
      useAgentDefaultsStore.getState().rememberRepoPath(repoPath);
      listPlaceholder(placeholderSession(id, listedTitle, target, null, null), start, true);
      const create = () => commands.createSession(id, repoPath, baseRef, listedTitle, pullRequest, diffBaseRef, pullRequestBranch, newBranch, workspace);
      return completeCreation(id, create, start, null);
    },

    createSubSession: async (parentId, title, selection, start, isActivated) => {
      const parent = get().sessions.find((candidate) => candidate.id === parentId);
      if (!parent) throw new Error(`failed to create sub session: the session ${parentId} is not listed`);
      const id = crypto.randomUUID();
      const target: WorktreeTarget = {
        repoPath: parent.repoPath,
        baseRef: parent.baseRef,
        workspace: parent.workspace,
        pullRequest: parent.pullRequest,
        diffBaseRef: parent.diffBase,
        pullRequestBranch: null,
        newBranch: null,
      };
      const listedTitle = placeholderTitle(id, title, parent.repoPath);
      listPlaceholder(placeholderSession(id, listedTitle, target, parent, selection), start, isActivated);
      return completeCreation(id, () => commands.createSubSession(id, parentId, listedTitle, selection), start, parentId);
    },

    closeSession: async (id, ending) => {
      if (get().creatingIds.includes(id)) return;
      if (ending === "stop") {
        await commands.closeSession(id, "stop");
        set((state) => withoutSessions(state, [id]));
        await get().refreshSessions();
        return;
      }

      const { sessions, activeSessionId: previousActiveId } = get();
      const removedIds = [id, ...sessions.filter((session) => session.parentId === id).map((session) => session.id)];
      set((state) => ({
        ...withoutSessions(state, removedIds),
        sessions: state.sessions.filter((session) => !removedIds.includes(session.id)),
        removingIds: [...state.removingIds, ...removedIds],
        activeSessionId: state.activeSessionId && removedIds.includes(state.activeSessionId) ? null : state.activeSessionId,
      }));
      try {
        await commands.closeSession(id, ending);
      } catch (error) {
        set((state) => ({
          removingIds: state.removingIds.filter((candidate) => !removedIds.includes(candidate)),
          ...(previousActiveId && removedIds.includes(previousActiveId) && !state.activeSessionId ? { activeSessionId: previousActiveId } : {}),
        }));
        await get().refreshSessions();
        updateChat(id, (chat) => ({ ...chat, error: `${ending === "forget" ? "Removing" : "Deleting"} the session failed: ${String(error)}` }));
        return;
      }
      set((state) => ({ removingIds: state.removingIds.filter((candidate) => !removedIds.includes(candidate)) }));
      await get().refreshSessions();
    },

    applyClosed: (event) => {
      if (!get().chats[event.huntSessionId]) return;
      // An agent on a VM loses its connection whenever its idle VM shuts down; the chat says so without an error.
      const isRemote = Boolean(get().sessions.find((candidate) => candidate.id === event.huntSessionId)?.remote);
      updateChat(event.huntSessionId, (chat) => ({
        ...chat,
        isBusy: false,
        permission: null,
        error: event.error && !isRemote ? `Agent stopped: ${event.error}` : chat.error,
        // A sync that ran stops with the connection.
        fileSync: { ...chat.fileSync, isRunning: false },
      }));
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === event.huntSessionId ? { ...session, isLive: false } : session,
        ),
      }));
    },

    applySummary: (event) => {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === event.huntSessionId ? { ...session, title: event.title, summary: event.summary } : session,
        ),
      }));
    },
  };
}
