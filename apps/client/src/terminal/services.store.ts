import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { LocalServicesStatus } from "./terminal.types";
import { errorText } from "../ui/error-text.utils";

/** What Hunt knows about the hunt.json services of one local session. */
export type SessionServices = { status: LocalServicesStatus | null; error: string | null };

export const EMPTY_SERVICES: SessionServices = { status: null, error: null };

type ServicesState = {
  services: Record<string, SessionServices>;
  /** Reads the services of the session's hunt.json and the state of their windows; only the latest read lands. */
  refresh: (id: string) => Promise<void>;
  /** Starts the service `name`, or every service, and rejects with what went wrong; the Terminal tab shows their windows. */
  start: (id: string, name?: string) => Promise<void>;
  /** Stops the service `name` and rejects with what went wrong; its window stays with the output so far. */
  stop: (id: string, name: string) => Promise<void>;
  /** The services of the session for the agent: each with its state, port, log and whether its port accepts connections. */
  readReport: (id: string) => Promise<LocalServicesStatus>;
};

/** Bumped per session by every read of its services, so that only the latest one lands. */
const statusReads = new Map<string, number>();

/**
 * The hunt.json services of every local session whose Terminal tab showed them (see terminal/TerminalPanel.tsx) or whose
 * agent started one through hunt-client; `services:changed` refreshes them.
 */
export const useServicesStore = create<ServicesState>((set, get) => {
  function update(id: string, change: (services: SessionServices) => SessionServices) {
    set((state) => ({ services: { ...state.services, [id]: change(state.services[id] ?? EMPTY_SERVICES) } }));
  }

  return {
    services: {},

    refresh: async (id) => {
      const generation = (statusReads.get(id) ?? 0) + 1;
      statusReads.set(id, generation);
      try {
        const status = await commands.servicesStatus(id);
        if (statusReads.get(id) !== generation) return;
        update(id, () => ({ status, error: null }));
      } catch (reason) {
        if (statusReads.get(id) !== generation) return;
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      }
    },

    start: async (id, name) => {
      try {
        await commands.startServices(id, name ?? null);
      } finally {
        await get().refresh(id);
      }
    },

    stop: async (id, name) => {
      try {
        await commands.stopService(id, name);
      } finally {
        await get().refresh(id);
      }
    },

    readReport: (id) => commands.servicesStatus(id),
  };
});
