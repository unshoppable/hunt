import { create, type StoreApi } from "zustand";
import type { SessionView } from "./session.types";
import { createSessionSlice, type SessionSlice } from "./session.store-slice";
import { createRemoteSessionSlice, type RemoteSessionSlice } from "./remote/remote-session.store-slice";
import { createChatSlice, createChatTurns, type ChatSlice, type SessionChat } from "../chat/chat.store-slice";

/** The sessions, their chats and their remote state: the session, remote session and chat slices in one store. */
export type HuntState = SessionSlice & RemoteSessionSlice & ChatSlice;

/** The `set` of the Hunt store, which every slice writes the whole state with. */
export type HuntSet = StoreApi<HuntState>["setState"];

/** The `get` of the Hunt store, which every slice reads the whole state with. */
export type HuntGet = StoreApi<HuntState>["getState"];

export const useHuntStore = create<HuntState>((set, get, store) => {
  const turns = createChatTurns(set, get, store);
  return {
    ...createSessionSlice(set, get, turns),
    ...createRemoteSessionSlice(set, get, turns),
    ...createChatSlice(set, get, turns),
  };
});

export function useActiveChat(): SessionChat | null {
  return useHuntStore((state) => (state.activeSessionId ? (state.chats[state.activeSessionId] ?? null) : null));
}

export function useActiveSession(): SessionView | null {
  return useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId) ?? null);
}
