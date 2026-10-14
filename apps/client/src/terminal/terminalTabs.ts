import type { PreviewService, TerminalTarget, TmuxWindow } from "../ipc/types";

/** A tab of the Terminal panel: the log of a hunt.json service or a window of the VM's tmux session `app`. */
export type TerminalTab = {
  /** Stays the same while the process exists: `service:<name>` or `window:<tmux window ID>`. */
  key: string;
  label: string;
  target: TerminalTarget;
  /** The service the tab shows the log of; null for a window. */
  service: PreviewService | null;
};

/** The key of the tab that shows the tmux window `id`. */
export function windowTabKey(id: string): string {
  return `window:${id}`;
}

/**
 * The tabs in their order: the services as hunt.json lists them, then the windows in tmux's order. Windows of the same
 * name are told apart as "shell", "shell 2", "shell 3".
 */
export function terminalTabs(services: readonly PreviewService[], windows: readonly TmuxWindow[]): TerminalTab[] {
  const serviceTabs = services.map(
    (service): TerminalTab => ({ key: `service:${service.name}`, label: service.name, target: { kind: "service", name: service.name }, service }),
  );
  const seen = new Map<string, number>();
  const windowTabs = windows.map((window): TerminalTab => {
    const count = (seen.get(window.name) ?? 0) + 1;
    seen.set(window.name, count);
    const label = count === 1 ? window.name : `${window.name} ${count}`;
    return { key: windowTabKey(window.id), label, target: { kind: "window", id: window.id }, service: null };
  });
  return [...serviceTabs, ...windowTabs];
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
