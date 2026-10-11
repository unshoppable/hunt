import type { AvailableCommand, SessionConfigOption } from "@agentclientprotocol/sdk";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type AgentDefaultsState = {
  /** Config options the agent announced most recently; offered in the start view before a session exists. */
  knownOptions: SessionConfigOption[];
  /**
   * Slash commands the agent announced most recently, by repository path; offered in the start view before a session
   * exists. The repository remembered last comes last, so `commandsFor` can fall back to it for an unknown repository.
   */
  knownCommands: Record<string, AvailableCommand[]>;
  /** Values picked for new sessions by config ID (`model`, `effort`) plus `mode`. */
  preferred: Record<string, string>;
  rememberOptions: (options: SessionConfigOption[]) => void;
  rememberCommands: (repoPath: string, commands: AvailableCommand[]) => void;
  setPreferred: (id: string, value: string) => void;
};

/** Agent settings applied to every new session; survives restarts under `hunt-agent-defaults`. */
export const useAgentDefaultsStore = create<AgentDefaultsState>()(
  persist(
    (set) => ({
      knownOptions: [],
      knownCommands: {},
      preferred: {},
      rememberOptions: (options) => {
        if (options.length) {
          set({ knownOptions: options });
        }
      },
      rememberCommands: (repoPath, commands) => {
        if (!commands.length) return;
        set((state) => {
          const others = Object.fromEntries(Object.entries(state.knownCommands).filter(([path]) => path !== repoPath));
          return { knownCommands: { ...others, [repoPath]: commands } };
        });
      },
      setPreferred: (id, value) =>
        set((state) => ({ preferred: { ...state.preferred, [id]: value } })),
    }),
    { name: "hunt-agent-defaults" },
  ),
);

/** The slash commands last seen for `repoPath`, else those of the repository remembered last; built-in commands are the same everywhere. */
export function commandsFor(knownCommands: Record<string, AvailableCommand[]>, repoPath: string): AvailableCommand[] {
  const lists = Object.values(knownCommands);
  return knownCommands[repoPath] ?? lists[lists.length - 1] ?? [];
}
