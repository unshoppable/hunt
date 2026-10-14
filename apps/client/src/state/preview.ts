import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../ipc/commands";
import type { PreviewStatus } from "../ipc/types";
import { errorText } from "../ui/useLoad";
import { useHuntStore } from "./store";

/** What Hunt asks the agent of a remote session when nothing answers on the preview's main port. */
export const START_APP_PROMPT = "Start the app for the preview as described in the repository (HUNT.md, README).";

/** What Hunt knows about the preview of one remote session. */
export type SessionPreview = {
  status: PreviewStatus | null;
  error: string | null;
  isRefreshing: boolean;
  /** The agent was asked to start the app: the main URL opens in the browser once the main port answers. */
  opensWhenReady: boolean;
};

export const EMPTY_PREVIEW: SessionPreview = { status: null, error: null, isRefreshing: false, opensWhenReady: false };

type PreviewState = {
  previews: Record<string, SessionPreview>;
  /** Reads what listens on the session's VM; opens the main URL when `startApp` waits for it and the main port answers. */
  refresh: (id: string) => Promise<void>;
  /** Opens the main URL in the browser when the main port answers, else asks the agent to start the app first. */
  openPreview: (id: string) => Promise<void>;
  /** Sends the agent `START_APP_PROMPT`, shows the Preview tab, which polls, and opens the main URL once the main port answers. */
  startApp: (id: string) => void;
  /** Gives up opening the main URL once it answers. */
  stopWaiting: (id: string) => void;
};

/** The previews of remote sessions; the panel polls them while it shows one (see preview/PreviewPanel.tsx). */
export const usePreviewStore = create<PreviewState>((set, get) => {
  function update(id: string, change: (preview: SessionPreview) => SessionPreview) {
    set((state) => ({ previews: { ...state.previews, [id]: change(state.previews[id] ?? EMPTY_PREVIEW) } }));
  }

  function open(id: string, url: string) {
    void openUrl(url).catch((reason) => update(id, (current) => ({ ...current, error: errorText(reason) })));
  }

  return {
    previews: {},

    refresh: async (id) => {
      update(id, (current) => ({ ...current, isRefreshing: true }));
      try {
        const status = await commands.previewStatus(id);
        const opensNow = Boolean(get().previews[id]?.opensWhenReady) && status.mainResponds;
        update(id, (current) => ({ ...current, status, error: null, opensWhenReady: current.opensWhenReady && !opensNow }));
        if (opensNow) {
          open(id, status.mainUrl);
        }
      } catch (reason) {
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      } finally {
        update(id, (current) => ({ ...current, isRefreshing: false }));
      }
    },

    openPreview: async (id) => {
      await get().refresh(id);
      const { status, error } = get().previews[id] ?? EMPTY_PREVIEW;
      if (!status || error) return;
      if (status.mainResponds) {
        open(id, status.mainUrl);
        return;
      }
      get().startApp(id);
    },

    startApp: (id) => {
      update(id, (current) => ({ ...current, error: null, opensWhenReady: true }));
      useHuntStore.getState().setRemoteTab("preview");
      // The normal prompt path: it starts a VM that is off and queues the prompt while the agent is busy.
      void useHuntStore.getState().sendPrompt(id, START_APP_PROMPT);
    },

    stopWaiting: (id) => {
      update(id, (current) => ({ ...current, opensWhenReady: false }));
    },
  };
});
