import type { SemanticSpan } from "./semantic-tokens.monaco";

/** Marks where a list cut a line it shows (see ide/find_in_files.rs). */
const ELLIPSIS = "…";

/**
 * Moves the semantic `spans` of a whole file (offsets into `fileText`) onto `excerpt`, a copy of the file's lines from
 * `startLine` (1-based) on that may be dedented; spans outside the excerpt are dropped. Null when an excerpt line is not
 * its file line minus leading whitespace: the file changed since, or the excerpt is no copy of it.
 */
export function excerptSpans(fileText: string, spans: readonly SemanticSpan[], excerpt: string, startLine: number): SemanticSpan[] | null {
  const fileLines = fileText.split(/\r?\n/);
  const excerptLines = excerpt.split("\n");
  const firstIndex = startLine - 1;
  if (firstIndex < 0 || firstIndex + excerptLines.length > fileLines.length) return null;

  const indents: number[] = [];
  for (let index = 0; index < excerptLines.length; index++) {
    const fileLine = fileLines[firstIndex + index];
    const indent = fileLine.length - excerptLines[index].length;
    if (indent < 0 || !fileLine.endsWith(excerptLines[index]) || fileLine.slice(0, indent).trim()) return null;
    indents.push(indent);
  }

  const fileLineStarts = [0];
  for (const lineBreak of fileText.matchAll(/\r?\n/g)) {
    fileLineStarts.push(lineBreak.index + lineBreak[0].length);
  }
  const excerptLineStarts: number[] = [];
  let excerptOffset = 0;
  for (const line of excerptLines) {
    excerptLineStarts.push(excerptOffset);
    excerptOffset += line.length + 1;
  }

  const from = fileLineStarts[firstIndex];
  const to = fileLineStarts[firstIndex + excerptLines.length] ?? fileText.length;
  const result: SemanticSpan[] = [];
  for (const span of spans) {
    if (span.start < from || span.start >= to) continue;
    let index = excerptLines.length - 1;
    while (span.start < fileLineStarts[firstIndex + index]) {
      index--;
    }
    const column = span.start - fileLineStarts[firstIndex + index] - indents[index];
    if (column < 0) continue;
    result.push({ start: excerptLineStarts[index] + column, length: span.length, role: span.role });
  }
  return result;
}

/**
 * Moves the semantic `spans` of a whole file (offsets into `fileText`) onto `text`, a stretch of the file's line
 * `lineNumber` (1-based) as a list shows it: without leading whitespace, or cut with an ellipsis at either end. Spans
 * outside the stretch are dropped. Null when the line no longer contains the stretch.
 */
export function lineSpans(fileText: string, spans: readonly SemanticSpan[], lineNumber: number, text: string): SemanticSpan[] | null {
  let lineStart = 0;
  for (let line = 1; line < lineNumber; line++) {
    const lineBreak = fileText.indexOf("\n", lineStart);
    if (lineBreak < 0) return null;
    lineStart = lineBreak + 1;
  }
  const lineEnd = fileText.indexOf("\n", lineStart);
  const fileLine = fileText.slice(lineStart, lineEnd < 0 ? fileText.length : lineEnd).replace(/\r$/, "");

  const isCutAtStart = text.startsWith(ELLIPSIS);
  const isCutAtEnd = text.length > 1 && text.endsWith(ELLIPSIS);
  const stretch = text.slice(isCutAtStart ? 1 : 0, isCutAtEnd ? -1 : undefined);
  const column = fileLine.indexOf(stretch);
  if (column < 0) return null;

  const from = lineStart + column;
  const to = from + stretch.length;
  const shift = (isCutAtStart ? 1 : 0) - from;
  const result: SemanticSpan[] = [];
  for (const span of spans) {
    if (span.start < from || span.start >= to) continue;
    result.push({ start: span.start + shift, length: Math.min(span.length, to - span.start), role: span.role });
  }
  return result;
}
