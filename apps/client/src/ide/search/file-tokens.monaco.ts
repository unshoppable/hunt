/**
 * The grammar colors of a line quoted from a file, taken from the tokens of the whole file, so a line inside a block
 * comment or a multi-line template string is colored as in the editor; the line alone would start from the grammar's
 * initial state. The tokens of the files used last are kept per text, as in OpenIDEA's `src/editor/lineTokens.tsx`
 * (Apache-2.0).
 */

import { tokenizeCode, type HighlightedLine } from "../../editor/highlight.monaco";
import { cachedValue, excerptRuns } from "./line-runs.utils";

/** Files whose tokens are kept. */
const CACHED_FILES = 40;
/** Longer texts (bundles, generated code) are not tokenized as a whole. */
const MAX_TEXT_LENGTH = 500_000;

/** The tokens of each file text by that text; one text holds the tokens of one language. */
const tokensByText = new Map<string, { language: string; lines: HighlightedLine[] }>();

/**
 * The grammar runs of `text`, line `lineNumber` (1-based) of `fileText` as a list shows it (see `excerptRuns`), with
 * the grammar of `language`. Null when the grammar is not loaded, the text is too long or the line no longer holds
 * `text`; the caller then tokenizes `text` alone.
 */
export function fileLineRuns(fileText: string, language: string, lineNumber: number, text: string): HighlightedLine | null {
  if (fileText.length > MAX_TEXT_LENGTH) return null;
  if (tokensByText.get(fileText)?.language !== language) {
    tokensByText.delete(fileText);
  }
  const tokens = cachedValue(tokensByText, fileText, CACHED_FILES, () => {
    const lines = tokenizeCode(fileText, language);
    return lines ? { language, lines } : null;
  });
  const lineRuns = tokens?.lines[lineNumber - 1];
  return lineRuns ? excerptRuns(lineRuns, text) : null;
}
