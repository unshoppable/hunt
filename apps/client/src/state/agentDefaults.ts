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
  /** Values picked for new sessions by config ID (`model`, `effort`) plus `mode` and `workspace` (`worktree` or `checkout`). */
  preferred: Record<string, string>;
  /** Repositories top-level sessions were started in, most recent first; the start view preselects the first and offers the rest. */
  recentRepoPaths: string[];
  rememberOptions: (options: SessionConfigOption[]) => void;
  rememberCommands: (repoPath: string, commands: AvailableCommand[]) => void;
  rememberRepoPath: (repoPath: string) => void;
  setPreferred: (id: string, value: string) => void;
};

/** How many recently used repositories the start view offers. */
export const RECENT_REPO_LIMIT = 8;

/** `paths` with `repoPath` moved to the front, deduplicated and cut to `RECENT_REPO_LIMIT`. */
export function withRecentRepoPath(paths: string[], repoPath: string): string[] {
  return [repoPath, ...paths.filter((path) => path !== repoPath)].slice(0, RECENT_REPO_LIMIT);
}

/** Agent settings applied to every new session; survives restarts under `hunt-agent-defaults`. */
export const useAgentDefaultsStore = create<AgentDefaultsState>()(
  persist(
    (set) => ({
      knownOptions: [],
      knownCommands: {},
      preferred: {},
      recentRepoPaths: [],
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
      rememberRepoPath: (repoPath) => {
        set((state) => ({ recentRepoPaths: withRecentRepoPath(state.recentRepoPaths, repoPath) }));
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
