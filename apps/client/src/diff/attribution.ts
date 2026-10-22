import type { ChangedFileView, SessionView, Workspace } from "../ipc/types";

/** Which changes the changelist shows: everything in the worktree, or only the session's own. */
export type ChangeScope = "all" | "own";

/**
 * Whether `file` counts as a change of `sessionId`: its tool calls touched the file, or those of its
 * parent session. A sub session thus shows the changelist of its parent plus its own changes; only
 * sibling sub sessions are filtered out. A change nobody's tool calls made (an edit in another IDE, a
 * restored shelf) belongs to every session of a Hunt-owned worktree, but to none of a repository's own
 * checkout, which also holds the user's unrelated work.
 */
export function isOwnChange(file: ChangedFileView, sessionId: string, parentId: string | null, workspace: Workspace): boolean {
  if (!file.touchedBy.length) return workspace === "worktree";
  return file.touchedBy.includes(sessionId) || (!!parentId && file.touchedBy.includes(parentId));
}

/** Ids of the other sessions whose tool calls touched `file`; the parent session counts as the session itself. */
export function otherTouchers(file: ChangedFileView, sessionId: string, parentId: string | null): string[] {
  return file.touchedBy.filter((id) => id !== sessionId && id !== parentId);
}

/**
 * Mark and title of the session `ownerId` as `sessionId` shows it: a sub session of another family carries its parent's
 * letter, e.g. `B2`; a deleted session shows `?`. `marks` come from `sessionMarks`.
 */
export function ownerLabel(
  ownerId: string,
  sessions: SessionView[],
  marks: ReadonlyMap<string, string>,
  sessionId: string,
  parentId: string | null,
): { mark: string; title: string } {
  const owner = sessions.find((candidate) => candidate.id === ownerId);
  if (!owner) return { mark: "?", title: "a deleted session" };
  const isOtherFamily = !!owner.parentId && owner.parentId !== sessionId && owner.parentId !== parentId;
  const parentMark = isOtherFamily && owner.parentId ? (marks.get(owner.parentId) ?? "") : "";
  return { mark: `${parentMark}${marks.get(ownerId) ?? "?"}`, title: owner.title };
}
