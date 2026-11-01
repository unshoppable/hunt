import { dirName } from "../common/path/path.utils";
import type { EditChanges, WorktreePathChanges } from "../sessions/session.types";

/**
 * The changes behind the bumps of a chat's `editVersion` from `handledVersion` to `editVersion`: the paths the worktree
 * watch named when its bump was the only one, otherwise null, since a bump of any other kind (or two bumps in one
 * render) may have changed anything.
 */
export function changesSince(handledVersion: number, editVersion: number, editChanges: EditChanges | null): WorktreePathChanges | null {
  if (editVersion !== handledVersion + 1 || editChanges?.editVersion !== editVersion) return null;
  return editChanges.changes;
}

/**
 * The folders of `listed` to list again after `changes`: the folder of every path that was created, removed or
 * renamed, and such a path itself when it is a listed folder; every listed folder when anything may have changed.
 */
export function foldersToRelist(listed: readonly string[], changes: WorktreePathChanges | null): string[] {
  if (!changes) return [...listed];
  const touched = new Set(changes.entryPaths.flatMap((path) => [dirName(path), path]));
  return listed.filter((folder) => touched.has(folder));
}
