import type { ChangedFileView } from "../ipc/types";

/** Which changes the changelist shows: everything in the worktree, or only the session's own. */
export type ChangeScope = "all" | "own";

/**
 * Whether `file` counts as a change of `sessionId`: its tool calls touched the file, or those of its
 * parent session, or nobody's did (edits made in an IDE or by restoring a shelf). A sub session thus
 * shows the changelist of its parent plus its own changes; only sibling sub sessions are filtered out.
 */
export function isOwnChange(file: ChangedFileView, sessionId: string, parentId: string | null): boolean {
  if (!file.touchedBy.length) return true;
  return file.touchedBy.includes(sessionId) || (!!parentId && file.touchedBy.includes(parentId));
}

/** Ids of the other sessions whose tool calls touched `file`; the parent session counts as the session itself. */
export function otherTouchers(file: ChangedFileView, sessionId: string, parentId: string | null): string[] {
  return file.touchedBy.filter((id) => id !== sessionId && id !== parentId);
}
