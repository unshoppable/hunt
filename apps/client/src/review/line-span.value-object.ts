import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import type { ChangeBlock } from "../editor/line-diff.utils";

/** Lines of unchanged context git puts around every change; the diff of a pull request on GitHub has the same. */
export const HUNK_CONTEXT_LINES = 3;

/** Whether the lines name the whole file (both 0) or 1-based lines `startLine..endLine`. */
function isLineSpan(lines: { startLine: number; endLine: number }): boolean {
  if (lines.startLine === 0) return lines.endLine === 0;
  return lines.startLine <= lines.endLine;
}

const ZodLineSpanState = z
  .object({
    /** First line, 1-based; 0 for the whole file. */
    startLine: z.int().check(z.minimum(0)),
    /** Last line, inclusive; 0 for the whole file. */
    endLine: z.int().check(z.minimum(0)),
  })
  .check(z.refine(isLineSpan, "a line span is the whole file (both lines 0) or 1-based lines with startLine ≤ endLine"));

export interface LineSpan extends z.infer<typeof ZodLineSpanState> {}

/**
 * Lines `startLine..endLine` of the new version of a file that a review comment is about, or the whole file
 * (`LineSpan.FILE`); a single line has `startLine === endLine`. The wire types name the last line `line`, as GitHub does.
 */
export class LineSpan extends ValueObject<typeof ZodLineSpanState> {
  static readonly schema = ZodLineSpanState;

  /** The span of a comment on the whole file rather than on lines of it; its card sits above the first line. */
  static readonly FILE = new LineSpan({ startLine: 0, endLine: 0 });

  constructor(value: z.input<typeof ZodLineSpanState>) {
    super(value);
  }

  static of(startLine: number, endLine: number): LineSpan {
    return new LineSpan({ startLine, endLine });
  }

  /** The span of a review comment's or thread's lines, whose `line` is the last one. */
  static ofComment(lines: { startLine: number; line: number }): LineSpan {
    return new LineSpan({ startLine: lines.startLine, endLine: lines.line });
  }

  /** `spans` sorted by their first line, overlapping ones merged, so that a line lies in at most one span. */
  static merge(spans: readonly LineSpan[]): LineSpan[] {
    const merged: LineSpan[] = [];
    for (const span of [...spans].sort((left, right) => left.startLine - right.startLine)) {
      const last = merged[merged.length - 1];
      if (last && span.startLine <= last.endLine) {
        merged[merged.length - 1] = LineSpan.of(last.startLine, Math.max(last.endLine, span.endLine));
      } else {
        merged.push(span);
      }
    }
    return merged;
  }

  /** Whether `line`, the last line of a comment or thread as the wire types carry it, stands for the whole file. */
  static isFileLine(line: number): boolean {
    return line === 0;
  }

  /** Whether the span stands for the whole file. */
  get isFile(): boolean {
    return LineSpan.isFileLine(this.endLine);
  }

  /** `File`, `L5` or `L5–L9`, as the cards name a comment's lines. */
  get label(): string {
    if (this.isFile) return "File";
    return this.startLine === this.endLine ? `L${this.endLine}` : `L${this.startLine}–L${this.endLine}`;
  }

  /**
   * Whether the lines lie inside one hunk of the diff `blocks` describe, i.e. whether GitHub takes an inline comment
   * there: a hunk is a block's modified lines plus `context` lines on either side (a deletion contributes its context
   * around the line it sits before). The backend applies the same rule to git's hunks.
   */
  isInsideHunk(blocks: readonly ChangeBlock[], context = HUNK_CONTEXT_LINES): boolean {
    return blocks.some((block) => {
      const first = block.modified.start - context;
      const last = block.modified.end - 1 + context;
      return this.startLine >= first && this.endLine <= last;
    });
  }

  /**
   * Whether a comment on the span is posted on the pull request's diff: a file comment when the file has changes, a
   * line comment when its lines lie inside one hunk (see `isInsideHunk`). Every other comment becomes a note in the
   * review summary; the backend decides the same way.
   */
  isPostedOnDiff(blocks: readonly ChangeBlock[]): boolean {
    return this.isFile ? blocks.length > 0 : this.isInsideHunk(blocks);
  }
}
