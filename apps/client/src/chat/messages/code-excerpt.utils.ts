import type { FileLocation } from "../change-references.utils";

/**
 * `location` moved to where the code block `excerpt` stands in `fileText`: the place whose lines match the excerpt's lines
 * up to its first line holding `…` (indentation ignored), nearest to the line the agent named. Without `…` the place spans
 * the whole excerpt; with it the end moves by the same offset. `location` itself when no place matches.
 */
export function locateExcerpt(fileText: string, excerpt: string, location: FileLocation): FileLocation {
  const fileLines = fileText.split(/\r?\n/).map((line) => line.trim());
  const excerptLines = excerpt.split(/\r?\n/).map((line) => line.trim());
  const elisionIndex = excerptLines.findIndex((line) => line.includes("…"));
  const leadingLines = elisionIndex < 0 ? excerptLines : excerptLines.slice(0, elisionIndex);
  if (!leadingLines.some(Boolean)) return location;
  let nearestStart = 0;
  for (let start = 1; start + leadingLines.length - 1 <= fileLines.length; start++) {
    if (!leadingLines.every((line, offset) => fileLines[start - 1 + offset] === line)) continue;
    if (!nearestStart || Math.abs(start - location.startLine) < Math.abs(nearestStart - location.startLine)) {
      nearestStart = start;
    }
  }
  if (!nearestStart) return location;
  const endLine = elisionIndex < 0 ? nearestStart + excerptLines.length - 1 : location.endLine + nearestStart - location.startLine;
  return { path: location.path, startLine: nearestStart, endLine: Math.max(nearestStart, endLine) };
}
