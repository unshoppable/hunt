import type { SelectionContext } from "../../editor/selection-context.types";
import type { SessionView } from "../../sessions/session.types";

/** A sub chat and the lines it was opened from. */
export type SelectionChat = { sessionId: string; selection: SelectionContext };

/**
 * Sub chats opened from a selection in `path` of the worktree `sessionId` works in; the session, its parent and
 * its siblings share that worktree, so every one of them sees the same chats. One per diff side and start line (the
 * newest sub chat wins), in the order of `sessions`.
 */
export function selectionChatsFor(sessions: SessionView[], sessionId: string, path: string): SelectionChat[] {
  const worktreePath = sessions.find((session) => session.id === sessionId)?.worktreePath;
  if (!worktreePath) return [];
  const chats: SelectionChat[] = [];
  const takenLines = new Set<string>();
  for (const session of sessions) {
    if (session.worktreePath !== worktreePath || session.selection?.path !== path) continue;
    const { selection } = session;
    const lineKey = `${!!selection.isOriginal}:${selection.startLine}`;
    if (takenLines.has(lineKey)) continue;
    takenLines.add(lineKey);
    chats.push({ sessionId: session.id, selection });
  }
  return chats;
}
