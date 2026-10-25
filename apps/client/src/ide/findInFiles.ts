/** Display helpers for Find in Files (⇧⌘F, see FindInFilesDialog.tsx and find_in_files.rs). */

import type { HighlightedLine } from "../code/highlight";
import type { TextRange, TextSearchResult } from "../ipc/types";
import { sliceRuns } from "./usages";

export type TextPart = { text: string; isMatch: boolean };

/** A stretch of a colored line that is either matched or not. */
export type HighlightedPart = { runs: HighlightedLine; isMatch: boolean };

/** `text` cut into alternating plain and matched parts; `ranges` are sorted, non-overlapping and end exclusive. */
export function splitByRanges(text: string, ranges: readonly TextRange[]): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > cursor) {
      parts.push({ text: text.slice(cursor, start), isMatch: false });
    }
    parts.push({ text: text.slice(start, end), isMatch: true });
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), isMatch: false });
  }
  return parts;
}

/** The colored `runs` of one line cut at the matched `ranges` (see `splitByRanges`), so the rest of the line keeps its token colors. */
export function splitRunsByRanges(runs: HighlightedLine, ranges: readonly TextRange[]): HighlightedPart[] {
  const text = runs.map((run) => run.text).join("");
  let offset = 0;
  return splitByRanges(text, ranges).map((part) => {
    const start = offset;
    offset += part.text.length;
    return { runs: sliceRuns(runs, start, offset), isMatch: part.isMatch };
  });
}

/** WebStorm's header line: `12 matches in 3 files`, with `+` once the search stopped at its limit, or `No matches`. */
export function matchSummary(result: TextSearchResult): string {
  const more = result.isTruncated ? "+" : "";
  const lines = result.matches.length;
  if (!lines) return "No matches";
  const files = new Set(result.matches.map((match) => match.path)).size;
  return `${lines}${more} ${lines === 1 && !more ? "match" : "matches"} in ${files}${more} ${files === 1 && !more ? "file" : "files"}`;
}

/** A selection worth searching for: a single non-blank line. */
export function selectionQuery(selected: string | undefined): string | null {
  if (!selected?.trim() || selected.includes("\n")) return null;
  return selected;
}
