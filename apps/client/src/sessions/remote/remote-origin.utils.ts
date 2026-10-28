import type { SessionView } from "../session.types";
import { repoName } from "../../common/path/path.utils";

/** Whether this Mac adopted the remote `session` from its VM instead of handing it off; other people may work on it too. */
export function isAdopted(session: SessionView): boolean {
  return Boolean(session.remote && session.remote.origin !== "handoff");
}

/**
 * Whether the agent of the session `sessionId` runs on a VM: only its own `remote` counts, since a sub session always
 * runs on this Mac, also when its parent runs on a VM. `sessions` is the store's list.
 */
export function runsOnVm(sessionId: string, sessions: SessionView[]): boolean {
  return Boolean(sessions.find((candidate) => candidate.id === sessionId)?.remote);
}

/**
 * The sidebar badge of an adopted session that no issue identifies: `swf` for one the gateway's poller started without
 * an issue, `remote` for another person's handoff; null for a session on an issue (`issueLabel` names it) and for one
 * this Mac runs or handed off.
 */
export function remoteOriginLabel(session: SessionView): string | null {
  const remote = session.remote;
  if (!remote || remote.origin === "handoff") return null;
  if (remote.origin === "swf") return remote.issue ? null : "swf";
  return "remote";
}

/** The issue the `session` works on, as `#123` for the sidebar's repository line; null without one. */
export function issueLabel(session: SessionView): string | null {
  const issue = session.remote?.issue;
  return issue ? `#${issue}` : null;
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
 * The question before deleting the remote `session` with its VM: the adopted one's, which names the other people, or
 * for this Mac's own handoff a warning about the work on the VM.
 */
export function remoteDeleteQuestion(session: SessionView): string {
  if (isAdopted(session)) return adoptedDeleteQuestion(session);
  const instance = session.remote?.vm.instance ?? "";
  return `Delete session "${session.title}", its local worktree and its VM ${instance}? Work on the VM that was not synced here is lost.`;
}

/** The question before removing the remote `session` from the sidebar, which leaves its VM alone. */
export function removeFromSidebarQuestion(session: SessionView): string {
  const instance = session.remote?.vm.instance ?? "";
  const worktree = session.hasLocalWorktree ? " and its local worktree is deleted" : "";
  return `Remove session "${session.title}" from the sidebar? Its VM ${instance} keeps running${worktree}; the list of remote sessions brings it back.`;
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
