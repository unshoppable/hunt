import { useHuntStore } from "../sessions/hunt.store";

/** What the worktree tabs of a remote session show until Hunt copied its files here. */
export function NoLocalWorktree({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const message =
    session?.remote && !session.repoPath
      ? `There is no local checkout of ${session.remote.repo}. Start a session in one, then refresh the remote sessions in the sidebar; ` +
        "Hunt then copies this session's files here."
      : "Hunt copies the session's files here once it reached the VM; your next prompt starts the VM.";
  return <div className="flex h-full items-center justify-center px-8 text-center text-[14px] text-neutral-500">{message}</div>;
}
