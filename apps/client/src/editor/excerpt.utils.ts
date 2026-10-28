import type { SemanticSpan } from "./semantic-tokens.monaco";

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
