import { describeService } from "../preview/preview-services.utils";
import { localServiceState, nextActiveKey, tabOwner, windowState, type TerminalTab } from "../terminal/terminal-tabs.utils";
import type { Machine } from "../terminal/terminal.types";
import { worktreeFilePath } from "./control-command.utils";

/** A tab of the Terminal tab as `hunt-client terminal` prints it: its state ("Running", how a script ended, …; null for a shell) and the other session its window belongs to. */
export type TerminalTabState = { key: string; label: string; state: string | null; owner: string | null };

/**
 * The Terminal tab as `hunt-client terminal` prints it: its tabs in their order, the key of the one it shows, for a
 * session on a VM whether the agent was asked to start the app and no service answers yet, and why the tabs could not
 * be read.
 */
export type TerminalState = { tabs: TerminalTabState[]; activeKey: string | null; awaitingStart?: boolean; error: string | null };

const MACHINES: readonly Machine[] = ["vm", "desktop"];
const WINDOW_KEY = /^window:([^:]+):(.+)$/;

/** The machine and tmux window ID of a window tab's key `window:<machine>:<id>`; null for any other key. */
export function parseWindowTabKey(key: string): { machine: Machine; id: string } | null {
  const match = WINDOW_KEY.exec(key);
  const machine = MACHINES.find((candidate) => candidate === match?.[1]);
  return match && machine ? { machine, id: match[2] } : null;
}

/** The tab of `tabs` with the key `key`; throws an Error listing the keys when there is none. */
export function tabWithKey(tabs: readonly TerminalTab[], key: string): TerminalTab {
  const tab = tabs.find((candidate) => candidate.key === key);
  if (tab) return tab;
  throw new Error(`the Terminal tab has no tab ${key}; its tabs are ${tabs.map((candidate) => candidate.key).join(", ") || "none"}`);
}

/** The worktree folder a shell opens in for the absolute `directory`: `""` for the worktree itself or none, else its worktree-relative path. */
export function shellDirectory(directory: string | undefined, worktreePath: string): string {
  if (!directory || directory === worktreePath) return "";
  return worktreeFilePath(directory, worktreePath);
}

/**
 * The state of the Terminal tab of the session `sessionId` with the tabs `tabs`: the shown tab is the stored `storedKey`
 * while it exists, else the first, as the panel picks it; `isVmRunning` words the states of the VM's services and
 * `awaitingStart` (undefined for a local session) is left out unless given.
 */
export function terminalState(
  tabs: readonly TerminalTab[],
  sessionId: string,
  storedKey: string | null,
  isVmRunning: boolean,
  awaitingStart: boolean | undefined,
  error: string | null,
): TerminalState {
  const tabStates = tabs.map((tab): TerminalTabState => {
    const description = tab.service
      ? describeService(tab.service, isVmRunning)
      : tab.localService
        ? localServiceState(tab.localService, tab.window)
        : tab.window
          ? windowState(tab.window)
          : null;
    return { key: tab.key, label: tab.label, state: description?.text ?? null, owner: tabOwner(tab, sessionId) };
  });
  const activeKey = nextActiveKey([], tabs, storedKey);
  return awaitingStart === undefined ? { tabs: tabStates, activeKey, error } : { tabs: tabStates, activeKey, awaitingStart, error };
}
