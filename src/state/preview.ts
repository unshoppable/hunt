import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../ipc/commands";
import type { PreviewStatus } from "../ipc/types";
import { appendLogChunk, EMPTY_LOG, type LogView } from "../preview/previewLogs";
import { errorText } from "../ui/useLoad";
import { configuredPreviewDomain, useSettingsStore } from "./settings";

/** What Hunt knows about the preview of one remote session. */
export type SessionPreview = {
  status: PreviewStatus | null;
  /** A start or stop runs. */
  isBusy: boolean;
  error: string | null;
  /** `open` asked for the browser: the main URL opens once the preview is ready. */
  opensWhenReady: boolean;
  /** Shown parts of the logs, by process name or `setup`. */
  logs: Record<string, LogView>;
};

export const EMPTY_PREVIEW: SessionPreview = { status: null, isBusy: false, error: null, opensWhenReady: false, logs: {} };

type PreviewState = {
  previews: Record<string, SessionPreview>;
  /** Starts the preview when it does not run and opens its main URL in the browser once it is ready. */
  open: (id: string) => Promise<void>;
  /** Starts the preview with the optional processes in `withProcesses`, without opening the browser. */
  start: (id: string, withProcesses: string[]) => Promise<void>;
  stop: (id: string) => Promise<void>;
  restart: (id: string, process: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
  /** Appends what the log `name` gained since the last read. */
  loadLog: (id: string, name: string) => Promise<void>;
};

/** The preview domain from the settings, or an error text that says where to set it. */
function previewDomain(): string | Error {
  return configuredPreviewDomain(useSettingsStore.getState().remote) ?? new Error("Set the preview domain in Settings → Remote VM first.");
}

/** The previews of remote sessions; the panel polls them while it shows one (see preview/PreviewPanel.tsx). */
export const usePreviewStore = create<PreviewState>((set, get) => {
  function update(id: string, change: (preview: SessionPreview) => SessionPreview) {
    set((state) => ({ previews: { ...state.previews, [id]: change(state.previews[id] ?? EMPTY_PREVIEW) } }));
  }

  /** Takes a status and opens the browser when `open` waits for a ready preview. */
  function apply(id: string, status: PreviewStatus) {
    const preview = get().previews[id] ?? EMPTY_PREVIEW;
    const opensNow = preview.opensWhenReady && status.state === "ready" && Boolean(status.mainUrl);
    update(id, (current) => ({ ...current, status, error: null, opensWhenReady: current.opensWhenReady && !opensNow && status.active }));
    if (opensNow && status.mainUrl) {
      void openUrl(status.mainUrl).catch((reason) => update(id, (current) => ({ ...current, error: errorText(reason) })));
    }
  }

  async function startPreview(id: string, withProcesses: string[], opensWhenReady: boolean) {
    const domain = previewDomain();
    if (domain instanceof Error) {
      update(id, (current) => ({ ...current, error: domain.message }));
      return;
    }
    update(id, (current) => ({ ...current, isBusy: true, error: null, opensWhenReady }));
    try {
      apply(id, await commands.startPreview(id, domain, withProcesses));
    } catch (reason) {
      update(id, (current) => ({ ...current, error: errorText(reason), opensWhenReady: false }));
    } finally {
      update(id, (current) => ({ ...current, isBusy: false }));
    }
  }

  return {
    previews: {},

    open: async (id) => {
      const status = get().previews[id]?.status;
      if (status?.active && status.state === "ready" && status.mainUrl) {
        await openUrl(status.mainUrl).catch((reason) => update(id, (current) => ({ ...current, error: errorText(reason) })));
        return;
      }
      await startPreview(id, [], true);
    },

    start: (id, withProcesses) => startPreview(id, withProcesses, false),

    stop: async (id) => {
      update(id, (current) => ({ ...current, isBusy: true, error: null, opensWhenReady: false }));
      try {
        await commands.stopPreview(id);
        await get().refresh(id);
      } catch (reason) {
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      } finally {
        update(id, (current) => ({ ...current, isBusy: false }));
      }
    },

    restart: async (id, process) => {
      try {
        await commands.restartPreviewProcess(id, process);
        await get().refresh(id);
      } catch (reason) {
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      }
    },

    refresh: async (id) => {
      const domain = previewDomain();
      if (domain instanceof Error) return;
      try {
        apply(id, await commands.previewStatus(id, domain));
      } catch (reason) {
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      }
    },

    loadLog: async (id, name) => {
      const view = get().previews[id]?.logs[name];
      try {
        const chunk = await commands.readPreviewLog(id, name, view ? view.end : null);
        update(id, (current) => ({ ...current, logs: { ...current.logs, [name]: appendLogChunk(current.logs[name] ?? EMPTY_LOG, chunk) } }));
      } catch (reason) {
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      }
    },
  };
});
