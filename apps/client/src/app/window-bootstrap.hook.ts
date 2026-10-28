import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyMonacoBackground } from "../editor/setup.monaco";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import { useAccountsStore } from "../accounts/accounts.store";
import { useAgentDefaultsStore } from "../chat/agent-defaults.store";
import { useChecksStore } from "../checks/checks.store";
import { configuredVmSettings, useSettingsStore, type PaneKey } from "../settings/settings.store";
import { useHuntStore } from "../sessions/hunt.store";

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

/** A zustand store with `persist`, as far as `syncAcrossWindows` needs it. */
type PersistedStore = { subscribe: (listener: () => void) => () => void; persist: { rehydrate: () => Promise<void> | void } };

/**
 * Keeps every window's copy of `store` in step: a change in one window is written to storage by `persist` and
 * announced as `eventName`, and the other windows re-read storage. Returns the function that stops it.
 */
function syncAcrossWindows(store: PersistedStore, eventName: "settings:changed" | "agent-defaults:changed", label: string): () => void {
  /** Set while the store takes over another window's change, so the change is not announced a second time. */
  let isTakingOver = false;
  const unsubscribe = store.subscribe(() => {
    if (isTakingOver) return;
    void emit(eventName, { source: label });
  });
  const subscription = listenTo(eventName, (event) => {
    if (event.source === label) return;
    isTakingOver = true;
    void Promise.resolve(store.persist.rehydrate()).finally(() => {
      isTakingOver = false;
    });
  });
  return () => {
    unsubscribe();
    void subscription.then((unlisten) => unlisten());
  };
}

/** Keeps every window's copy of the settings and agent defaults stores in step (see `syncAcrossWindows`). */
export function useSettingsSync(): void {
  useEffect(() => {
    const label = getCurrentWindow().label;
    const stopSettings = syncAcrossWindows(useSettingsStore, "settings:changed", label);
    const stopAgentDefaults = syncAcrossWindows(useAgentDefaultsStore, "agent-defaults:changed", label);
    return () => {
      stopSettings();
      stopAgentDefaults();
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

/** Reads the checks of the session again once the Checks tab has shown them. */
function refreshShownChecks(sessionId: string): void {
  const checksStore = useChecksStore.getState();
  if (!checksStore.checks[sessionId]) return;
  void checksStore.refresh(sessionId);
}

/** Feeds the backend's events into the Hunt store for as long as the component is mounted. */
export function useBackendEvents(): void {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const applyUpdate = useHuntStore((state) => state.applyUpdate);
  const applyReplay = useHuntStore((state) => state.applyReplay);
  const applyWorktreeChanged = useHuntStore((state) => state.applyWorktreeChanged);
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
  const applyAnnotation = useHuntStore((state) => state.applyAnnotation);
  const applyChatSeen = useHuntStore((state) => state.applyChatSeen);

  useEffect(() => {
    const subscriptions = [
      listenTo("acp:update", (event) => applyUpdate(event.huntSessionId, event.notification)),
      listenTo("acp:replay", (event) => applyReplay(event.huntSessionId, event.notifications)),
      listenTo("acp:permission", applyPermission),
      listenTo("acp:permission-withdrawn", applyPermissionWithdrawn),
      listenTo("acp:closed", applyClosed),
      listenTo("acp:message-times", applyMessageTimes),
      listenTo("remote:progress", applyRemoteProgress),
      listenTo("remote:sync", applyRemoteSync),
      listenTo("remote:link", applyRemoteLink),
      listenTo("remote:relay", applyRelayActivity),
      listenTo("review:annotation", applyAnnotation),
      listenTo("graph:changed", (event) => applyGraphChanged(event.huntSessionId)),
      listenTo("session:summary", applySummary),
      listenTo("sessions:changed", () => void refreshSessions()),
      listenTo("chat:seen", (event) => applyChatSeen(event.sessionId)),
      listenTo("attribution:changed", (event) => applyWorktreeChanged(event.worktreePath)),
      listenTo("worktree:changed", (event) => applyWorktreeChanged(event.worktreePath)),
      listenTo("checks:changed", (event) => refreshShownChecks(event.sessionId)),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [
    refreshSessions,
    applyUpdate,
    applyReplay,
    applyPermission,
    applyPermissionWithdrawn,
    applyClosed,
    applyMessageTimes,
    applyRemoteProgress,
    applyRemoteSync,
    applyRemoteLink,
    applyRelayActivity,
    applyAnnotation,
    applyChatSeen,
    applyGraphChanged,
    applySummary,
    applyWorktreeChanged,
  ]);
}
