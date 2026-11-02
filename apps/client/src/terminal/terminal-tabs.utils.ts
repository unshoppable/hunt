import type { PreviewService, PreviewStatus } from "../preview/preview.types";
import type { LocalService, Machine, TerminalTarget, TmuxWindow } from "./terminal.types";
import { isPreviewActive, type Description } from "../preview/preview-services.utils";
import type { SessionWindows } from "./terminals.store";
import { describeLocalExit } from "./terminal-stream.utils";

/**
 * A tab of the Terminal panel: the log of a hunt.json service on the VM, a hunt.json service of a local session, or a
 * window of a tmux session `app`.
 */
export type TerminalTab = {
  /**
   * Stays the same while the process exists: `service:<name>`, `local-service:<name>` (also while the service is
   * stopped) or `window:<machine>:<tmux window ID>`.
   */
  key: string;
  label: string;
  title: string;
  /** What the tab's terminal shows; null for a local service that no window ran yet. */
  target: TerminalTarget | null;
  /** The service on the VM the tab shows the log of; null otherwise. */
  service: PreviewService | null;
  /** The hunt.json service of a local session the tab runs; null otherwise. */
  localService: LocalService | null;
  /** The tmux window the tab shows; null for a service on the VM and a local service no window ran yet. */
  window: TmuxWindow | null;
};

/** The names of the shells Hunt opens: `shell`, `shell-2`, … */
const SHELL_NAME = /^shell(-\d+)?$/;

const RUNNING: Description = { text: "Running", tone: "ok" };

/** The key of the tab that shows the tmux window `id` on `machine`. */
export function windowTabKey(machine: Machine, id: string): string {
  return `window:${machine}:${id}`;
}

/**
 * The tabs in their order: the services as hunt.json lists them (on the VM `services`, in a local session
 * `localServices`, each with the window of this Mac that runs or ran it), then the VM's windows, then this Mac's other
 * windows, each in tmux's order and without the windows of checks. Windows of the same name on one machine are told
 * apart as "vite", "vite 2"; with `labelsDesktop` (a remote session, whose sub chats run their processes on this Mac)
 * the labels of this Mac's windows end in "(Mac)".
 */
export function terminalTabs(
  services: readonly PreviewService[],
  vmWindows: readonly TmuxWindow[],
  desktopWindows: readonly TmuxWindow[],
  labelsDesktop: boolean,
  localServices: readonly LocalService[] = [],
): TerminalTab[] {
  const serviceTabs = services.map(
    (service): TerminalTab => ({
      key: `service:${service.name}`,
      label: service.name,
      title: `The log of the service ${service.name}, ~/logs/${service.name}.log on the VM; read-only`,
      target: { kind: "service", name: service.name },
      service,
      localService: null,
      window: null,
    }),
  );
  const localServiceTabs = localServices.map((localService): TerminalTab => {
    const window = desktopWindows.find((candidate) => candidate.service === localService.name) ?? null;
    return {
      key: `local-service:${localService.name}`,
      label: localService.name,
      title: localServiceTitle(localService, window),
      target: window ? { kind: "window", id: window.id, machine: "desktop" } : null,
      service: null,
      localService,
      window,
    };
  });
  const serviceWindows = new Set(localServiceTabs.flatMap((tab) => (tab.window ? [tab.window.id] : [])));
  const otherDesktopWindows = desktopWindows.filter((window) => !serviceWindows.has(window.id));
  return [
    ...serviceTabs,
    ...localServiceTabs,
    ...windowTabs("vm", vmWindows, ""),
    ...windowTabs("desktop", otherDesktopWindows, labelsDesktop ? " (Mac)" : ""),
  ];
}

/**
 * The state a local service's tab shows, read from its window `window` when one runs or ran it: stopped, starting
 * until its port accepts connections, running, or how it ended.
 */
export function localServiceState(service: LocalService, window: TmuxWindow | null): Description {
  if (!window) return { text: "Stopped", tone: "idle" };
  if (window.isDead) return { text: describeLocalExit(window.exitCode), tone: window.exitCode === 0 ? "idle" : "error" };
  if (service.port !== null && !service.isListening) return { text: `Starting, port ${service.port} not open yet`, tone: "pending" };
  return RUNNING;
}

