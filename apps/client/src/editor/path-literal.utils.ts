/** A relative path written as a string literal (`'./user.page.html'`): the path and the 1-based columns of its text, quotes excluded. */
export type PathLiteral = { path: string; startColumn: number; endColumn: number };

/** Quoted text starting with `./` or `../` up to its closing quote, without whitespace or `${…}` interpolation. */
const PATH_LITERAL = /(['"`])(\.{1,2}\/[^'"`\s$]*)\1/g;

/**
 * The relative path literal on `line` whose text holds the 1-based `column`; like Monaco's words, the column right
 * behind its last character counts. Null when the column lies in no such literal.
 */
export function pathLiteralAt(line: string, column: number): PathLiteral | null {
  for (const match of line.matchAll(PATH_LITERAL)) {
    const path = match[2];
    const startColumn = match.index + 2;
    const endColumn = startColumn + path.length;
    if (column >= startColumn && column <= endColumn) return { path, startColumn, endColumn };
  }
  return null;
}
