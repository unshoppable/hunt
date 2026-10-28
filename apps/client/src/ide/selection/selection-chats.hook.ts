import { useMemo } from "react";
import { useHuntStore } from "../../sessions/hunt.store";
import { selectionChatsFor, type SelectionChat } from "./selection-chats.utils";

/** Sub chats about selections in `path` of `sessionId`'s worktree (see `selectionChatsFor`). */
export function useSelectionChats(sessionId: string, path: string | null): SelectionChat[] {
  const sessions = useHuntStore((state) => state.sessions);
  return useMemo(() => (path ? selectionChatsFor(sessions, sessionId, path) : []), [sessions, sessionId, path]);
}

/** IDs of the chats whose agent is running a turn right now; agent icons pulse for them. */
export function useBusyChatIds(): ReadonlySet<string> {
  return useChatIdsWhere("isBusy");
}

/** IDs of the chats with a reply the user has not looked at yet (see `SessionChat.hasUnseenActivity`); agent icons glow green for them. */
export function useUnseenChatIds(): ReadonlySet<string> {
  return useChatIdsWhere("hasUnseenActivity");
}

/**
 * IDs of the chats whose `flag` is set. The store selector yields the IDs as one sorted string so that a change
 * elsewhere in a chat does not re-render the caller.
 */
function useChatIdsWhere(flag: "isBusy" | "hasUnseenActivity"): ReadonlySet<string> {
  const joined = useHuntStore((state) =>
    Object.keys(state.chats)
      .filter((id) => state.chats[id][flag])
      .sort()
      .join("\n"),
  );
  return useMemo(() => new Set(joined ? joined.split("\n") : []), [joined]);
}
