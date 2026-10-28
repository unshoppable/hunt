import { useHuntStore } from "./hunt.store";
import { useAgentDefaultsStore } from "../chat/agent-defaults.store";
import { latestTopLevelSession } from "./session-labels.utils";

/**
 * The repository of the start view: the one the user chose, else the one used last, else the newest top-level
 * session's, which is listed only once the stored sessions are loaded after launch; empty while there is none.
 */
export function useStartRepoPath(): string {
  const chosen = useHuntStore((state) => state.startRepoPath);
  const recent = useAgentDefaultsStore((state) => state.recentRepoPaths[0] ?? null);
  const latest = useHuntStore((state) => latestTopLevelSession(state.sessions)?.repoPath ?? null);
  return chosen ?? recent ?? latest ?? "";
}
