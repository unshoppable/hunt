import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyMonacoBackground } from "../diff/monaco";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import { useAccountsStore } from "../state/accounts";
import { configuredVmSettings, useSettingsStore, type PaneKey } from "../state/settings";
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

/**
 * Pushes the remote settings to the backend at start and on every change (null while the project is missing):
 * commands on stored remote sessions and the retry of failed VM deletions reach the gateway they name.
 */
export function useRemoteSettingsSync(): void {
  const remote = useSettingsStore((state) => state.remote);

  useEffect(() => {
    commands.setRemoteSettings(configuredVmSettings(remote)).catch((reason) => console.error("failed to set the remote settings", reason));
  }, [remote]);
}

/** Loads the Claude accounts and reloads them whenever the backend announces a change (`accounts:changed`). */
export function useAccountsSync(): void {
  useEffect(() => {
    const { load } = useAccountsStore.getState();
    void load();
    const subscription = listenTo("accounts:changed", () => void load());
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}

/** Feeds the backend's events into the Hunt store for as long as the component is mounted. */
export function useBackendEvents(): void {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const applyUpdate = useHuntStore((state) => state.applyUpdate);
  const applyAttributionChanged = useHuntStore((state) => state.applyAttributionChanged);
  const applyPermission = useHuntStore((state) => state.applyPermission);
  const applyPermissionWithdrawn = useHuntStore((state) => state.applyPermissionWithdrawn);
  const applyClosed = useHuntStore((state) => state.applyClosed);
  const applyMessageTimes = useHuntStore((state) => state.applyMessageTimes);
  const applyGraphChanged = useHuntStore((state) => state.applyGraphChanged);
  const applySummary = useHuntStore((state) => state.applySummary);
  const applyRemoteProgress = useHuntStore((state) => state.applyRemoteProgress);
  const applyRemoteSync = useHuntStore((state) => state.applyRemoteSync);
  const applyRemoteLink = useHuntStore((state) => state.applyRemoteLink);
  const applyRelayActivity = useHuntStore((state) => state.applyRelayActivity);

  useEffect(() => {
    const subscriptions = [
      listenTo("acp:update", (event) => applyUpdate(event.huntSessionId, event.notification)),
      listenTo("acp:permission", applyPermission),
      listenTo("acp:permission-withdrawn", applyPermissionWithdrawn),
      listenTo("acp:closed", applyClosed),
      listenTo("acp:message-times", applyMessageTimes),
      listenTo("remote:progress", applyRemoteProgress),
      listenTo("remote:sync", applyRemoteSync),
      listenTo("remote:link", applyRemoteLink),
      listenTo("remote:relay", applyRelayActivity),
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
  }, [
    refreshSessions,
    applyUpdate,
    applyPermission,
    applyPermissionWithdrawn,
    applyClosed,
    applyMessageTimes,
    applyRemoteProgress,
    applyRemoteSync,
    applyRemoteLink,
    applyRelayActivity,
    applyGraphChanged,
    applySummary,
    applyAttributionChanged,
  ]);
}
