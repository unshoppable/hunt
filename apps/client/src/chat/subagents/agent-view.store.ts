import { create } from "zustand";

/**
 * Which agent the chat of a session shows: the main agent (`null`) or a subagent by its child session ID. Kept in memory
 * only: a load replays the subagents under other IDs than they ran under.
 */
type AgentViewState = {
  selected: Record<string, string | null>;
  selectAgent: (sessionId: string, agentId: string | null) => void;
};

export const useAgentViewStore = create<AgentViewState>()((set) => ({
  selected: {},
  selectAgent: (sessionId, agentId) => set((state) => ({ selected: { ...state.selected, [sessionId]: agentId } })),
}));
