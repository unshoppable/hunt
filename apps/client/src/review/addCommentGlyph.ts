import * as monaco from "monaco-editor";
import { selectedLineSpan } from "../diff/selectionContext";
import type { LineSpan } from "./reviewComments";
import { SpanLine } from "./spanLine";

const GLYPH_CLASS = "harness-review-add";
/** Edge length of the "+" square (see `.harness-review-add::before` in index.css). */
const PLUS_SIZE = 18;
export const RANGE_CLASS = "harness-review-range";

/** Mouse targets that name a line of the model (text, its empty tail and the gutter cells), unlike zones and widgets. */
const LINE_TARGETS = new Set<monaco.editor.MouseTargetType>([
  monaco.editor.MouseTargetType.CONTENT_TEXT,
  monaco.editor.MouseTargetType.CONTENT_EMPTY,
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
]);

/** What a click or drag of the "+" asks for: the lines to comment on and the line the comment box opens under. */
export type CommentTarget = {
  span: LineSpan;
  /** Line the "+" was released on; the box opens under it, so a drag upwards opens it at the top of the span. */
  underLine: number;
};

type Drag = {
  /** Line the "+" was pressed on. */
  anchor: number;
  /** Line under the pointer. */
  current: number;
  /** Client x of the press, kept so that the pointer's line is read in the gutter column wherever it moves. */
  clientX: number;
};

