/** Colored lines quoted from a file in a result list (Find in Files, usages), cut out of the colors of the whole file. */

import type { HighlightedLine } from "../../editor/highlight.monaco";
import { sliceRuns } from "../language/usages.utils";

const ELLIPSIS = "…";

/**
 * The runs of `text` cut out of `lineRuns`, the colored runs of its file line: `text` is that line as a list shows it,
 * without its indentation and maybe cut with `…` at either end, each `…` taking the color next to it. Null when the line
 * does not hold `text` (the file changed).
 */
export function excerptRuns(lineRuns: HighlightedLine, text: string): HighlightedLine | null {
  const isCutAtStart = text.startsWith(ELLIPSIS);
  const isCutAtEnd = text.length > 1 && text.endsWith(ELLIPSIS);
  const stretch = text.slice(isCutAtStart ? 1 : 0, isCutAtEnd ? -1 : undefined);
  const column = lineRuns.map((run) => run.text).join("").indexOf(stretch);
  if (column < 0) return null;
  const runs = sliceRuns(lineRuns, column, column + stretch.length);
  if (!runs.length) return text ? null : [];
  if (isCutAtStart) {
    runs.unshift({ text: ELLIPSIS, style: runs[0].style });
  }
  if (isCutAtEnd) {
    runs.push({ text: ELLIPSIS, style: runs[runs.length - 1].style });
  }
  return runs;
}

/**
 * The value of `key` in `cache`, a map kept in the order of use that holds at most `capacity` entries: computed by
 * `compute` when missing, and dropped first once it is the least recently used. A null from `compute` is not kept.
 */
export function cachedValue<K, V>(cache: Map<K, V>, key: K, capacity: number, compute: () => V | null): V | null {
  if (cache.has(key)) {
    const value = cache.get(key) as V;
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  const value = compute();
  if (value === null) return null;
  cache.set(key, value);
  if (cache.size > capacity) {
    cache.delete(cache.keys().next().value as K);
  }
  return value;
}
