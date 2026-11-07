import { useChangelistSelectionStore } from "../diff/changelist-selection.store";
import { changeListComparison, scopedChangedFiles, sharesWorktree, shownChangeListTab, withoutHiddenFiles } from "../diff/changelist-view.utils";
import type { ChangedFileView } from "../diff/diff.types";
import { commands } from "../ipc/commands";
import { reviewSessionOf } from "../review/review-comments.utils";
import { useHuntStore } from "../sessions/hunt.store";
import { useSessionViewStore, type ChangeListTab } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { useSettingsStore, type ChangelistScope } from "../settings/settings.store";
import { errorText } from "../ui/error-text.utils";
import type { DiffAction } from "./tab-commands.utils";
import { localWorktreePaths, unknownPaths } from "./worktree-paths.utils";

/** The changelist of a session as its Diff tab shows it: the parent session whose tab and checked files it shares, its tab, and its scope, which applies when `isScoped`. */
type Changelist = { familyId: string; isReviewing: boolean; tab: ChangeListTab; scope: ChangelistScope; isScoped: boolean };

/** The changed files of a changelist's tab: all of them, those in its scope, and those of these the hidden globs leave, which it lists. */
type ChangelistFiles = { all: ChangedFileView[]; scoped: ChangedFileView[]; listed: ChangedFileView[] };

function changelistOf(session: SessionView): Changelist {
  const { sessions } = useHuntStore.getState();
  const familyId = session.parentId ?? session.id;
  const isReviewing = Boolean(reviewSessionOf(sessions, session.id)?.pullRequest);
  const tab = shownChangeListTab(useSessionViewStore.getState().views[familyId]?.changeListTab, isReviewing);
  const scope = useSettingsStore.getState().changelistScopes[session.id] ?? "own";
  // The review tab lists every change of the pull request, whichever session made it.
  return { familyId, isReviewing, tab, scope, isScoped: sharesWorktree(sessions, session) && tab !== "review" };
}

async function changedFilesOf(session: SessionView, changelist: Changelist): Promise<ChangelistFiles> {
  const all = await commands.listChangedFiles(session.id, changeListComparison(changelist.tab));
  const owner = { sessionId: session.id, parentId: session.parentId, workspace: session.workspace, scope: changelist.isScoped ? changelist.scope : null };
  const scoped = scopedChangedFiles(all, owner);
  return { all, scoped, listed: withoutHiddenFiles(scoped, useSettingsStore.getState().changelistHiddenGlobs) };
}

/** The worktree-relative form of the absolute `paths`; throws naming those the changelist of `session` does not list. */
async function listedPaths(session: SessionView, changelist: Changelist, paths: readonly string[]): Promise<string[]> {
  const relativePaths = localWorktreePaths(session, paths);
  const { listed } = await changedFilesOf(session, changelist);
  const unknown = unknownPaths(relativePaths, listed.map((file) => file.path));
  if (unknown.length) throw new Error(`the changelist does not list ${unknown.join(", ")}`);
  return relativePaths;
}

/**
 * The Diff tab of `session` as `hunt-client diff` prints it; paths are worktree-relative. `changedFiles` are the files
 * the changelist lists after its scope and hidden globs, `hiddenCount` those the globs hide, `checkedPaths` the checked
 * ones among the listed. A failed read leaves its field null; why the changed files failed is in `error`.
 */
async function readDiffState(session: SessionView): Promise<unknown> {
  const changelist = changelistOf(session);
  const view = useSessionViewStore.getState().views[session.id];
  const settings = useSettingsStore.getState();
  const [files, unpushedCommitCount, shelves] = await Promise.all([
    changedFilesOf(session, changelist).catch((reason: unknown) => new Error(errorText(reason))),
    commands.unpushedCommitCount(session.id).catch(() => null),
    commands.listShelves(session.id).then(
      (list) => list.map((shelf) => shelf.name),
      () => null,
    ),
  ]);
  const listed = files instanceof Error ? [] : files.listed;
  const checked = new Set(useChangelistSelectionStore.getState().checkedByFamily[changelist.familyId]);
  return {
    subtab: changelist.tab,
    scope: changelist.scope,
    isScoped: changelist.isScoped,
    hiddenGlobs: settings.changelistHiddenGlobs,
    view: settings.changelistView,
    lineScope: settings.diffLineScope,
    selectedPath: view?.diffPath ?? null,
    mode: view?.diffMode ?? "split",
    collapsed: view?.diffCollapsed ?? false,
    changedFiles: listed.map(({ path, status, touchedBy }) => ({ path, status, touchedBy })),
    hiddenCount: files instanceof Error ? 0 : files.scoped.length - files.listed.length,
    checkedPaths: listed.filter((file) => checked.has(file.path)).map((file) => file.path),
    unpushedCommitCount,
    shelves,
    reviewDraftCount: reviewSessionOf(useHuntStore.getState().sessions, session.id)?.reviewComments.length ?? 0,
    error: files instanceof Error ? files.message : null,
  };
}

/** Runs `action` on the Diff tab of `session` and shows that tab; without an action resolves to the tab's state, as `hunt-client diff` prints it. */
export async function runDiffCommand(session: SessionView, action: DiffAction | undefined): Promise<unknown> {
  if (!action) return readDiffState(session);
  const viewStore = useSessionViewStore.getState();
  const settings = useSettingsStore.getState();
  switch (action.name) {
    case "select": {
      const [path = null] = action.path ? await listedPaths(session, changelistOf(session), [action.path]) : [];
      viewStore.setDiffPath(session.id, path);
      break;
    }
    case "subtab": {
      const changelist = changelistOf(session);
      if (action.tab === "review" && !changelist.isReviewing) throw new Error("the session reviews no pull request, so its changelist has no review tab");
      viewStore.setChangeListTab(changelist.familyId, action.tab);
      break;
    }
    case "scope":
      settings.setChangelistScope(session.id, action.scope);
      break;
    case "globs":
      settings.setChangelistHiddenGlobs(action.globs);
      break;
    case "view":
      settings.setChangelistView(action.view);
      break;
    case "lines":
      settings.setDiffLineScope(action.scope);
      break;
    case "mode":
      viewStore.updateView(session.id, { diffMode: action.mode });
      break;
    case "collapse":
      viewStore.updateView(session.id, { diffCollapsed: action.collapsed });
      break;
    case "check": {
      const changelist = changelistOf(session);
      useChangelistSelectionStore.getState().setChecked(changelist.familyId, await listedPaths(session, changelist, action.paths));
      break;
    }
  }
  useSessionViewStore.getState().setTab(session.id, "diff");
}
