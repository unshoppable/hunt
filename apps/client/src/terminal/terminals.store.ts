import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { Machine, ScriptRunRequest, TmuxWindow } from "./terminal.types";

/** The windows of a session's tmux session `app` on each machine in tmux's order; null until the Terminal tab first read them. */
export type SessionWindows = Record<Machine, TmuxWindow[] | null>;

export const NO_SESSION_WINDOWS: SessionWindows = { vm: null, desktop: null };

type TerminalState = {
  /** The tmux windows by session ID; the Terminal panel polls them (see terminal/TerminalPanel.tsx). */
  windows: Record<string, SessionWindows>;
  /** A script each session's Terminal panel runs once it shows, in a tmux window of its own. */
  pendingRuns: Record<string, ScriptRunRequest>;
  /** Reads the windows of the session's tmux session `app` on `machine`; only the latest read lands. Rejects on failure. */
  refreshWindows: (id: string, machine: Machine) => Promise<void>;
  requestScript: (request: ScriptRunRequest) => void;
  /** Removes the pending run of the session and returns it. */
  takePendingRun: (sessionId: string) => ScriptRunRequest | null;
};

/** Bumped per session and machine by every read of its tmux windows, so that only the latest one lands. */
const windowReads = new Map<string, number>();

/** The tmux windows of the Terminal tab and the script runs waiting for a session's Terminal panel. */
export const useTerminalStore = create<TerminalState>((set, get) => ({
  windows: {},
  pendingRuns: {},

  refreshWindows: async (id, machine) => {
    const readKey = `${id}:${machine}`;
    const generation = (windowReads.get(readKey) ?? 0) + 1;
    windowReads.set(readKey, generation);
    try {
      const windows = await commands.terminalWindows(id, machine);
      if (windowReads.get(readKey) !== generation) return;
      set((state) => ({ windows: { ...state.windows, [id]: { ...(state.windows[id] ?? NO_SESSION_WINDOWS), [machine]: windows } } }));
    } catch (reason) {
      if (windowReads.get(readKey) !== generation) return;
      throw reason;
    }
  },

  requestScript: (request) => set((state) => ({ pendingRuns: { ...state.pendingRuns, [request.sessionId]: request } })),

  takePendingRun: (sessionId) => {
    const run = get().pendingRuns[sessionId];
    if (!run) return null;
    set((state) => {
      const { [sessionId]: _taken, ...pendingRuns } = state.pendingRuns;
      return { pendingRuns };
    });
    return run;
  },
}));