/** The state a window's tab shows: whether the package.json script of a script window runs or how it ended. */
export function windowState(window: TmuxWindow): Description | null {
  if (!window.script) return null;
  if (!window.isDead) return RUNNING;
  return { text: describeLocalExit(window.exitCode), tone: window.exitCode === 0 ? "idle" : "error" };
}

/** Whether `tab` shows a service of hunt.json, on the VM or of a local session, rather than a shell or another process. */
export function isServiceTab(tab: TerminalTab): boolean {
  return Boolean(tab.service || tab.localService);
}

/** The ended package.json script window that `tab` shows, which "Run again" runs again; null for any other tab. */
export function endedScriptWindow(tab: TerminalTab): TmuxWindow | null {
  return tab.window?.script && tab.window.isDead ? tab.window : null;
}

/** The Hunt session another than `sessionId` that the window of `tab` belongs to; null for its own, an unknown or a service. */
export function tabOwner(tab: TerminalTab, sessionId: string): string | null {
  const owner = tab.window?.owner;
  return owner && owner !== sessionId ? owner : null;
}

/** Whether a process runs in the window: a script that has not ended or anything else than a shell Hunt opened or a check. */
export function isProcessWindow(window: TmuxWindow): boolean {
  return !window.check && !window.isDead && (Boolean(window.script) || !SHELL_NAME.test(window.name));
}

/** Whether the Terminal tab shows the window: every window but those of the checks, which the Checks tab shows. */
export function isTerminalWindow(window: TmuxWindow): boolean {
  return !window.check;
}

/** Whether the Terminal tab carries a green dot: a service of hunt.json runs or starts, or a process runs in a tmux window. */
export function isTerminalActive(status: PreviewStatus | null, windows: SessionWindows): boolean {
  return isPreviewActive(status) || [...(windows.vm ?? []), ...(windows.desktop ?? [])].some(isProcessWindow);
}

/**
 * The tab to show once the tabs changed from `previous` to `next`: the active one while it exists; otherwise the
 * nearest one after it that still exists, then the nearest one before it, like closing an editor tab; the first tab
 * for an active key `previous` did not hold; null without tabs.
 */
export function nextActiveKey(previous: readonly TerminalTab[], next: readonly TerminalTab[], activeKey: string | null): string | null {
  if (!next.length) return null;
  const nextKeys = new Set(next.map((tab) => tab.key));
  if (activeKey && nextKeys.has(activeKey)) return activeKey;
  const index = previous.findIndex((tab) => tab.key === activeKey);
  if (index < 0) return next[0].key;
  const neighbours = [...previous.slice(index + 1), ...previous.slice(0, index).reverse()];
  return neighbours.find((tab) => nextKeys.has(tab.key))?.key ?? next[0].key;
}

function windowTabs(machine: Machine, windows: readonly TmuxWindow[], labelSuffix: string): TerminalTab[] {
  const seen = new Map<string, number>();
  return windows.filter(isTerminalWindow).map((window): TerminalTab => {
    const count = (seen.get(window.name) ?? 0) + 1;
    seen.set(window.name, count);
    const label = `${count === 1 ? window.name : `${window.name} ${count}`}${labelSuffix}`;
    const target: TerminalTarget = { kind: "window", id: window.id, machine };
    return { key: windowTabKey(machine, window.id), label, title: windowTitle(machine, window), target, service: null, localService: null, window };
  });
}

function localServiceTitle(service: LocalService, window: TmuxWindow | null): string {
  const what = `The service ${service.name} of hunt.json, ${service.command}`;
  if (!window) return `${what}; not started`;
  return `${what}, in the tmux window ${window.name} on this Mac; its output goes to .hunt/logs/desktop/${window.name}.log`;
}

function windowTitle(machine: Machine, window: TmuxWindow): string {
  const what = window.script ? `npm run ${window.script} in the tmux window ${window.name}` : `The tmux window ${window.name}`;
  if (machine === "vm") return `${what} on the VM; its output goes to ~/logs/${window.name}.log`;
  const owner = window.owner ? "" : "; Hunt does not know which session it belongs to";
  return `${what} on this Mac; its output goes to .hunt/logs/desktop/${window.name}.log${owner}`;
}
