/** A Find in Files query (see ide/find_in_files.rs); `fileMask` takes comma-separated masks such as `*.ts, !*.spec.ts`. */
export type TextQuery = { text: string; matchCase: boolean; wholeWords: boolean; isRegex: boolean; fileMask: string };

/** A range of UTF-16 code units, end exclusive. */
export type TextRange = { start: number; end: number };

/** A matching line: 1-based line and columns of its first match, and the line's text with every match in it. */
export type TextMatch = { path: string; line: number; column: number; endColumn: number; preview: string; ranges: TextRange[] };

/** At most 500 matching lines in path order; `isTruncated` when more lines matched. */
export type TextSearchResult = { matches: TextMatch[]; isTruncated: boolean };
