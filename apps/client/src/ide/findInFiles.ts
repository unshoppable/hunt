/** Display helpers for Find in Files (⇧⌘F, see FindInFilesDialog.tsx and find_in_files.rs). */

import type { TextRange, TextSearchResult } from "../ipc/types";

export type TextPart = { text: string; isMatch: boolean };

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
