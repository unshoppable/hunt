import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CommitTypeChoice } from "./commit-type.utils";

type CommitTypeState = {
  /** The commit type last chosen in a session's commit box, by session id. */
  choiceBySession: Record<string, CommitTypeChoice>;
  setCommitType: (sessionId: string, choice: CommitTypeChoice) => void;
};

/** Commit types last chosen per session, surviving restarts (persisted in localStorage under `hunt-commit-types`). */
export const useCommitTypeStore = create<CommitTypeState>()(
  persist(
    (set) => ({
      choiceBySession: {},
      setCommitType: (sessionId, choice) => set((state) => ({ choiceBySession: { ...state.choiceBySession, [sessionId]: choice } })),
    }),
    { name: "hunt-commit-types", partialize: (state) => ({ choiceBySession: state.choiceBySession }) },
  ),
);

/** The commit type a session's box starts with: its own last choice, else its parent session's; null when neither chose one. */
export function rememberedCommitType(choiceBySession: Record<string, CommitTypeChoice>, sessionId: string, parentId: string | null): CommitTypeChoice | null {
  return choiceBySession[sessionId] ?? (parentId ? choiceBySession[parentId] : undefined) ?? null;
}
