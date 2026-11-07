import { commands } from "../ipc/commands";
import { usePreviewStore } from "../preview/preview.store";
import { useSessionViewStore } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { useServicesStore } from "../terminal/services.store";
import { terminalTabs, windowTabKey, type TerminalTab } from "../terminal/terminal-tabs.utils";
import type { Machine } from "../terminal/terminal.types";
import { NO_SESSION_WINDOWS, useTerminalStore } from "../terminal/terminals.store";
import { errorText } from "../ui/error-text.utils";
import type { TerminalAction } from "./tab-commands.utils";
import { parseWindowTabKey, shellDirectory, tabWithKey, terminalState, type TerminalState } from "./terminal-commands.utils";

/**
 * Runs `action` on the Terminal tab of `session` and shows that tab; without an action resolves to the tab's state, as
 * `hunt-client terminal` prints it. `select` shows a tab by its key, `new` opens a shell as the panel's "+" does and
 * resolves to the key of its tab, `rerun` runs a window's command again as "Run again" does and shows its tab.
 */
export async function runTerminalCommand(session: SessionView, action: TerminalAction | undefined): Promise<TerminalState | { key: string } | undefined> {
  if (!action) return readTerminalState(session);
  const { updateView, setTab } = useSessionViewStore.getState();
  switch (action.name) {
    case "select": {
      const { tabs } = await readTabs(session);
      tabWithKey(tabs, action.key);
      updateView(session.id, { terminalTab: action.key });
      setTab(session.id, "terminal");
      return;
    }
    case "new": {
      const machine: Machine = session.remote ? "vm" : "desktop";
      const id = await commands.openShellWindow(session.id, shellDirectory(action.directory, session.worktreePath), action.script ?? null);
      const key = windowTabKey(machine, id);
      const { tabs } = await readTabs(session);
      if (tabs.some((tab) => tab.key === key)) {
        updateView(session.id, { terminalTab: key });
      }
      setTab(session.id, "terminal");
      return { key };
    }
    case "rerun": {
      const target = parseWindowTabKey(action.key);
      if (!target) throw new Error(`${action.key} is no window's tab; rerun takes a key window:<machine>:<id>`);
      const { tabs } = await readTabs(session);
      tabWithKey(tabs, action.key);
      await commands.rerunTerminalWindow(session.id, target.machine, target.id);
      updateView(session.id, { terminalTab: action.key });
      setTab(session.id, "terminal");
      return;
    }
  }
}

async function readTerminalState(session: SessionView): Promise<TerminalState> {
  const { tabs, error } = await readTabs(session);
  const preview = usePreviewStore.getState().previews[session.id];
  const storedKey = useSessionViewStore.getState().views[session.id]?.terminalTab ?? null;
  const awaitingStart = session.remote ? Boolean(preview?.awaitingStart) : undefined;
  return terminalState(tabs, session.id, storedKey, preview?.status?.vmRunning ?? true, awaitingStart, error);
}

/**
 * Reads what the Terminal panel polls (the tmux windows, the services of hunt.json; the VM only while the session is
 * live, which proves a running VM) and resolves to the tabs the panel lists then, with the first reason a read failed.
 */
async function readTabs(session: SessionView): Promise<{ tabs: TerminalTab[]; error: string | null }> {
  const isRemote = Boolean(session.remote);
  const isVmReadable = isRemote && session.isLive;
  const machines: Machine[] = isVmReadable ? ["vm", "desktop"] : ["desktop"];
  const { refreshWindows } = useTerminalStore.getState();
  const servicesRead = !isRemote
    ? useServicesStore.getState().refresh(session.id)
    : isVmReadable && session.remote?.previewDomain
      ? usePreviewStore.getState().refresh(session.id)
      : Promise.resolve();
  const reads = await Promise.allSettled([...machines.map((machine) => refreshWindows(session.id, machine)), servicesRead]);
  const failedRead = reads.find((read): read is PromiseRejectedResult => read.status === "rejected");

  const windows = useTerminalStore.getState().windows[session.id] ?? NO_SESSION_WINDOWS;
  const preview = usePreviewStore.getState().previews[session.id];
  const localServices = isRemote ? undefined : useServicesStore.getState().services[session.id];
  const tabs = terminalTabs(preview?.status?.services ?? [], windows.vm ?? [], windows.desktop ?? [], isRemote, localServices?.status?.services ?? []);
  const servicesProblem = isRemote ? (preview?.error ?? null) : (localServices?.status?.problem ?? localServices?.error ?? null);
  return { tabs, error: failedRead ? errorText(failedRead.reason) : servicesProblem };
}
