/**
 * Matching and ranking for the file search (⌘P / double shift), modelled on WebStorm's "Go to File":
 * a query without `/` is matched against file names first and whole paths second, a query with `/`
 * against whole paths only; a trailing `:line` requests a caret position.
 */

export type FileMatch = {
  path: string;
  name: string;
  /** Directory part of `path`, empty for root files. */
  dir: string;
  score: number;
  /** Indexes into `path` of the characters the query matched, for highlighting. */
  positions: number[];
};

export type ParsedQuery = { text: string; line: number | null };

/** Splits `ward-edit:42` into the search text and the requested line; the line is `null` when absent or invalid. */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  const match = /^(.*?):(\d+)$/.exec(trimmed);
  if (!match) return { text: trimmed, line: null };
  const line = Number(match[2]);
  return { text: match[1], line: line > 0 ? line : null };
}

type TextMatch = { score: number; positions: number[] };

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (previous === "/" || previous === "-" || previous === "_" || previous === "." || previous === " ") return true;
  const current = text[index];
  return current !== current.toLowerCase() && previous === previous.toLowerCase();
}

/** Matches `query` (already lowercased) as a substring or, failing that, as a subsequence of `text`. */
function matchText(text: string, query: string): TextMatch | null {
  const lower = text.toLowerCase();
  const substringIndex = lower.indexOf(query);
  if (substringIndex >= 0) {
    const boundaryBonus = substringIndex === 0 ? 40 : isBoundary(text, substringIndex) ? 20 : 0;
    const positions = Array.from({ length: query.length }, (_, offset) => substringIndex + offset);
    return { score: 100 + boundaryBonus - Math.min(substringIndex, 30), positions };
  }

  const positions: number[] = [];
  let score = 50;
  let cursor = 0;
  for (const char of query) {
    const index = lower.indexOf(char, cursor);
    if (index < 0) return null;
    const gap = index - cursor;
    if (positions.length && gap === 0) {
      score += 8;
    } else if (isBoundary(text, index)) {
      score += 5;
    } else {
      score -= Math.min(gap, 10);
    }
    positions.push(index);
    cursor = index + 1;
  }
  return { score, positions };
}

/** Ranks `paths` against `query`; the best `limit` matches come first. An empty query matches nothing. */
export function searchFiles(paths: readonly string[], query: string, limit = 50): FileMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const isPathQuery = needle.includes("/");
  const matches: FileMatch[] = [];
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dir = slash >= 0 ? path.slice(0, slash) : "";
    let match: FileMatch | null = null;
    if (!isPathQuery) {
      const byName = matchText(name, needle);
      if (byName) {
        const offset = slash + 1;
        match = { path, name, dir, score: 1000 + byName.score, positions: byName.positions.map((position) => position + offset) };
      }
    }
    if (!match) {
      const byPath = matchText(path, needle);
      if (byPath) {
        match = { path, name, dir, score: byPath.score, positions: byPath.positions };
      }
    }
    if (match) {
      matches.push(match);
    }
  }
  matches.sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path));
  return matches.slice(0, limit);
}
