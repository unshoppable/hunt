import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { PreviewService, ScriptRunRequest, TmuxWindow } from "../ipc/types";
import { describeService, isServiceInUse } from "../preview/services";
import { usePreviewStore } from "../state/preview";
import { useHuntStore } from "../state/store";
import { useTerminalStore } from "../state/terminals";
import { ICON_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { PlusIcon, Spinner } from "../ui/icons";
import { errorText } from "../ui/useLoad";
import { nextActiveKey, terminalTabs, windowTabKey, type TerminalTab } from "./terminalTabs";
import { TerminalTabButton } from "./TerminalTabButton";
import { TerminalView } from "./TerminalView";

/** How often the panel asks the VM which processes run while the session is connected. */
const POLL_MS = 5000;

const NO_SERVICES: PreviewService[] = [];
const NO_WINDOWS: TmuxWindow[] = [];

/** The tab the next focus goes to (null: the active tab, once there is one) and a count that makes each request new. */
type FocusRequest = { key: string | null; count: number };

/**
 * The Terminal tab of a remote session: one tab per process of the app on its VM, like the tabs of a local terminal.
 * The services of the repository's hunt.json that are in use show their logs, read-only; the windows of the tmux
 * session `app`, in which the agent runs its other processes, take input. "+" opens a shell in a new window, × ends a
 * window and its process; a package.json script run from the editor gets a window of its own.
 * The panel stays mounted while another tab shows, so its terminals keep their connections. It asks the VM for the
 * processes when it mounts and whenever it shows, then every few seconds while the session is connected, which proves
 * a running VM, also while another tab shows.
 */
export function TerminalPanel({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) {
  const isLive = useHuntStore((state) => Boolean(state.sessions.find((session) => session.id === sessionId)?.isLive));
  const hasPreviewDomain = useHuntStore((state) => Boolean(state.sessions.find((session) => session.id === sessionId)?.remote?.previewDomain));
  const services = usePreviewStore((state) => state.previews[sessionId]?.status?.services ?? NO_SERVICES);
  const isVmRunning = usePreviewStore((state) => state.previews[sessionId]?.status?.vmRunning ?? true);
  const windows = usePreviewStore((state) => state.previews[sessionId]?.windows ?? null);
  const refreshServices = usePreviewStore((state) => state.refresh);
  const refreshWindows = usePreviewStore((state) => state.refreshWindows);
  const pendingRun = useTerminalStore((state) => state.remoteRuns[sessionId]);
  const [error, setError] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** The tabs shown at least once; each keeps its terminal while its process exists. */
  const [openedKeys, setOpenedKeys] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>({ key: null, count: 0 });
  const [isOpeningShell, setIsOpeningShell] = useState(false);
  const tabs = useMemo(
    () => terminalTabs(services.filter((service) => isServiceInUse(service, isVmRunning)), windows ?? NO_WINDOWS),
    [services, isVmRunning, windows],
  );
  const previousTabsRef = useRef<TerminalTab[]>([]);
  const wasVisibleRef = useRef(isVisible);

  const loadWindows = useCallback(async () => {
    try {
      await refreshWindows(sessionId);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [sessionId, refreshWindows]);

  // Reads at mount and whenever the tab shows; polls behind other tabs too, so the tab strip's green dot stays current.
  useEffect(() => {
    const refresh = () => {
      void loadWindows();
      if (hasPreviewDomain) {
        void refreshServices(sessionId);
      }
    };
    refresh();
    if (!isLive) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        refresh();
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, isVisible, isLive, hasPreviewDomain, loadWindows, refreshServices]);

  useEffect(() => {
    // The updater runs at the next render, after the ref moved on, so it gets the previous tabs as a value.
    const previous = previousTabsRef.current;
    previousTabsRef.current = tabs;
    setActiveKey((current) => nextActiveKey(previous, tabs, current));
    setOpenedKeys((keys) => {
      const kept = keys.filter((key) => tabs.some((tab) => tab.key === key));
      return kept.length === keys.length ? keys : kept;
    });
  }, [tabs]);

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

  const activate = useCallback((key: string) => {
    setActiveKey(key);
    setFocusRequest((current) => ({ key, count: current.count + 1 }));
  }, []);

  /** Opens a shell in a new tmux window and shows it; with `run`, the window runs that package.json script. */
  const openShell = useCallback(
    async (run: ScriptRunRequest | null = null) => {
      setIsOpeningShell(true);
      try {
        const id = await commands.openShellWindow(sessionId, run?.directory, run?.script ?? null);
        await loadWindows();
        activate(windowTabKey(id));
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setIsOpeningShell(false);
      }
    },
    [sessionId, loadWindows, activate],
  );

  // A script run from an editor's play button (see terminal/scriptRuns.ts) waits in the store until this panel takes it.
  useEffect(() => {
    if (!pendingRun) return;
    const run = useTerminalStore.getState().takeRemoteRun(sessionId);
    if (run) {
      void openShell(run);
    }
  }, [sessionId, pendingRun, openShell]);

  const closeWindow = async (tab: TerminalTab) => {
    if (tab.target.kind !== "window") return;
    const isConfirmed = await confirmDestructive(`End "${tab.label}"? Its tmux window on the VM closes and the processes in it stop.`, "End");
    if (!isConfirmed) return;
    try {
      await commands.closeTerminalWindow(sessionId, tab.target.id);
    } catch (reason) {
      setError(errorText(reason));
      return;
    }
    await loadWindows();
  };

  return (
    <div className={`h-full min-h-0 flex-col ${isVisible ? "flex" : "hidden"}`}>
      <div className="flex min-w-0 items-center gap-1 border-b border-(--line) px-2 py-2.5 text-[13px]">
        <div role="tablist" className="terminal-tabs flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <TerminalTabButton
              key={tab.key}
              label={tab.label}
              title={tab.service ? `The log of the service ${tab.service.name}, ~/logs/${tab.service.name}.log on the VM; read-only` : `tmux window ${tab.label}`}
              state={tab.service ? describeService(tab.service, isVmRunning) : null}
              isActive={tab.key === activeKey}
              onActivate={() => activate(tab.key)}
              onClose={tab.target.kind === "window" ? () => void closeWindow(tab) : null}
            />
          ))}
        </div>
        <button type="button" onClick={() => void openShell()} disabled={isOpeningShell} title="New shell" className={ICON_BUTTON_XS}>
          {isOpeningShell ? <Spinner /> : <PlusIcon />}
        </button>
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
      <div className="min-h-0 flex-1">
        {tabs
          .filter((tab) => openedKeys.includes(tab.key))
          .map((tab) => (
            <TerminalView
              key={tab.key}
              sessionId={sessionId}
              target={tab.target}
              isVisible={isVisible && tab.key === activeKey}
              focusRequest={focusRequest.key === tab.key ? focusRequest.count : 0}
            />
          ))}
        {windows && !tabs.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-neutral-500">
            <p>No process runs on the VM yet.</p>
            <button type="button" onClick={() => void openShell()} disabled={isOpeningShell} className={SECONDARY_BUTTON_XS}>
              New shell
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
