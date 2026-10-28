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
  /**
   * Values picked last by config ID (`model`, `effort`: in the start view, a chat or a sub chat) plus `mode` and
   * `workspace` (`worktree` or `checkout`) of the start view; every new session and sub chat starts with them.
   */
  preferred: Record<string, string>;
  /** Effort picked last with each model, by model ID; picking the model again brings it back. */
  effortByModel: Record<string, string>;
  /** Repositories top-level sessions were started in, most recent first; the start view preselects the first and offers the rest. */
  recentRepoPaths: string[];
  rememberOptions: (options: SessionConfigOption[]) => void;
  rememberCommands: (repoPath: string, commands: AvailableCommand[]) => void;
  rememberRepoPath: (repoPath: string) => void;
  setPreferred: (id: string, value: string) => void;
  /**
   * Remembers `value` picked for the config option `configId` and returns the changes the pick makes, as `[configId,
   * value]` pairs in the order they apply. An effort is remembered together with `model`, the model it was picked with;
   * a model brings back the effort picked last with it.
   */
  pickConfig: (configId: string, value: string, model: string | null) => [string, string][];
};

/** How many recently used repositories the start view offers. */
export const RECENT_REPO_LIMIT = 8;

/** `paths` with `repoPath` moved to the front, deduplicated and cut to `RECENT_REPO_LIMIT`. */
export function withRecentRepoPath(paths: string[], repoPath: string): string[] {
  return [repoPath, ...paths.filter((path) => path !== repoPath)].slice(0, RECENT_REPO_LIMIT);
}

/** Agent settings applied to every new session; survives restarts under `hunt-agent-defaults`, kept in step across windows by `useSettingsSync`. */
export const useAgentDefaultsStore = create<AgentDefaultsState>()(
  persist(
    (set, get) => ({
      knownOptions: [],
      knownCommands: {},
      preferred: {},
      effortByModel: {},
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
      pickConfig: (configId, value, model) => {
        if (configId === "effort" && model) {
          set((state) => ({ preferred: { ...state.preferred, model, effort: value }, effortByModel: { ...state.effortByModel, [model]: value } }));
          return [[configId, value]];
        }
        const effort = configId === "model" ? get().effortByModel[value] : undefined;
        const changes: [string, string][] = effort ? [[configId, value], ["effort", effort]] : [[configId, value]];
        set((state) => ({ preferred: { ...state.preferred, ...Object.fromEntries(changes) } }));
        return changes;
      },
    }),
    { name: "hunt-agent-defaults" },
  ),
);

/** The slash commands last seen for `repoPath`, else those of the repository remembered last; built-in commands are the same everywhere. */
export function commandsFor(knownCommands: Record<string, AvailableCommand[]>, repoPath: string): AvailableCommand[] {
  const lists = Object.values(knownCommands);
  return knownCommands[repoPath] ?? lists[lists.length - 1] ?? [];
}
