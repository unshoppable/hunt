import type { SessionView } from "../ipc/types";
import { repoName } from "../ui/path";

/** Whether this Mac adopted the remote `session` from its VM instead of handing it off; other people may work on it too. */
export function isAdopted(session: SessionView): boolean {
  return Boolean(session.remote && session.remote.origin !== "handoff");
}

/**
 * The sidebar badge of an adopted session: `swf #123` (or `swf` without an issue) for one the gateway's poller started,
 * `remote` for another person's handoff; null for a session this Mac runs or handed off.
 */
export function remoteOriginLabel(session: SessionView): string | null {
  const remote = session.remote;
  if (!remote || remote.origin === "handoff") return null;
  if (remote.origin === "swf") return remote.issue ? `swf #${remote.issue}` : "swf";
  return "remote";
}

/** The tooltip of the sidebar badge or cloud icon: who started the remote `session` and which VM it runs on. */
export function remoteOriginTitle(session: SessionView): string | null {
  const remote = session.remote;
  if (!remote) return null;
  const vm = `Runs on the VM ${remote.vm.instance}`;
  if (remote.origin === "swf") {
    const issue = remote.issue ? `issue #${remote.issue} of ${remote.repo}` : `an issue of ${remote.repo}`;
    return `Started by the swf poller for ${issue}. ${vm}; other people may work on it too.`;
  }
  if (remote.origin === "desktop") return `Handed off from another Hunt. ${vm}; other people may work on it too.`;
  return vm;
}

/** The repository line of the sidebar: the local checkout's folder, or the VM's `<owner>/<repo>` while an adopted session has none. */
export function repositoryLabel(session: SessionView): string {
  if (session.repoPath) return repoName(session.repoPath);
  return session.remote?.repo ?? "";
}

/** Why the adopted `session` cannot be brought back yet: no local checkout of its repository is known; null otherwise. */
export function missingCheckoutBlocker(session: SessionView): string | null {
  if (!isAdopted(session) || session.repoPath || !session.remote) return null;
  return `Bringing it back needs a local checkout of ${session.remote.repo}: start a session in one, then refresh the remote sessions in the sidebar.`;
}

/** The question before deleting the adopted `session`, which deletes its VM for everybody. */
export function adoptedDeleteQuestion(session: SessionView): string {
  const instance = session.remote?.vm.instance ?? "";
  const warning = "Other people may be working on this session through Hunt; they lose it too, with all work on the VM that nobody brought back.";
  return `Delete session "${session.title}" and its VM ${instance}? ${warning}`;
}

/**
 * The question before bringing the adopted `session` back, which deletes its VM for everybody; it continues in the local
 * worktree its sync created, or in a new one.
 */
export function adoptedBringBackQuestion(session: SessionView): string {
  const instance = session.remote?.vm.instance ?? "";
  const warning = "Other people may be working on this session through Hunt; they lose it.";
  const worktree = session.hasLocalWorktree ? "its local worktree in" : "a new worktree of";
  return `Bring "${session.title}" back into ${worktree} ${repositoryLabel(session)}? Its VM ${instance} is deleted afterwards. ${warning}`;
}
