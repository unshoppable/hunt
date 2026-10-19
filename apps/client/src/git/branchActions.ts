import type { GitRef } from "../ipc/types";

/** The session's own local branch and the branch on `origin` a push of it lands on. */
export type PushRoute = { branch: string; target: string };

export type BranchActionKind = "rebase" | "merge" | "update" | "fetch" | "push" | "pushBranch" | "retarget" | "rename" | "delete" | "deleteRemote";

/** One entry of a branch's context menu. */
export type BranchAction = {
  kind: BranchActionKind;
  label: string;
  /** Why the entry cannot run, shown as its tooltip; `null` when it can. */
  disabledReason: string | null;
  /** Shown in red: the entry removes something. */
  isDanger: boolean;
  /** Opens a new group of the menu, separated from the entries before. */
  startsGroup: boolean;
};

export type BranchContext = {
  /** The checked-out branch of the worktree, `HEAD` when detached. */
  head: string;
  /** The session's branch and where its push lands; `null` without a session. */
  pushes: PushRoute | null;
  /** Whether the session's worktree lives on a VM, which has the session's branch under its name. */
  isRemoteSession: boolean;
};

/** What the busy state of the branch tree says while an action runs. */
export const BUSY_LABELS: Record<BranchActionKind, string> = {
  rebase: "Rebasing…",
  merge: "Merging…",
  update: "Updating…",
  fetch: "Fetching…",
  push: "Pushing…",
  pushBranch: "Pushing…",
  retarget: "Changing the push target…",
  rename: "Renaming…",
  delete: "Deleting…",
  deleteRemote: "Deleting…",
};

/** The branch `name` of `origin/<name>`; `null` for a branch of another remote. */
export function originBranchName(remoteBranch: string): string | null {
  return remoteBranch.startsWith("origin/") ? remoteBranch.slice("origin/".length) : null;
}

/**
 * The context menu of the branch `ref`: rebase the checked-out branch onto it or merge it in, update or fetch it, push,
 * rename and delete it. Hunt pushes the session's branch onto the branch it was created from, so its Push and Update
 * name that branch and it alone can change the target; another local branch is pushed under its own name and
 * fast-forwarded from its upstream. A tag has no menu.
 */
export function branchActions(ref: GitRef, { head, pushes, isRemoteSession }: BranchContext): BranchAction[] {
  if (ref.kind === "tag") return [];
  const isHead = ref.name === head;
  const isSessionBranch = ref.name === pushes?.branch;
  const notOntoItself = head === "HEAD" ? "No branch is checked out" : isHead ? "The branch is checked out" : null;
  const entry = (kind: BranchActionKind, label: string, disabledReason: string | null = null, options: { isDanger?: boolean; startsGroup?: boolean } = {}): BranchAction => ({
    kind,
    label,
    disabledReason,
    isDanger: options.isDanger ?? false,
    startsGroup: options.startsGroup ?? false,
  });
  const actions = [entry("rebase", `Rebase '${head}' onto '${ref.name}'`, notOntoItself), entry("merge", `Merge '${ref.name}' into '${head}'`, notOntoItself)];
  if (ref.kind === "remote") {
    const branch = originBranchName(ref.name);
    const notOrigin = branch ? null : "Only branches of origin";
    actions.push(entry("fetch", `Fetch '${ref.name}'`, notOrigin, { startsGroup: true }));
    actions.push(entry("deleteRemote", "Delete on origin", notOrigin, { isDanger: true, startsGroup: true }));
    return actions;
  }
  if (isSessionBranch && pushes) {
    actions.push(entry("update", `Update from 'origin/${pushes.target}'`, null, { startsGroup: true }));
    actions.push(entry("push", `Push to 'origin/${pushes.target}'`));
    actions.push(entry("retarget", "Change push target…", isRemoteSession && pushes.target === pushes.branch ? "A poller session pushes its own branch" : null));
  } else {
    actions.push(entry("update", ref.upstream ? `Update from '${ref.upstream}'` : "Update", ref.upstream ? null : "The branch has no upstream", { startsGroup: true }));
    actions.push(entry("pushBranch", `Push to 'origin/${ref.name}'`));
  }
  actions.push(entry("rename", "Rename…", isSessionBranch && isRemoteSession ? "The session's VM has the branch under this name" : null, { startsGroup: true }));
  actions.push(entry("delete", "Delete", isHead ? "The branch is checked out" : null, { isDanger: true }));
  return actions;
}