/** Whole-line decoration giving the lines `startLine..line` GitHub's yellow tint over gutter and text. */
export function rangeDecoration(span: LineSpan): monaco.editor.IModelDeltaDecoration {
  return {
    range: { startLineNumber: span.startLine, startColumn: 1, endLineNumber: span.line, endColumn: 1 },
    options: { isWholeLine: true, className: RANGE_CLASS, marginClassName: RANGE_CLASS, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
  };
}

/** GitHub's bar at the text's left edge beside the lines `rangeDecoration` tints; `show` it with the span. */
export function rangeBar(editor: monaco.editor.ICodeEditor): SpanLine {
  return new SpanLine(editor, (layoutInfo) => layoutInfo.contentLeft);
}

/**
 * GitHub's "+" on the hovered line of a pull request review, in the glyph margin left of the line numbers: blue
 * where a comment is posted inline (`isInline`), grey where it becomes a note in the review summary. A click reports the line, or the selected lines when the selection spans
 * several and holds the clicked one; dragging the "+" over other lines reports the dragged range, marked while the
 * drag lasts with a "+" at both ends joined by a line in the glyph margin, both running across the view zones between
 * them. The reported target's box opens under the line the "+" was released on.
 */
export class AddCommentGlyph {
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly clickListeners = new Set<(target: CommentTarget) => void>();
  /** Line the "+" is shown on. */
  private shownLine: number | null = null;
  private drag: Drag | null = null;
  /** Bar beside the dragged lines. */
  private readonly bar: SpanLine;
  /** Line in the glyph margin from the bottom of the upper "+" of a drag to the top of the lower one. */
  private readonly link: SpanLine;

  /** The editor's container: unlike `getDomNode()` it exists before the first model is set. */
  private readonly domNode: HTMLElement;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** Worktree path of a model, or null for models the review does not cover (then no "+" shows). */
    private readonly pathOf: (model: monaco.editor.ITextModel) => string | null,
    /** Whether a comment on `span` lies inside a diff hunk and is posted inline. */
    private readonly isInline: (span: LineSpan) => boolean,
  ) {
    this.decorations = editor.createDecorationsCollection();
    this.bar = rangeBar(editor);
    // Runs from below the upper "+" square to above the lower one; each square is centred in its line.
    this.link = new SpanLine(
      editor,
      (layoutInfo) => layoutInfo.glyphMarginLeft + layoutInfo.glyphMarginWidth / 2 - 1,
      (lineHeight) => (lineHeight + Math.min(PLUS_SIZE, lineHeight)) / 2,
    );
    // The press is caught in the capture phase, before Monaco's own listener moves the cursor or starts a selection.
    this.domNode = editor.getContainerDomNode();
    this.domNode.addEventListener("mousedown", this.onDomMouseDown, true);
    this.disposables.push(
      editor.onMouseMove((event) => this.onMouseMove(event)),
      editor.onMouseLeave(() => {
        if (!this.drag) {
          this.show(null);
        }
      }),
      editor.onDidChangeModel(() => {
        this.endDrag();
        this.show(null);
      }),
    );
  }

  onDidClick(listener: (target: CommentTarget) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  /** Recolors the shown "+" after the hunks changed. */
  refresh(): void {
    if (this.drag) {
      this.renderDrag();
      return;
    }
    const line = this.shownLine;
    this.shownLine = null;
    this.show(line);
  }

  dispose(): void {
    this.endDrag();
    this.domNode.removeEventListener("mousedown", this.onDomMouseDown, true);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.bar.dispose();
    this.link.dispose();
    this.decorations.clear();
    this.clickListeners.clear();
  }

  private onMouseMove(event: monaco.editor.IEditorMouseEvent): void {
    if (this.drag) return;
    const { target } = event;
    // Over the "+" itself (its box overhangs the text, where Monaco names no line) the shown "+" stays.
    if (target.element?.closest(`.${GLYPH_CLASS}`)) return;
    const line = LINE_TARGETS.has(target.type) && target.position ? target.position.lineNumber : null;
    this.show(line);
  }

  private show(line: number | null): void {
    const model = this.editor.getModel();
    const isCovered = line !== null && model !== null && this.pathOf(model) !== null;
    const shownLine = isCovered ? line : null;
    if (shownLine === this.shownLine) return;
    this.shownLine = shownLine;
    if (shownLine === null) {
      this.decorations.clear();
      return;
    }
    this.decorations.set([this.glyphDecoration(shownLine, this.isInline({ startLine: shownLine, line: shownLine }))]);
  }

  private glyphDecoration(line: number, isInline: boolean): monaco.editor.IModelDeltaDecoration {
    return {
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: {
        glyphMarginClassName: isInline ? GLYPH_CLASS : `${GLYPH_CLASS} ${GLYPH_CLASS}--note`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  }

  private readonly onDomMouseDown = (event: MouseEvent): void => {
    const line = this.shownLine;
    if (event.button !== 0 || line === null || !(event.target instanceof Element) || !event.target.closest(`.${GLYPH_CLASS}`)) return;
    event.preventDefault();
    event.stopPropagation();
    this.drag = { anchor: line, current: line, clientX: event.clientX };
    window.addEventListener("mousemove", this.onWindowMouseMove, true);
    window.addEventListener("mouseup", this.onWindowMouseUp, true);
    window.addEventListener("keydown", this.onWindowKeyDown, true);
  };

  private readonly onWindowMouseMove = (event: MouseEvent): void => {
    if (!this.drag) return;
    this.scrollTowards(event.clientY);
    const target = this.editor.getTargetAtClientPoint(this.drag.clientX, event.clientY);
    if (!target?.position || target.position.lineNumber === this.drag.current) return;
    this.drag.current = target.position.lineNumber;
    this.renderDrag();
  };

  private readonly onWindowMouseUp = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.endDrag();
    const span = drag.anchor === drag.current ? this.spanAt(drag.anchor) : { startLine: Math.min(drag.anchor, drag.current), line: Math.max(drag.anchor, drag.current) };
    this.show(drag.current);
    for (const listener of this.clickListeners) {
      listener({ span, underLine: drag.current });
    }
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    this.endDrag();
  };

  /** Scrolls one line per move while the pointer is above or below the editor, so a drag can reach lines out of view. */
  private scrollTowards(clientY: number): void {
    const { top, bottom } = this.editor.getDomNode()?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
    const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
    if (clientY < top) {
      this.editor.setScrollTop(this.editor.getScrollTop() - lineHeight);
    } else if (clientY > bottom) {
      this.editor.setScrollTop(this.editor.getScrollTop() + lineHeight);
    }
  }

  private renderDrag(): void {
    if (!this.drag) return;
    const { anchor, current } = this.drag;
    const span = { startLine: Math.min(anchor, current), line: Math.max(anchor, current) };
    const isInline = this.isInline(span);
    const glyphs = anchor === current ? [this.glyphDecoration(anchor, isInline)] : [this.glyphDecoration(anchor, isInline), this.glyphDecoration(current, isInline)];
    this.decorations.set([rangeDecoration(span), ...glyphs]);
    this.bar.show(span, isInline);
    if (anchor === current) {
      this.link.hide();
    } else {
      this.link.show(span, isInline);
    }
  }

  /** Stops a running drag without reporting it; the hover glyph is restored on the next mouse move. */
  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.bar.hide();
    this.link.hide();
    window.removeEventListener("mousemove", this.onWindowMouseMove, true);
    window.removeEventListener("mouseup", this.onWindowMouseUp, true);
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    this.shownLine = null;
    this.decorations.clear();
  }

  /** The selected lines when the selection spans several and holds `line`, otherwise `line` alone. */
  private spanAt(line: number): LineSpan {
    const selection = this.editor.getSelection();
    if (!selection || selection.isEmpty()) return { startLine: line, line };
    const { startLine, endLine } = selectedLineSpan(selection);
    if (endLine <= startLine || line < startLine || line > endLine) return { startLine: line, line };
    return { startLine, line: endLine };
  }
}
