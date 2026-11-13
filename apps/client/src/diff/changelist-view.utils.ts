import { matchesGlob, splitGlobs } from "../common/glob/glob.utils";
import type { ChangeListTab } from "../sessions/inspector.store";
import type { SessionView, Workspace } from "../sessions/session.types";
import type { ChangelistScope } from "../settings/settings.store";
import { isInScope } from "./attribution.utils";
import type { ChangedFileView, Comparison } from "./diff.types";

/** The changelist's tab for the stored `storedTab`: a pull request review opens on the review tab, which exists only while a pull request is under review. */
export function shownChangeListTab(storedTab: ChangeListTab | undefined, isReviewing: boolean): ChangeListTab {
  const defaultTab: ChangeListTab = isReviewing ? "review" : "changelist";
  return !storedTab || (storedTab === "review" && !isReviewing) ? defaultTab : storedTab;
}

/**
 * The commit the user chose in the Git tab to compare `session` against ("Diff to Latest Commit" on a commit, "Compare"
 * on a branch), or `null`: the diff
 * base of a pull request review is the merge base of its pull request, which only its review tab compares against.
 */
export function chosenDiffBase(session: Pick<SessionView, "diffBase" | "pullRequest"> | undefined): string | null {
  return session && !session.pullRequest ? session.diffBase : null;
}

/**
 * What the changelist's `tab` compares against: the review tab the pull request's merge base, the changelist tab the
 * commit `chosenBase` the user chose (see `chosenDiffBase`). Without one the changelist shows only the uncommitted
 * changes, as the shelf tab always does, so committed files never appear there.
 */
export function changeListComparison(tab: ChangeListTab, chosenBase: string | null): Comparison {
  return tab === "review" || (tab === "changelist" && chosenBase) ? "diffBase" : "head";
}

/**
 * Whether the changelist of `session` can be scoped to its own changes: another session (parent or sub session) works
 * in the same worktree, or the session works in the repository's own checkout, which also holds the user's other work.
 */
export function sharesWorktree(sessions: readonly SessionView[], session: SessionView | undefined): boolean {
  return session?.workspace === "checkout" || sessions.some((candidate) => candidate.id !== session?.id && candidate.worktreePath === session?.worktreePath);
}

/** Who the changelist lists files for: the session, its parent and workspace, and the scope when it is scoped at all. */
export type ChangelistOwner = { sessionId: string; parentId: string | null; workspace: Workspace; scope: ChangelistScope | null };

/** The `files` the changelist of `owner` lists in its scope; every one of them without a scope. */
export function scopedChangedFiles(files: ChangedFileView[], { sessionId, parentId, workspace, scope }: ChangelistOwner): ChangedFileView[] {
  if (!scope) return files;
  return files.filter((file) => isInScope(file, scope, sessionId, parentId, workspace));
}

/** `files` minus those matching one of the changelist's hidden globs in `hiddenGlobsText`. */
export function withoutHiddenFiles(files: ChangedFileView[], hiddenGlobsText: string): ChangedFileView[] {
  const hiddenGlobs = splitGlobs(hiddenGlobsText);
  if (!hiddenGlobs.length) return files;
  return files.filter((file) => !hiddenGlobs.some((glob) => matchesGlob(glob, file.path)));
}
