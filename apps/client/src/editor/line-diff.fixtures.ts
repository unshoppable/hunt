import { diffLines } from "diff";
import type { ChangeBlock } from "./line-diff.types";

/**
 * Change blocks of two texts for tests of the logic around them, from jsdiff's line diff. The app diffs in the backend
 * (`commands.diffLines`), whose hunk boundaries may differ where several are equally valid.
 */
export function changeBlocksOf(oldText: string, newText: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: ChangeBlock | null = null;
  for (const part of diffLines(oldText, newText)) {
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      current = null;
      oldLine += count;
      newLine += count;
      continue;
    }
    if (!current) {
      current = { original: { start: oldLine, end: oldLine }, modified: { start: newLine, end: newLine } };
      blocks.push(current);
    }
    if (part.removed) {
      current.original.end += count;
      oldLine += count;
    } else {
      current.modified.end += count;
      newLine += count;
    }
  }
  return blocks;
}

/** `changeBlocksOf` as the asynchronous `LineDiff` the app's code takes. */
export const testLineDiff = (oldText: string, newText: string): Promise<ChangeBlock[]> => Promise.resolve(changeBlocksOf(oldText, newText));
