import type { ChangelistScope } from "../settings/settings.store";
import type { SessionView, Workspace } from "../sessions/session.types";
import type { ChangedFileView } from "./diff.types";

/**
 * Ids of the sessions whose changes count as the own changes of `sessionId` in `scope`, in the changelist and in the
 * diff viewer's own lines: for `downstream` the session and its parent session, otherwise the session alone.
 */
export function scopeOwnerIds(scope: ChangelistScope, sessionId: string, parentId: string | null): string[] {
  return scope === "downstream" && parentId ? [sessionId, parentId] : [sessionId];
}

/**
 * Whether the changelist of `sessionId` lists `file` in `scope`: for `own` the session's tool calls touched it, for
 * `downstream` those of the session or of its parent session, for `all` every file counts. A change nobody's tool calls
 * made (an edit in another IDE, a restored shelf) belongs to the top-level session of a Hunt-owned worktree, which owns
 * that worktree, so a sub session lists it only in `downstream`; in a repository's own checkout, which also holds the
 * user's unrelated work, it belongs to no session.
 */
export function isInScope(file: ChangedFileView, scope: ChangelistScope, sessionId: string, parentId: string | null, workspace: Workspace): boolean {
  if (scope === "all") return true;
  const ownerIds = scopeOwnerIds(scope, sessionId, parentId);
  if (!file.touchedBy.length) return workspace === "worktree" && ownerIds.includes(parentId ?? sessionId);
  return file.touchedBy.some((id) => ownerIds.includes(id));
}

/** How many of `files` the changelist of `sessionId` lists in each scope. */
export function countByScope(files: ChangedFileView[], sessionId: string, parentId: string | null, workspace: Workspace): Record<ChangelistScope, number> {
  const count = (scope: ChangelistScope) => files.filter((file) => isInScope(file, scope, sessionId, parentId, workspace)).length;
  return { own: count("own"), downstream: count("downstream"), all: files.length };
}

/** Ids of the sessions besides `ownerIds` (from `scopeOwnerIds`) whose tool calls touched `file`. */
export function otherTouchers(file: ChangedFileView, ownerIds: string[]): string[] {
  return file.touchedBy.filter((id) => !ownerIds.includes(id));
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
