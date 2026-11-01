/** Pure logic of renaming a file or folder with its usages (see RenamePathDialog.tsx and `planPathRename` in language-service.utils.ts). */

import { dirName } from "../../common/path/path.utils";
import type { WordMatch } from "./rename.utils";

/** A character that continues a path or a name, so an occurrence next to one is part of a longer path. */
const PATH_PART = /[\p{ID_Continue}.-]/u;

/**
 * Start offsets of the worktree path `path` in `lineText` where it stands as a whole path: not inside a longer name
 * (`src/domain` is not in `src/domains`), while a longer path below it (`src/domain/user.ts`) and an absolute path
 * ending in it count, so a mention in a document or a config is found wherever it is spelled.
 */
export function pathOffsets(lineText: string, path: string): number[] {
  const offsets: number[] = [];
  for (let offset = lineText.indexOf(path); offset !== -1; offset = lineText.indexOf(path, offset + 1)) {
    const before = lineText[offset - 1];
    const after = lineText[offset + path.length];
    if ((!before || !PATH_PART.test(before)) && (!after || !PATH_PART.test(after))) {
      offsets.push(offset);
    }
  }
  return offsets;
}

/** Whole-path matches of `path` in `lines` (0-based lines). */
export function pathMatches(lines: readonly string[], path: string): WordMatch[] {
  return lines.flatMap((lineText, line) => pathOffsets(lineText, path).map((offset) => ({ line, offset })));
}

/** Why `name` cannot be the new name of a file or folder, or null when it can: a name is one path segment. */
export function newNameProblem(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.includes("/")) return "A name holds no slash.";
  if (name === "." || name === "..") return `'${name}' is not a name.`;
  return null;
}

/** The worktree path of `path` renamed to `name` inside its folder. */
export function renamedTo(path: string, name: string): string {
  const dir = dirName(path);
  return dir ? `${dir}/${name}` : name;
}

/** Why a folder named `name` cannot be created, or null when it can; `a/b` creates nested folders. */
export function newFolderProblem(name: string): string | null {
  const segments = name.split("/");
  if (!name || segments.some((segment) => !segment.trim())) return "Enter a folder name.";
  if (segments.some((segment) => segment === "." || segment === "..")) return "A folder name is neither '.' nor '..'.";
  return null;
}
