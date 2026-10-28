import { create } from "zustand";
import { persist } from "zustand/middleware";
import { dirName } from "../../common/path/path.utils";

/** The colors a folder can be marked with in the project tree (WebStorm's file colors). */
export type FolderColor = "yellow" | "green" | "blue" | "rose" | "violet" | "orange" | "gray";

/** The swatch shown in the context menu and the row background (a translucent tint, so hover and selection stay visible). */
export const FOLDER_COLORS: Record<FolderColor, { label: string; swatch: string; background: string }> = {
  yellow: { label: "Yellow", swatch: "#facc15", background: "rgba(250, 204, 21, 0.14)" },
  green: { label: "Green", swatch: "#4ade80", background: "rgba(74, 222, 128, 0.14)" },
  blue: { label: "Blue", swatch: "#60a5fa", background: "rgba(96, 165, 250, 0.16)" },
  rose: { label: "Rose", swatch: "#fb7185", background: "rgba(251, 113, 133, 0.14)" },
  violet: { label: "Violet", swatch: "#a78bfa", background: "rgba(167, 139, 250, 0.16)" },
  orange: { label: "Orange", swatch: "#fb923c", background: "rgba(251, 146, 60, 0.14)" },
  gray: { label: "Gray", swatch: "#a3a3a3", background: "rgba(163, 163, 163, 0.12)" },
};

export const FOLDER_COLOR_NAMES = Object.keys(FOLDER_COLORS) as FolderColor[];

/** The marked folders of one repository: worktree-relative folder path → color. */
export type FolderMarks = Record<string, FolderColor>;

export const EMPTY_MARKS: FolderMarks = {};

type FolderColorState = {
  /** Marks by repository path; a mark colors the folder and everything below it in every session of the repository. */
  marksByRepo: Record<string, FolderMarks>;
  /** Marks `path` of the repository with `color`, or removes its mark with null. */
  setFolderColor: (repoPath: string, path: string, color: FolderColor | null) => void;
};

/** Folder marks that survive restarts (persisted in localStorage under `hunt-folder-colors`). */
export const useFolderColorStore = create<FolderColorState>()(
  persist(
    (set) => ({
      marksByRepo: {},
      setFolderColor: (repoPath, path, color) =>
        set((state) => {
          const marks = { ...(state.marksByRepo[repoPath] ?? EMPTY_MARKS) };
          if (color) {
            marks[path] = color;
          } else {
            delete marks[path];
          }
          return { marksByRepo: { ...state.marksByRepo, [repoPath]: marks } };
        }),
    }),
    { name: "hunt-folder-colors", partialize: (state) => ({ marksByRepo: state.marksByRepo }) },
  ),
);

/** The color `path` (a folder or file) shows: its own mark or that of the nearest marked ancestor; null when none is marked. */
export function markedColor(marks: FolderMarks, path: string): FolderColor | null {
  for (let current = path; current; current = dirName(current)) {
    const color = marks[current];
    if (color) return color;
  }
  return null;
}
