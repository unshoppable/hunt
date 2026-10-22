import { create } from "zustand";
import type { ScriptRunRequest } from "../ipc/types";

/** An embedded terminal of a local session: a login shell or a run of a package.json script. */
export type LocalTerminal = {
  id: string;
  /** The worktree folder it starts in; `""` is the worktree. */
  directory: string;
  /** The package.json script it runs; null for a shell. */
  script: string | null;
  /** Counts the runs of a script; each new value runs it again in a fresh terminal. */
  run: number;
  /** Its program runs. */
  isRunning: boolean;
};

/** The terminals of one local session in their tab order, and the one its Terminal tab shows. */
export type LocalTerminals = { terminals: LocalTerminal[]; activeId: string | null };

export const NO_LOCAL_TERMINALS: LocalTerminals = { terminals: [], activeId: null };

/** `current` with a new shell `id` in the worktree, shown. */
export function withShell(current: LocalTerminals, id: string): LocalTerminals {
  return { terminals: [...current.terminals, { id, directory: "", script: null, run: 0, isRunning: false }], activeId: id };
}

/**
 * `current` with the run of `request` shown: a script whose terminal still runs keeps running, one that ended runs
 * again in its tab, any other one gets a new tab `id`.
 */
export function withScriptRun(current: LocalTerminals, request: Omit<ScriptRunRequest, "sessionId">, id: string): LocalTerminals {
  const existing = current.terminals.find((terminal) => terminal.script === request.script && terminal.directory === request.directory);
  if (!existing) {
    const terminal: LocalTerminal = { id, directory: request.directory, script: request.script, run: 0, isRunning: false };
    return { terminals: [...current.terminals, terminal], activeId: id };
  }
  const terminals = existing.isRunning
    ? current.terminals
    : current.terminals.map((terminal) => (terminal === existing ? { ...terminal, run: terminal.run + 1 } : terminal));
  return { terminals, activeId: existing.id };
}

/** `current` without the terminal `id`; when it was shown, the next one after it shows, else the one before it. */
export function withoutTerminal(current: LocalTerminals, id: string): LocalTerminals {
  const index = current.terminals.findIndex((terminal) => terminal.id === id);
  if (index < 0) return current;
  const terminals = current.terminals.filter((terminal) => terminal.id !== id);
  if (current.activeId !== id) return { terminals, activeId: current.activeId };
  return { terminals, activeId: (terminals[index] ?? terminals[index - 1])?.id ?? null };
}

type TerminalState = {
  /** The terminals of the local sessions by session ID; they run as long as the main window. */
  local: Record<string, LocalTerminals>;
  /** A script each remote session's Terminal panel runs once it shows, in a new tmux window on the VM. */
  remoteRuns: Record<string, ScriptRunRequest>;
  openShell: (sessionId: string) => void;
  runLocalScript: (request: ScriptRunRequest) => void;
  showTerminal: (sessionId: string, id: string) => void;
  closeTerminal: (sessionId: string, id: string) => void;
  setRunning: (sessionId: string, id: string, isRunning: boolean) => void;
  requestRemoteScript: (request: ScriptRunRequest) => void;
  /** Removes the pending remote run of the session and returns it. */
  takeRemoteRun: (sessionId: string) => ScriptRunRequest | null;
};

/** The terminals of the Terminal tab: local sessions' terminals and the script runs waiting for a remote session's panel. */
export const useTerminalStore = create<TerminalState>((set, get) => {
  function update(sessionId: string, change: (current: LocalTerminals) => LocalTerminals) {
    set((state) => ({ local: { ...state.local, [sessionId]: change(state.local[sessionId] ?? NO_LOCAL_TERMINALS) } }));
  }

  return {
    local: {},
    remoteRuns: {},
    openShell: (sessionId) => update(sessionId, (current) => withShell(current, crypto.randomUUID())),
    runLocalScript: ({ sessionId, ...run }) => update(sessionId, (current) => withScriptRun(current, run, crypto.randomUUID())),
    showTerminal: (sessionId, id) => update(sessionId, (current) => (current.activeId === id ? current : { ...current, activeId: id })),
    closeTerminal: (sessionId, id) => update(sessionId, (current) => withoutTerminal(current, id)),
    setRunning: (sessionId, id, isRunning) =>
      update(sessionId, (current) => ({
        ...current,
        terminals: current.terminals.map((terminal) => (terminal.id === id && terminal.isRunning !== isRunning ? { ...terminal, isRunning } : terminal)),
      })),
    requestRemoteScript: (request) => set((state) => ({ remoteRuns: { ...state.remoteRuns, [request.sessionId]: request } })),
    takeRemoteRun: (sessionId) => {
      const run = get().remoteRuns[sessionId];
      if (!run) return null;
      set((state) => {
        const { [sessionId]: _taken, ...remoteRuns } = state.remoteRuns;
        return { remoteRuns };
      });
      return run;
    },
  };
});
