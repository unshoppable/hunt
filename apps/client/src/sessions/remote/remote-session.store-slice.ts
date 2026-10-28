import { commands } from "../../ipc/commands";
import type { PreviewStatus } from "../../preview/preview.types";
import type { RelayActivityEvent, RemoteLink, RemoteLinkEvent, RemoteProgressEvent, RemoteSyncEvent } from "./remote-session.types";
import type { SessionView } from "../session.types";
import type { ChatTurns } from "../../chat/chat.store-slice";
import type { HuntGet, HuntSet } from "../hunt.store";
import { HANDOFF_START_PROMPT, hasRunningService } from "../../preview/preview-services.utils";
import { useAgentDefaultsStore } from "../../chat/agent-defaults.store";
import { advanceRemoteRun } from "./remote-run.utils";
import { configuredVmSettings, useSettingsStore } from "../../settings/settings.store";

/**
 * The sync of a remote session's files with its VM: whether one runs, when the last one succeeded, what the last one
 * failed with and the files it could not sync.
 */
export type FileSync = { isRunning: boolean; syncedAt: string | null; error: string | null; conflicts: string[] };

/** The last sync with the gateway's listing of session VMs (see `syncRemoteSessions`): whether one runs and what the last one failed with. */
export type RemoteSync = { isRunning: boolean; error: string | null };

/** Where a session moves: to a VM of its own (`handOff`) or back into its local worktree (`retrieve`). */
export type SessionMove = "handOff" | "retrieve";

/** The remote session slice of the Hunt store: the session VMs, the moves to and from them and what their relays report. */
export type RemoteSessionSlice = {
  remoteSync: RemoteSync;
  /**
   * Whether the local worktree of each top-level remote session may change, by session id; a session whose link is not
   * known yet has none (see `isWorktreeLocked` in sessions/remote/remote-session.utils.ts).
   */
  remoteLinks: Record<string, RemoteLink>;

  /**
   * Brings the agent state of the remote sessions up to date from the gateway's listing and adopts the session VMs of
   * `ids` that no local session knows (started by the swf poller or another person's Hunt) as remote sessions, in the
   * local checkout of their repository among the recently used ones. Does nothing while the remote settings are
   * incomplete or a sync runs; a failure lands in `remoteSync.error`.
   */
  syncRemoteSessions: (ids?: string[]) => Promise<void>;
  /**
   * Shows the session of the VM `id` the gateway lists: a session this Mac knows is selected; another one is adopted
   * into the sidebar first (`syncRemoteSessions`). Rejects when the gateway no longer lists it or the adoption failed.
   */
  openSessionVm: (id: string) => Promise<void>;
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
  /**
   * Continues the remote session, whose VM cannot be reached, in its local worktree with the files as last synced, once
   * its agent finished the running turn; the chat starts over and fills again from the local agent.
   */
  continueLocally: (id: string) => Promise<void>;

  applyRemoteProgress: (event: RemoteProgressEvent) => void;
  /** Records the state of a remote session's file sync; a sync that changed local files reloads the views. */
  applyRemoteSync: (event: RemoteSyncEvent) => void;
  applyRemoteLink: (event: RemoteLinkEvent) => void;
  /** Takes over what the relay of a remote session reported through its status channel (see `RemoteTarget.relayActivity`). */
  applyRelayActivity: (event: RelayActivityEvent) => void;
};

