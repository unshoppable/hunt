import { diffLines, diffWordsWithSpace } from "diff";

/** Lines `start..end` (1-based, `end` exclusive). `start === end` is an empty range. */
export type LineRange = { start: number; end: number };

/** Original lines `original` became modified lines `modified`; an empty side marks a pure insertion or deletion. */
export type ChangeBlock = { original: LineRange; modified: LineRange };

/** A run of identical lines on both sides; both ranges have the same length. */
export type UnchangedRegion = { original: LineRange; modified: LineRange };

/** Columns `startColumn..endColumn` (1-based, exclusive) of one line. */
export type CharRange = { line: number; startColumn: number; endColumn: number };

export function rangeLength(range: LineRange): number {
  return range.end - range.start;
}

/** Line-level diff of two texts as change blocks in document order. */
export function computeChangeBlocks(oldText: string, newText: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: ChangeBlock | null = null;
  for (const part of diffLines(oldText, newText)) {
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      current = null;
      oldLine += count;
      newLine += count;
      continue;
    }
    if (!current) {
      current = { original: { start: oldLine, end: oldLine }, modified: { start: newLine, end: newLine } };
      blocks.push(current);
    }
    if (part.removed) {
      current.original.end += count;
      oldLine += count;
    } else {
      current.modified.end += count;
      newLine += count;
    }
  }
  return blocks;
}

/**
 * Unchanged runs between the blocks that are long enough to collapse, keeping `contextLines` visible next to
 * every block. The start and end of the file need no context.
 */
export function computeUnchangedRegions(
  blocks: ChangeBlock[],
  originalLineCount: number,
  modifiedLineCount: number,
  contextLines: number,
  minimumHiddenLines: number,
): UnchangedRegion[] {
  const regions: UnchangedRegion[] = [];
  let originalFrom = 1;
  let modifiedFrom = 1;
  const gaps = blocks.map((block) => ({ originalTo: block.original.start, modifiedTo: block.modified.start, isAtEnd: false }));
  gaps.push({ originalTo: originalLineCount + 1, modifiedTo: modifiedLineCount + 1, isAtEnd: true });

  for (const [index, gap] of gaps.entries()) {
    const leading = index === 0 ? 0 : contextLines;
    const trailing = gap.isAtEnd ? 0 : contextLines;
    const start = originalFrom + leading;
    const end = gap.originalTo - trailing;
    if (end - start >= minimumHiddenLines) {
      regions.push({
        original: { start, end },
        modified: { start: start - originalFrom + modifiedFrom, end: end - originalFrom + modifiedFrom },
      });
    }
    const block = blocks[index];
    if (block) {
      originalFrom = block.original.end;
      modifiedFrom = block.modified.end;
    }
  }
  return regions;
}

/**
 * Narrows `region` (identified by its original lines) to what is still unchanged under `blocks`, or returns
 * null when nothing of it survives. Used after edits so hidden lines never cover a change.
 */
export function clipUnchangedRegion(
  region: UnchangedRegion,
  blocks: ChangeBlock[],
  originalLineCount: number,
  modifiedLineCount: number,
  contextLines: number,
): UnchangedRegion | null {
  for (const candidate of computeUnchangedRegions(blocks, originalLineCount, modifiedLineCount, contextLines, 1)) {
    const start = Math.max(candidate.original.start, region.original.start);
    const end = Math.min(candidate.original.end, region.original.end);
    if (end <= start) continue;
    const shift = candidate.modified.start - candidate.original.start;
    return { original: { start, end }, modified: { start: start + shift, end: end + shift } };
  }
  return null;
}

/**
 * Word-level differences inside a block whose sides have the same number of lines, pairing line by line.
 * Blocks with differing line counts get no inner highlights.
 */
export function computeInnerChanges(
  block: ChangeBlock,
  originalLines: string[],
  modifiedLines: string[],
): { original: CharRange[]; modified: CharRange[] } {
  const original: CharRange[] = [];
  const modified: CharRange[] = [];
  if (rangeLength(block.original) !== rangeLength(block.modified)) return { original, modified };

  for (let offset = 0; offset < rangeLength(block.original); offset++) {
    const originalLine = block.original.start + offset;
    const modifiedLine = block.modified.start + offset;
    let originalColumn = 1;
    let modifiedColumn = 1;
    for (const part of diffWordsWithSpace(originalLines[originalLine - 1] ?? "", modifiedLines[modifiedLine - 1] ?? "")) {
      const length = part.value.length;
      if (part.removed) {
        original.push({ line: originalLine, startColumn: originalColumn, endColumn: originalColumn + length });
        originalColumn += length;
      } else if (part.added) {
        modified.push({ line: modifiedLine, startColumn: modifiedColumn, endColumn: modifiedColumn + length });
        modifiedColumn += length;
      } else {
        originalColumn += length;
        modifiedColumn += length;
      }
    }
  }
  return { original, modified };
}

export type Side = "original" | "modified";

/**
 * Maps `line` of `from` to the matching line on the other side. Unchanged lines map one to one; inside a block
 * the position is interpolated, so the result can be fractional (e.g. 12.5 = halfway through line 12).
 */
export function mapLine(blocks: ChangeBlock[], from: Side, line: number): number {
  const to: Side = from === "original" ? "modified" : "original";
  let shift = 0;
  for (const block of blocks) {
    const source = block[from];
    const target = block[to];
    if (line < source.start) break;
    if (line < source.end) {
      const fraction = (line - source.start) / rangeLength(source);
      return target.start + fraction * rangeLength(target);
    }
    shift = target.end - source.end;
  }
  return line + shift;
}

/** Single replacement in Monaco's coordinates: 1-based lines and columns, the end column exclusive. */
export type TextEdit = { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string };

/**
 * Edit on the modified text that makes a block's modified lines equal to its original lines. Pure insertions
 * remove whole lines including one line break; pure deletions re-insert the original lines before `modified.start`.
 * `modifiedLines` are the model's lines, so a trailing line break shows up as a final empty line.
 */
export function computeRevertEdit(originalLines: string[], modifiedLines: string[], block: ChangeBlock, eol: string): TextEdit {
  const lineCount = modifiedLines.length;
  const endColumn = (line: number) => modifiedLines[line - 1].length + 1;
  const originalText = originalLines.slice(block.original.start - 1, block.original.end - 1).join(eol);
  const { start, end } = block.modified;

  if (rangeLength(block.modified) === 0) {
    if (start > lineCount) {
      const column = endColumn(lineCount);
      return { startLine: lineCount, startColumn: column, endLine: lineCount, endColumn: column, text: eol + originalText };
    }
    // A block ending on the original's last line carries no line break after it (the file ends without one).
    const endsWithoutBreak = block.original.end - 1 === originalLines.length;
    return { startLine: start, startColumn: 1, endLine: start, endColumn: 1, text: endsWithoutBreak ? originalText : originalText + eol };
  }
  if (rangeLength(block.original) > 0) {
    return { startLine: start, startColumn: 1, endLine: end - 1, endColumn: endColumn(end - 1), text: originalText };
  }
  if (end <= lineCount) {
    return { startLine: start, startColumn: 1, endLine: end, endColumn: 1, text: "" };
  }
  if (start > 1) {
    return { startLine: start - 1, startColumn: endColumn(start - 1), endLine: end - 1, endColumn: endColumn(end - 1), text: "" };
  }
  return { startLine: 1, startColumn: 1, endLine: end - 1, endColumn: endColumn(end - 1), text: "" };
}
