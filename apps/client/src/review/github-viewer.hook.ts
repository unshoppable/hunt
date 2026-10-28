import { useState } from "react";
import { commands } from "../ipc/commands";
import type { GithubViewer } from "./review.types";
import { useHuntStore } from "../sessions/hunt.store";
import { useLoad } from "../ui/load.hook";

/** One `gh api user` per repository; a failed load is forgotten so that the next avatar tries again. */
const viewerLoads = new Map<string, Promise<GithubViewer>>();

function loadViewer(repoPath: string): Promise<GithubViewer> {
  const cached = viewerLoads.get(repoPath);
  if (cached) return cached;
  const load = commands.githubViewer(repoPath).catch((reason) => {
    viewerLoads.delete(repoPath);
    throw reason;
  });
  viewerLoads.set(repoPath, load);
  return load;
}

/** The GitHub account `gh` is logged in as for the repository of `sessionId`; null while it loads or when it cannot be looked up. */
export function useGithubViewer(sessionId: string): GithubViewer | null {
  const repoPath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.repoPath ?? null);
  const [viewer, setViewer] = useState<GithubViewer | null>(null);
  useLoad(() => (repoPath ? loadViewer(repoPath) : Promise.resolve(null)), { onValue: setViewer, onError: () => setViewer(null) }, [repoPath]);
  return viewer;
}