/** The loader of the remote links, which the session slice runs after every reload of the listed sessions. */
export function createRemoteLinkLoader(set: HuntSet, get: HuntGet): () => void {
  /** Ids of the sessions whose link `loadRemoteLinks` is asking the backend for. */
  const loadingLinkIds = new Set<string>();

  /**
   * Asks the backend for the link of every listed top-level remote session whose link is not known yet and forgets the
   * links of sessions that no longer run on a VM. A failed load leaves the link unknown until a `remote:link` event
   * brings it.
   */
  function loadRemoteLinks() {
    const remoteIds = new Set(get().sessions.filter((session) => session.remote && !session.parentId).map((session) => session.id));
    if (Object.keys(get().remoteLinks).some((id) => !remoteIds.has(id))) {
      set((state) => ({ remoteLinks: Object.fromEntries(Object.entries(state.remoteLinks).filter(([id]) => remoteIds.has(id))) }));
    }
    for (const id of remoteIds) {
      if (get().remoteLinks[id] || loadingLinkIds.has(id)) continue;
      loadingLinkIds.add(id);
      void commands
        .remoteLink(id)
        .then(
          (link) => {
            // A `remote:link` event that arrived meanwhile is newer.
            if (!link || get().remoteLinks[id]) return;
            set((state) => ({ remoteLinks: { ...state.remoteLinks, [id]: link } }));
          },
          (error: unknown) => console.warn(`failed to load the link of session ${id}: ${String(error)}`),
        )
        .finally(() => loadingLinkIds.delete(id));
    }
  }

  return loadRemoteLinks;
}

export function createRemoteSessionSlice(set: HuntSet, get: HuntGet, turns: ChatTurns): RemoteSessionSlice {
  const { updateChat, whenIdle, restartChat, updateChatTakingQueue, runPrompt, runPromptTurn } = turns;

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
    const next = updateChatTakingQueue(id, (chat) => ({ ...chat, move: null, remoteRun: null }), isMoved && isLive);
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

  return {
    remoteSync: { isRunning: false, error: null },
    remoteLinks: {},

    syncRemoteSessions: async (ids = []) => {
      const settings = configuredVmSettings(useSettingsStore.getState().remote);
      if (!settings || get().remoteSync.isRunning) return;
      // The last failure stays shown until this sync ended, so a periodic sync does not hide it meanwhile.
      set((state) => ({ remoteSync: { isRunning: true, error: state.remoteSync.error } }));
      try {
        await commands.adoptSessionVms(settings, useAgentDefaultsStore.getState().recentRepoPaths, ids);
        set({ remoteSync: { isRunning: false, error: null } });
        await get().refreshSessions();
      } catch (error) {
        set({ remoteSync: { isRunning: false, error: String(error) } });
      }
    },

    openSessionVm: async (id) => {
      const isKnown = () => get().sessions.some((session) => session.id === id);
      if (!isKnown()) {
        await get().syncRemoteSessions([id]);
        if (!isKnown()) throw new Error(get().remoteSync.error ?? `the gateway no longer lists session ${id}`);
      }
      await get().selectSession(id);
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
        () => commands.handOffSession(id, settings),
      );
    },

    retrieveSession: (id) => moveSession(id, "retrieve", null, () => commands.retrieveSession(id)),

    continueLocally: (id) => moveSession(id, "retrieve", null, () => commands.continueLocally(id)),

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
          : { isRunning: false, syncedAt: event.syncedAt ?? chat.fileSync.syncedAt, error: event.error, conflicts: event.conflicts },
      }));
      if (!event.changedLocal) return;
      // The views of every session in the synced worktree reload: the remote session's and those of its sub chats.
      const worktreePath = get().sessions.find((session) => session.id === event.huntSessionId)?.worktreePath;
      set((state) => {
        const chats = { ...state.chats };
        const inWorktree = state.sessions.filter((session) => worktreePath && session.worktreePath === worktreePath).map((session) => session.id);
        for (const id of new Set([event.huntSessionId, ...inWorktree])) {
          const chat = chats[id];
          if (!chat) continue;
          chats[id] = { ...chat, editVersion: chat.editVersion + 1 };
        }
        return { chats };
      });
    },

    applyRemoteLink: (event) => {
      set((state) => ({ remoteLinks: { ...state.remoteLinks, [event.huntSessionId]: event.link } }));
    },

    applyRelayActivity: ({ huntSessionId, relayActivity }) => {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === huntSessionId && session.remote ? { ...session, remote: { ...session.remote, relayActivity } } : session,
        ),
      }));
    },
  };
}
