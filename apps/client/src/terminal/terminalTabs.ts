import type { Machine, PreviewService, PreviewStatus, TerminalTarget, TmuxWindow } from "../ipc/types";
import { isPreviewActive, type Description } from "../preview/services";
import type { SessionWindows } from "../state/terminals";
import { describeLocalExit } from "./terminalStream";

/** A tab of the Terminal panel: the log of a hunt.json service on the VM or a window of a tmux session `app`. */
export type TerminalTab = {
  /** Stays the same while the process exists: `service:<name>` or `window:<machine>:<tmux window ID>`. */
  key: string;
  label: string;
  title: string;
  target: TerminalTarget;
  /** The service the tab shows the log of; null for a window. */
  service: PreviewService | null;
  /** The tmux window the tab shows; null for a service. */
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
 * The tabs in their order: the services as hunt.json lists them, then the VM's windows, then this Mac's, each in
 * tmux's order. Windows of the same name on one machine are told apart as "vite", "vite 2"; with `labelsDesktop` (a
 * remote session, whose sub chats run their processes on this Mac) the labels of this Mac's windows end in "(Mac)".
 */
export function terminalTabs(
  services: readonly PreviewService[],
  vmWindows: readonly TmuxWindow[],
  desktopWindows: readonly TmuxWindow[],
  labelsDesktop: boolean,
): TerminalTab[] {
  const serviceTabs = services.map(
    (service): TerminalTab => ({
      key: `service:${service.name}`,
      label: service.name,
      title: `The log of the service ${service.name}, ~/logs/${service.name}.log on the VM; read-only`,
      target: { kind: "service", name: service.name },
      service,
      window: null,
    }),
  );
  return [...serviceTabs, ...windowTabs("vm", vmWindows, ""), ...windowTabs("desktop", desktopWindows, labelsDesktop ? " (Mac)" : "")];
}

/** The state a window's tab shows: whether the package.json script of a script window runs or how it ended. */
export function windowState(window: TmuxWindow): Description | null {
  if (!window.script) return null;
  if (!window.isDead) return RUNNING;
  return { text: describeLocalExit(window.exitCode), tone: window.exitCode === 0 ? "idle" : "error" };
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

/** Whether a process runs in the window: a script that has not ended or anything else than a shell Hunt opened. */
export function isProcessWindow(window: TmuxWindow): boolean {
  return !window.isDead && (Boolean(window.script) || !SHELL_NAME.test(window.name));
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
  return windows.map((window): TerminalTab => {
    const count = (seen.get(window.name) ?? 0) + 1;
    seen.set(window.name, count);
    const label = `${count === 1 ? window.name : `${window.name} ${count}`}${labelSuffix}`;
    return { key: windowTabKey(machine, window.id), label, title: windowTitle(machine, window), target: { kind: "window", id: window.id, machine }, service: null, window };
  });
}

function windowTitle(machine: Machine, window: TmuxWindow): string {
  const what = window.script ? `npm run ${window.script} in the tmux window ${window.name}` : `The tmux window ${window.name}`;
  if (machine === "vm") return `${what} on the VM; its output goes to ~/logs/${window.name}.log`;
  const owner = window.owner ? "" : "; Hunt does not know which session it belongs to";
  return `${what} on this Mac; its output goes to .hunt/logs/desktop/${window.name}.log${owner}`;
}
