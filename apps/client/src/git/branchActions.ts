import type { GitRef } from "../ipc/types";
import type { GitMenuEntry } from "./GitMenu";

/** The session's own local branch and the branch on `origin` a push of it lands on. */
export type PushRoute = { branch: string; target: string };

export type BranchActionKind = "checkout" | "rebase" | "merge" | "update" | "pull" | "forcePull" | "fetch" | "push" | "pushBranch" | "retarget" | "rename" | "delete" | "deleteRemote";

/** One entry of a branch's context menu. */
export type BranchAction = GitMenuEntry<BranchActionKind>;

export type BranchContext = {
  /** The checked-out branch of the worktree, `HEAD` when detached. */
  head: string;
  /** The session's branch and where its push lands; `null` without a session. */
  pushes: PushRoute | null;
  /** Whether the session's worktree lives on a VM, which has the session's branch under its name. */
  isRemoteSession: boolean;
  /** Whether the session is a poller session, whose VM pushes its branch under its own name. */
  isPollerSession: boolean;
  /** Why no branch can be checked out here (a session's worktree is bound to its branch); `null` when one can. */
  checkoutBlocked: string | null;
};

/** What the busy state of the branch tree says while an action runs. */
export const BUSY_LABELS: Record<BranchActionKind, string> = {
  checkout: "Checking out…",
  rebase: "Rebasing…",
  merge: "Merging…",
  update: "Updating…",
  pull: "Pulling…",
  forcePull: "Pulling…",
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
 * The context menu of the branch `ref`: check it out (a remote branch of origin as the local branch of its name), rebase
 * the checked-out branch onto it or merge it in, update or fetch it, push, rename and delete it. Hunt pushes the session's branch onto the branch it tracks on origin, so its Push and Update
 * name that branch and it alone can change the target; another local branch is pushed under its own name, pulled
 * from its upstream by a fast-forward or force pulled, which resets it to the upstream. A tag has no menu.
 */
export function branchActions(ref: GitRef, { head, pushes, isRemoteSession, isPollerSession, checkoutBlocked }: BranchContext): BranchAction[] {
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
  const branch = ref.kind === "remote" ? originBranchName(ref.name) : ref.name;
  const notOrigin = branch ? null : "Only branches of origin";
  const actions = [
    entry("checkout", "Checkout", checkoutBlocked ?? notOrigin ?? (branch === head ? "The branch is checked out" : null)),
    entry("rebase", `Rebase '${head}' onto '${ref.name}'`, notOntoItself, { startsGroup: true }),
    entry("merge", `Merge '${ref.name}' into '${head}'`, notOntoItself),
  ];
  if (ref.kind === "remote") {
    actions.push(entry("fetch", `Fetch '${ref.name}'`, notOrigin, { startsGroup: true }));
    actions.push(entry("deleteRemote", "Delete on origin", notOrigin, { isDanger: true, startsGroup: true }));
    return actions;
  }
  if (isSessionBranch && pushes) {
    actions.push(entry("update", `Update from 'origin/${pushes.target}'`, null, { startsGroup: true }));
    actions.push(entry("push", `Push to 'origin/${pushes.target}'`));
    actions.push(entry("retarget", "Change push target…", isPollerSession ? "A poller session pushes its own branch" : null));
  } else {
    const noUpstream = ref.upstream ? null : "The branch has no upstream";
    actions.push(entry("pull", ref.upstream ? `Pull from '${ref.upstream}'` : "Pull", noUpstream, { startsGroup: true }));
    actions.push(entry("forcePull", ref.upstream ? `Force pull from '${ref.upstream}'` : "Force pull", noUpstream, { isDanger: true }));
    actions.push(entry("pushBranch", `Push to 'origin/${ref.name}'`));
  }
  actions.push(entry("rename", "Rename…", isSessionBranch && isRemoteSession ? "The session's VM has the branch under this name" : null, { startsGroup: true }));
  actions.push(entry("delete", "Delete", isHead ? "The branch is checked out" : null, { isDanger: true }));
  return actions;
}

/**
 * The local branches that have no branch of the same name on `origin`, sorted by name; `kept` names the branches
 * that stay regardless: the checked-out one and those of the sessions in the repository, which are bound to worktrees.
 */
export function localBranchesWithoutOrigin(refs: readonly GitRef[], kept: ReadonlySet<string>): string[] {
  const onOrigin = new Set(refs.map((ref) => (ref.kind === "remote" ? originBranchName(ref.name) : null)));
  return refs
    .filter((ref) => ref.kind === "local" && !onOrigin.has(ref.name) && !kept.has(ref.name))
    .map((ref) => ref.name)
    .sort((left, right) => left.localeCompare(right));
}
