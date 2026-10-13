import { useState } from "react";
import { commands } from "../ipc/commands";
import type { GithubViewer } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { useLoad } from "../ui/useLoad";

/**
 * GitHub avatar of `login` from `url`, else from `github.com/<login>.png`, in a circle of the Tailwind `size`; the
 * first letter stands in while it loads or when it cannot be fetched (bots, offline), nothing while `login` is unknown.
 */
export function Avatar({ login, url, size }: { login: string | null; url?: string; size: string }) {
  const source = url || (login ? `https://github.com/${login}.png?size=64` : null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const initial = login?.replace(/^app\//, "").charAt(0).toUpperCase() ?? "";
  return (
    <span
      className={`relative flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-700 text-[12px] font-semibold text-neutral-200`}
      title={login ?? undefined}
    >
      {initial}
      {source && source !== failedSource ? (
        <img src={source} alt="" onError={() => setFailedSource(source)} className="absolute inset-0 size-full object-cover" />
      ) : null}
    </span>
  );
}

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

/** The `Avatar` of the viewer (see `useGithubViewer`); empty while it loads or when it cannot be looked up. */
export function ViewerAvatar({ sessionId, size }: { sessionId: string; size: string }) {
  const viewer = useGithubViewer(sessionId);
  return <Avatar login={viewer?.login ?? null} url={viewer?.avatarUrl} size={size} />;
}
