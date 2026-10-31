/**
 * A Find in Files query (see ide/find_in_files.rs); `fileMask` takes comma-separated masks such as `*.ts, !*.spec.ts`.
 * With a `replacement` (Replace in Files; `$1` and `${name}` name the groups of a regex) every match carries its own.
 */
export type TextQuery = { text: string; matchCase: boolean; wholeWords: boolean; isRegex: boolean; fileMask: string; replacement?: string };

/** A range of UTF-16 code units, end exclusive. */
export type TextRange = { start: number; end: number };

/**
 * A matching line: 1-based line and columns of its first match, and the line's text with every match in it; with a
 * replacement in the query, `replacements` holds the one of each range.
 */
export type TextMatch = { path: string; line: number; column: number; endColumn: number; preview: string; ranges: TextRange[]; replacements?: string[] };

/** At most 500 matching lines in path order; `isTruncated` when more lines matched. */
export type TextSearchResult = { matches: TextMatch[]; isTruncated: boolean };

/** A line whose matches Replace in Files replaces; `line` is 1-based. */
export type FileLine = { path: string; line: number };

/** What Replace in Files replaced. */
export type ReplaceResult = { occurrences: number; files: number };
