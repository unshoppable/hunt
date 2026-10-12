import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyMonacoBackground } from "../diff/monaco";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import { useSettingsStore, type PaneKey } from "../state/settings";
import { useHuntStore } from "../state/store";

/** Writes the pane settings into the CSS variables every pane reads (`--<pane>-font-size` …, see index.css) and into Monaco's theme. */
export function usePaneStyles(): void {
  const panes = useSettingsStore((state) => state.panes);

  useEffect(() => {
    const root = document.documentElement.style;
    for (const pane of Object.keys(panes) as PaneKey[]) {
      const settings = panes[pane];
      root.setProperty(`--${pane}-font-size`, `${settings.fontSize}px`);
      root.setProperty(`--${pane}-line-height`, String(settings.lineHeight));
      root.setProperty(`--${pane}-indent`, `${settings.indent}px`);
      root.setProperty(`--${pane}-bg`, settings.background);
      root.setProperty(`--${pane}-font-family`, settings.fontFamily);
    }
    applyMonacoBackground(panes.diff.background);
  }, [panes]);
}

/** Set while this window's store takes over another window's change, so the change is not announced a second time. */
let isTakingOverSettings = false;

/**
 * Keeps every window's copy of the settings store in step: a change in one window is written to storage by `persist`
 * and announced as `settings:changed`, and the other windows re-read storage.
 */
export function useSettingsSync(): void {
  useEffect(() => {
    const label = getCurrentWindow().label;
    const unsubscribe = useSettingsStore.subscribe(() => {
      if (isTakingOverSettings) return;
      void emit("settings:changed", { source: label });
    });
    const subscription = listenTo("settings:changed", (event) => {
      if (event.source === label) return;
      isTakingOverSettings = true;
      void Promise.resolve(useSettingsStore.persist.rehydrate()).finally(() => {
        isTakingOverSettings = false;
      });
    });
    return () => {
      unsubscribe();
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
}

/**
 * Pushes the agent preferences to the backend at start and on every change: the language its own prompts
 * (diagram, summaries, titles) ask for and the system prompt addition of every new session.
 */
export function useAgentPreferencesSync(): void {
  const aiLanguage = useSettingsStore((state) => state.aiLanguage);
  const systemPrompt = useSettingsStore((state) => state.systemPrompt);

  useEffect(() => {
    commands.setAiLanguage(aiLanguage).catch((reason) => console.error("failed to set the AI language", reason));
  }, [aiLanguage]);

  useEffect(() => {
    commands.setSystemPrompt(systemPrompt).catch((reason) => console.error("failed to set the system prompt", reason));
  }, [systemPrompt]);
}

/** Feeds the backend's events into the Hunt store for as long as the component is mounted. */
export function useBackendEvents(): void {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const applyUpdate = useHuntStore((state) => state.applyUpdate);
  const applyAttributionChanged = useHuntStore((state) => state.applyAttributionChanged);
  const applyPermission = useHuntStore((state) => state.applyPermission);
  const applyClosed = useHuntStore((state) => state.applyClosed);
  const applyGraphChanged = useHuntStore((state) => state.applyGraphChanged);
  const applySummary = useHuntStore((state) => state.applySummary);

  useEffect(() => {
    const subscriptions = [
      listenTo("acp:update", (event) => applyUpdate(event.huntSessionId, event.notification)),
      listenTo("acp:permission", applyPermission),
      listenTo("acp:closed", applyClosed),
      listenTo("graph:changed", (event) => applyGraphChanged(event.huntSessionId)),
      listenTo("session:summary", applySummary),
      listenTo("sessions:changed", () => void refreshSessions()),
      listenTo("attribution:changed", (event) => applyAttributionChanged(event.worktreePath)),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [refreshSessions, applyUpdate, applyPermission, applyClosed, applyGraphChanged, applySummary, applyAttributionChanged]);
}
