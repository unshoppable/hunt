import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { PreviewStatus, TmuxWindow } from "../ipc/types";
import { hasRespondingService, withLastKnown } from "../preview/services";
import { errorText } from "../ui/useLoad";
import { useHuntStore } from "./store";

/** What Hunt asks the agent of a remote session when none of its services runs. */
export const START_APP_PROMPT =
  "Start what this task needs for the preview: the services from hunt.json, as the repository's hunt.agent.md groups them, " +
  "with `sudo -n hunt-ctl service start <name>…`, or the app as the repository describes it when hunt.json declares none.";

/** What Hunt knows about the preview of one remote session. */
export type SessionPreview = {
  status: PreviewStatus | null;
  error: string | null;
  isRefreshing: boolean;
  /** The agent was asked to start the services: the Preview tab polls often until one of them answers. */
  awaitingStart: boolean;
  /** The windows of the VM's tmux session `app` in tmux's order; null until the Terminal tab first read them. */
  windows: TmuxWindow[] | null;
};

export const EMPTY_PREVIEW: SessionPreview = { status: null, error: null, isRefreshing: false, awaitingStart: false, windows: null };

type PreviewState = {
  previews: Record<string, SessionPreview>;
  /**
   * Reads the services and ports of the session's VM. Keeps the last known services while the VM is off and ends
   * `awaitingStart` once a service answers.
   */
  refresh: (id: string) => Promise<void>;
  /** Reads the windows of the tmux session `app` on the session's VM; only the latest read lands. Rejects on failure. */
  refreshWindows: (id: string) => Promise<void>;
  /** Sends the agent `START_APP_PROMPT` and shows the Preview tab, which polls often until a service answers. */
  startApp: (id: string) => void;
  /** Ends `awaitingStart` before a service answers. */
  stopWaiting: (id: string) => void;
};

/** Bumped per session by every read of its tmux windows, so that only the latest one lands. */
const windowReads = new Map<string, number>();

/**
 * The previews of remote sessions; the Preview and Terminal tabs poll them (see preview/PreviewPanel.tsx and
 * terminal/TerminalPanel.tsx).
 */
export const usePreviewStore = create<PreviewState>((set) => {
  function update(id: string, change: (preview: SessionPreview) => SessionPreview) {
    set((state) => ({ previews: { ...state.previews, [id]: change(state.previews[id] ?? EMPTY_PREVIEW) } }));
  }

  return {
    previews: {},

    refresh: async (id) => {
      update(id, (current) => ({ ...current, isRefreshing: true }));
      try {
        const next = await commands.previewStatus(id);
        update(id, (current) => ({
          ...current,
          status: withLastKnown(current.status, next),
          error: null,
          awaitingStart: current.awaitingStart && !hasRespondingService(next),
        }));
      } catch (reason) {
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      } finally {
        update(id, (current) => ({ ...current, isRefreshing: false }));
      }
    },

    refreshWindows: async (id) => {
      const generation = (windowReads.get(id) ?? 0) + 1;
      windowReads.set(id, generation);
      try {
        const windows = await commands.terminalWindows(id);
        if (windowReads.get(id) !== generation) return;
        update(id, (current) => ({ ...current, windows }));
      } catch (reason) {
        if (windowReads.get(id) !== generation) return;
        throw reason;
      }
    },

    startApp: (id) => {
      update(id, (current) => ({ ...current, error: null, awaitingStart: true }));
      useHuntStore.getState().setRightTab("preview");
      // The normal prompt path: it starts a VM that is off and queues the prompt while the agent is busy.
      void useHuntStore.getState().sendPrompt(id, START_APP_PROMPT);
    },

    stopWaiting: (id) => {
      update(id, (current) => ({ ...current, awaitingStart: false }));
    },
  };
});
