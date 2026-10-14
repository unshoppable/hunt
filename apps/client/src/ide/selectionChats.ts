import { useMemo } from "react";
import type { SelectionContext, SessionView } from "../ipc/types";
import { useHuntStore } from "../state/store";

/** A sub chat and the lines it was opened from. */
export type SelectionChat = { sessionId: string; selection: SelectionContext };

/**
 * Sub chats opened from a selection in `path` of the worktree `sessionId` works in; the session, its parent and
 * its siblings share that worktree, so every one of them sees the same chats. One per start line (the newest sub
 * chat wins), in the order of `sessions`.
 */
export function selectionChatsFor(sessions: SessionView[], sessionId: string, path: string): SelectionChat[] {
  const worktreePath = sessions.find((session) => session.id === sessionId)?.worktreePath;
  if (!worktreePath) return [];
  const chats: SelectionChat[] = [];
  const takenLines = new Set<number>();
  for (const session of sessions) {
    if (session.worktreePath !== worktreePath || session.selection?.path !== path) continue;
    const { selection } = session;
    if (takenLines.has(selection.startLine)) continue;
    takenLines.add(selection.startLine);
    chats.push({ sessionId: session.id, selection });
  }
  return chats;
}

/** Sub chats about selections in `path` of `sessionId`'s worktree (see `selectionChatsFor`). */
export function useSelectionChats(sessionId: string, path: string | null): SelectionChat[] {
  const sessions = useHuntStore((state) => state.sessions);
  return useMemo(() => (path ? selectionChatsFor(sessions, sessionId, path) : []), [sessions, sessionId, path]);
}

/**
 * IDs of the chats whose agent is running a turn right now; agent icons pulse for them. The store selector yields
 * the IDs as one sorted string so that a change elsewhere in a chat does not re-render the caller.
 */
export function useBusyChatIds(): ReadonlySet<string> {
  const joined = useHuntStore((state) =>
    Object.keys(state.chats)
      .filter((id) => state.chats[id].isBusy)
      .sort()
      .join("\n"),
  );
  return useMemo(() => new Set(joined ? joined.split("\n") : []), [joined]);
}
