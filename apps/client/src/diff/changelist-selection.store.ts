import { create } from "zustand";

type ChangelistSelectionState = {
  /**
   * The checked paths of every changelist, keyed by the parent session's id: a session and its sub sessions share one
   * checked set, so a selection made in one of them shows in all. Kept across session switches for the window's
   * lifetime, never stored.
   */
  checkedByFamily: Record<string, readonly string[]>;
  /** Checks exactly `paths` in the changelist of the parent session `familyId` and its sub sessions. */
  setChecked: (familyId: string, paths: Iterable<string>) => void;
};

export const useChangelistSelectionStore = create<ChangelistSelectionState>()((set) => ({
  checkedByFamily: {},
  setChecked: (familyId, paths) => set((state) => ({ checkedByFamily: { ...state.checkedByFamily, [familyId]: [...paths] } })),
}));
