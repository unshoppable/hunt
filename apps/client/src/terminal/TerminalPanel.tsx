import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../ipc/commands";
import type { PreviewService } from "../preview/preview.types";
import type { LocalService, Machine, ScriptRunRequest, TmuxWindow } from "./terminal.types";
import { ownerLabel } from "../diff/attribution.utils";
import { describeService, hasRespondingService, isServiceRunning, offersStart, type Description } from "../preview/preview-services.utils";
import { sessionMarks } from "../sessions/session-labels.utils";
import { usePreviewStore } from "../preview/preview.store";
import { useHuntStore } from "../sessions/hunt.store";
import { useSessionViewStore } from "../sessions/inspector.store";
import { NO_SESSION_WINDOWS, useTerminalStore } from "./terminals.store";
import { useServicesStore } from "./services.store";
import { GHOST_BUTTON_XS, ICON_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { confirmDestructive } from "../ui/confirm.utils";
import { PlusIcon, Spinner } from "../ui/Icons";
import { errorText } from "../ui/error-text.utils";
import { describeLocalExit } from "./terminal-stream.utils";
import {
  endedScriptWindow,
  isServiceTab,
  isTerminalWindow,
  localServiceState,
  nextActiveKey,
  tabOwner,
  terminalTabs,
  windowState,
  windowTabKey,
  type TerminalTab,
} from "./terminal-tabs.utils";
import { TerminalTabButton } from "./TerminalTabButton";
import { TerminalView } from "./TerminalView";

/** How often the panel asks for the processes: this Mac's always, the VM's while the session is connected. */
const POLL_MS = 5000;

const NO_SERVICES: PreviewService[] = [];
const NO_LOCAL_SERVICES: LocalService[] = [];
const NO_WINDOWS: TmuxWindow[] = [];

/** The tab the next focus goes to (null: the active tab, once there is one) and a count that makes each request new. */
type FocusRequest = { key: string | null; count: number };

/**
 * The Terminal tab of a session: one tab per process, each a window of a tmux session `app` that logs its output. A
 * local session shows the windows of its family's tmux server on this Mac, in which its agents and its sub chats' agents
 * run their processes. A remote session shows the windows on its VM, plus "(Mac)" the windows its sub chats opened on
 * this Mac. Both list the services of their hunt.json first, each a tab that starts and stops the service and shows its
 * terminal: on this Mac a window of its own, on the VM the tmux session the service's systemd unit runs it in, or its
 * log while it does not run; a VM's service also links its preview URL, and "Start the app" asks the agent to start the
 * services the task needs. "+" opens a shell in a
 * new window where the session's agent runs, × ends a window and its process; a package.json script run from the editor
 * gets a window of its own, which stays after the script ended and offers "Run again". A window of another session of
 * the family carries that session's mark. The first time a local session's panel shows without windows, it opens a
 * shell.
 * The panel stays mounted while another tab shows, so its terminals keep their connections. It asks for the processes
 * when it mounts and whenever it shows, then every few seconds, also while another tab shows; the VM only while the
 * session is connected, which proves a running VM.
 */
export function TerminalPanel({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) {
  const isLive = useHuntStore((state) => Boolean(state.sessions.find((session) => session.id === sessionId)?.isLive));
  const isRemote = useHuntStore((state) => Boolean(state.sessions.find((session) => session.id === sessionId)?.remote));
  const hasPreviewDomain = useHuntStore((state) => Boolean(state.sessions.find((session) => session.id === sessionId)?.remote?.previewDomain));
  const parentId = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.parentId ?? null);
  const sessions = useHuntStore((state) => state.sessions);
  const marks = useMemo(() => sessionMarks(sessions), [sessions]);
  const previewStatus = usePreviewStore((state) => state.previews[sessionId]?.status ?? null);
  const isAwaitingStart = usePreviewStore((state) => Boolean(state.previews[sessionId]?.awaitingStart));
  const services = previewStatus?.services ?? NO_SERVICES;
  const isVmRunning = previewStatus?.vmRunning ?? true;
  const windows = useTerminalStore((state) => state.windows[sessionId] ?? NO_SESSION_WINDOWS);
  const refreshServices = usePreviewStore((state) => state.refresh);
  const localServices = useServicesStore((state) => (isRemote ? NO_LOCAL_SERVICES : (state.services[sessionId]?.status?.services ?? NO_LOCAL_SERVICES)));
  const servicesProblem = useServicesStore((state) => (isRemote ? null : (state.services[sessionId]?.status?.problem ?? state.services[sessionId]?.error ?? null)));
  const refreshLocalServices = useServicesStore((state) => state.refresh);
  const refreshWindows = useTerminalStore((state) => state.refreshWindows);
  const pendingRun = useTerminalStore((state) => state.pendingRuns[sessionId]);
  const [error, setError] = useState<string | null>(null);
  /** The tab shown, stored per session so that `hunt-client terminal` reads and sets it. */
  const activeKey = useSessionViewStore((state) => state.views[sessionId]?.terminalTab ?? null);
  const updateView = useSessionViewStore((state) => state.updateView);
  /** The tabs shown at least once; each keeps its terminal while its process exists. */
  const [openedKeys, setOpenedKeys] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>({ key: null, count: 0 });
  const [isOpeningShell, setIsOpeningShell] = useState(false);
  /** Where "+" and script runs open a window: where the session's agent runs. */
  const shellMachine: Machine = isRemote ? "vm" : "desktop";
  const tabs = useMemo(
    () =>
      terminalTabs(services, windows.vm ?? NO_WINDOWS, windows.desktop ?? NO_WINDOWS, isRemote, localServices),
    [services, windows, isRemote, localServices],
  );
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null;
  const endedScript = activeTab ? endedScriptWindow(activeTab) : null;
  const hasReadWindows = Boolean(windows.desktop) && (!isRemote || Boolean(windows.vm));
  const previousTabsRef = useRef<TerminalTab[]>([]);
  const wasVisibleRef = useRef(isVisible);
  const hasOfferedShellRef = useRef(false);
  /** The key the panel stored last; a key stored by `hunt-client terminal` shows its tab like a click on it. */
  const ownKeyRef = useRef(activeKey);

  const setActiveKey = useCallback(
    (key: string | null) => {
      ownKeyRef.current = key;
      updateView(sessionId, { terminalTab: key });
    },
    [sessionId, updateView],
  );

  const loadWindows = useCallback(
    async (machines: readonly Machine[]) => {
      try {
        await Promise.all(machines.map((machine) => refreshWindows(sessionId, machine)));
        setError(null);
      } catch (reason) {
        setError(errorText(reason));
      }
    },
    [sessionId, refreshWindows],
  );

  // Reads at mount and whenever the tab shows; polls behind other tabs too, so the tab strip's green dot stays current.
  useEffect(() => {
    const refresh = (includesVm: boolean) => {
      void loadWindows(isRemote && includesVm ? ["vm", "desktop"] : ["desktop"]);
      if (includesVm && hasPreviewDomain) {
        void refreshServices(sessionId);
      }
      if (!isRemote) {
        void refreshLocalServices(sessionId);
      }
    };
    refresh(true);
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        refresh(isLive);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, isVisible, isLive, isRemote, hasPreviewDomain, loadWindows, refreshServices, refreshLocalServices]);

  // Without tabs (none read yet, or all gone) the stored key stays, so a tab picked before still shows once they arrive.
  useEffect(() => {
    const previous = previousTabsRef.current;
    previousTabsRef.current = tabs;
    if (tabs.length) {
      setActiveKey(nextActiveKey(previous, tabs, useSessionViewStore.getState().views[sessionId]?.terminalTab ?? null));
    }
    setOpenedKeys((keys) => {
      const kept = keys.filter((key) => tabs.some((tab) => tab.key === key));
      return kept.length === keys.length ? keys : kept;
    });
  }, [sessionId, tabs, setActiveKey]);

  useEffect(() => {
    if (!activeKey || activeKey === ownKeyRef.current) return;
    ownKeyRef.current = activeKey;
    setFocusRequest((current) => ({ key: activeKey, count: current.count + 1 }));
  }, [activeKey]);

  useEffect(() => {
    if (!isVisible || !activeKey) return;
    setOpenedKeys((keys) => (keys.includes(activeKey) ? keys : [...keys, activeKey]));
  }, [isVisible, activeKey]);

  // Showing the panel focuses its active terminal; a panel that mounts visible (another session opened) leaves it alone.
  useEffect(() => {
    const becameVisible = isVisible && !wasVisibleRef.current;
    wasVisibleRef.current = isVisible;
    if (becameVisible) {
      setFocusRequest((current) => ({ key: activeKey, count: current.count + 1 }));
    }
  }, [isVisible, activeKey]);

  // A request made before the tabs arrived goes to the first tab that becomes active, and only to that one.
  useEffect(() => {
    if (!activeKey || focusRequest.key || !focusRequest.count) return;
    setFocusRequest({ key: activeKey, count: focusRequest.count });
  }, [activeKey, focusRequest]);

  const activate = useCallback(
    (key: string) => {
      setActiveKey(key);
      setFocusRequest((current) => ({ key, count: current.count + 1 }));
    },
    [setActiveKey],
  );

  /** Opens a shell in a new tmux window and shows it; with `run`, the window runs that package.json script. */
  const openShell = useCallback(
    async (run: ScriptRunRequest | null = null) => {
      setIsOpeningShell(true);
      try {
        const id = await commands.openShellWindow(sessionId, run?.directory, run?.script ?? null);
        await loadWindows([shellMachine]);
        activate(windowTabKey(shellMachine, id));
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setIsOpeningShell(false);
      }
    },
    [sessionId, shellMachine, loadWindows, activate],
  );

  // A script run from an editor's play button (see terminal/script-runs.hook.ts) waits in the store until this panel takes it.
  useEffect(() => {
    if (!pendingRun) return;
    const run = useTerminalStore.getState().takePendingRun(sessionId);
    if (run) {
      void openShell(run);
    }
  }, [sessionId, pendingRun, openShell]);

  useEffect(() => {
    if (isRemote || !isVisible || !windows.desktop || hasOfferedShellRef.current) return;
    hasOfferedShellRef.current = true;
    if (!windows.desktop.some(isTerminalWindow) && !pendingRun) {
      void openShell();
    }
  }, [isRemote, isVisible, windows.desktop, pendingRun, openShell]);

  const closeWindow = async (tab: TerminalTab) => {
    if (tab.target?.kind !== "window") return;
    const { id, machine } = tab.target;
    if (!tab.window?.isDead) {
      const place = machine === "vm" ? "on the VM" : "on this Mac";
      const isConfirmed = await confirmDestructive(`End "${tab.label}"? Its tmux window ${place} closes and the processes in it stop.`, "End");
      if (!isConfirmed) return;
    }
    try {
      await commands.closeTerminalWindow(sessionId, machine, id);
    } catch (reason) {
      setError(errorText(reason));
      return;
    }
    await loadWindows([machine]);
  };

  /** Starts the service `name` here or on the VM, or every local one without a name, and shows the tab of `name`. */
  const startService = async (name?: string) => {
    try {
      await useServicesStore.getState().start(sessionId, name);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
    if (isRemote) {
      if (name) {
        activate(`service:${name}`);
      }
      return;
    }
    await loadWindows(["desktop"]);
    if (name) {
      activate(`local-service:${name}`);
    }
  };

  const stopService = async (name: string) => {
    try {
      await useServicesStore.getState().stop(sessionId, name);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
    if (!isRemote) {
      await loadWindows(["desktop"]);
    }
  };

  const openPreview = (url: string) => {
    void openUrl(url).catch((reason) => setError(errorText(reason)));
  };

  const runAgain = async (tab: TerminalTab, scriptWindow: TmuxWindow) => {
    if (tab.target?.kind !== "window") return;
    const { machine } = tab.target;
    try {
      await commands.rerunTerminalWindow(sessionId, machine, scriptWindow.id);
    } catch (reason) {
      setError(errorText(reason));
      return;
    }
    await loadWindows([machine]);
    activate(tab.key);
  };

  const serviceTabs = tabs.filter(isServiceTab);
  const otherTabs = tabs.filter((tab) => !isServiceTab(tab));

  const renderTab = (tab: TerminalTab) => {
    const ownerId = tabOwner(tab, sessionId);
    const owner = ownerId ? { id: ownerId, ...ownerLabel(ownerId, sessions, marks, sessionId, parentId) } : null;
    return (
      <TerminalTabButton
        key={tab.key}
        label={tab.label}
        title={owner ? `${tab.title}; it belongs to ${owner.mark} ${owner.title}` : tab.title}
        state={
          tab.service
            ? describeService(tab.service, isVmRunning)
            : tab.localService
              ? localServiceState(tab.localService, tab.window)
              : tab.window
                ? windowState(tab.window)
                : null
        }
        owner={owner}
        isActive={tab.key === activeKey}
        onActivate={() => activate(tab.key)}
        onClose={tab.target?.kind === "window" ? () => void closeWindow(tab) : null}
      />
    );
  };

  return (
    <div className={`h-full min-h-0 flex-col ${isVisible ? "flex" : "hidden"}`}>
      <div className="flex min-w-0 items-center gap-1 border-b border-(--line) px-2 py-2.5 text-[13px]">
        <div role="tablist" className="terminal-tabs flex min-w-0 items-center gap-1 overflow-x-auto">
          {serviceTabs.length ? (
            // The services of hunt.json sit in a group of their own, apart from the shells and the agents' processes.
            <div role="group" aria-label="Services" className="flex shrink-0 items-center gap-1 rounded-md bg-white/[0.04] py-0.5 pr-0.5 pl-2">
              <span className="text-[12px] font-semibold tracking-wide text-neutral-500 uppercase">Services</span>
              {serviceTabs.map(renderTab)}
              {isRemote && previewStatus && isAwaitingStart && !hasRespondingService(previewStatus) ? (
                <span className="flex shrink-0 items-center gap-1.5 px-1 text-neutral-400" title="The agent was asked to start the app">
                  <Spinner />
                  Starting the app…
                </span>
              ) : isRemote && previewStatus && offersStart(previewStatus) ? (
                <button
                  type="button"
                  onClick={() => usePreviewStore.getState().startApp(sessionId)}
                  title="Asks the agent to start the services this task needs, as the repository's hunt.agent.md describes"
                  className={GHOST_BUTTON_XS}
                >
                  Start the app
                </button>
              ) : null}
            </div>
          ) : null}
          {serviceTabs.length && otherTabs.length ? <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-(--line)" /> : null}
          {otherTabs.map(renderTab)}
        </div>
        <button type="button" onClick={() => void openShell()} disabled={isOpeningShell} title="New shell" className={ICON_BUTTON_XS}>
          {isOpeningShell ? <Spinner /> : <PlusIcon />}
        </button>
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
      {servicesProblem ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{servicesProblem}</p> : null}
      {activeTab?.localService ? (
        <ServiceBar
          state={localServiceState(activeTab.localService, activeTab.window)}
          address={activeTab.localService.port !== null ? <span className="text-neutral-500">localhost:{activeTab.localService.port}</span> : null}
          isRunning={Boolean(activeTab.window && !activeTab.window.isDead)}
          startLabel={activeTab.window ? "Start again" : "Start"}
          onStart={() => void startService(activeTab.localService?.name)}
          onStop={() => void stopService(activeTab.localService?.name ?? "")}
        />
      ) : activeTab?.service ? (
        <ServiceBar
          state={describeService(activeTab.service, isVmRunning)}
          address={
            <button type="button" onClick={() => openPreview(activeTab.service?.url ?? "")} className="min-w-0 truncate font-mono text-sky-300 hover:underline">
              {activeTab.service.url}
            </button>
          }
          isRunning={isServiceRunning(activeTab.service)}
          startLabel={activeTab.service.state === "failed" ? "Start again" : "Start"}
          onStart={() => void startService(activeTab.service?.name)}
          onStop={() => void stopService(activeTab.service?.name ?? "")}
        />
      ) : null}
      {activeTab && endedScript ? (
        <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
          <span className={`min-w-0 truncate ${endedScript.exitCode === 0 ? "text-emerald-300" : "text-red-300"}`}>{describeLocalExit(endedScript.exitCode)}</span>
          <span className="flex-1" />
          <button type="button" onClick={() => void runAgain(activeTab, endedScript)} className={SECONDARY_BUTTON_XS}>
            Run again
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {tabs.map((tab) =>
          tab.target && openedKeys.includes(tab.key) ? (
            // A service's tab keeps its key while its window, on a VM its unit's run, changes; its terminal follows it.
            <TerminalView
              key={`${tab.key}|${tab.window?.id ?? tab.service?.invocation ?? ""}`}
              sessionId={sessionId}
              target={tab.target}
              isVisible={isVisible && tab.key === activeKey}
              focusRequest={focusRequest.key === tab.key ? focusRequest.count : 0}
            />
          ) : null,
        )}
        {activeTab?.localService && !activeTab.target ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-neutral-500">
            <p>
              <code>{activeTab.localService.command}</code> has not run in this worktree yet.
            </p>
            <button type="button" onClick={() => void startService(activeTab.localService?.name)} className={SECONDARY_BUTTON_XS}>
              Start {activeTab.localService.name}
            </button>
          </div>
        ) : null}
        {hasReadWindows && !tabs.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-neutral-500">
            <p>{isRemote ? "No process runs on the VM yet." : "No terminal is open."}</p>
            <button type="button" onClick={() => void openShell()} disabled={isOpeningShell} className={SECONDARY_BUTTON_XS}>
              New shell
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The bar above a service's terminal: its state, where it answers (`address`), "Stop" while it runs, `startLabel`
 * otherwise.
 */
function ServiceBar({
  state,
  address,
  isRunning,
  startLabel,
  onStart,
  onStop,
}: {
  state: Description;
  address: ReactNode;
  isRunning: boolean;
  startLabel: string;
  onStart: () => void;
  onStop: () => void;
}) {
  const toneClass =
    state.tone === "error" ? "text-red-300" : state.tone === "ok" ? "text-emerald-300" : state.tone === "warning" ? "text-amber-300" : "text-neutral-400";
  return (
    <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
      <span className={`min-w-0 shrink-0 truncate ${toneClass}`}>{state.text}</span>
      {address}
      <span className="flex-1" />
      {isRunning ? (
        <button type="button" onClick={onStop} className={SECONDARY_BUTTON_XS}>
          Stop
        </button>
      ) : (
        <button type="button" onClick={onStart} className={SECONDARY_BUTTON_XS}>
          {startLabel}
        </button>
      )}
    </div>
  );
}
