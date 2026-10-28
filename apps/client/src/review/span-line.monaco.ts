import * as monaco from "monaco-editor";
import type { LineSpan } from "./line-span.value-object";

let spanLineCounter = 0;

/**
 * A 2px vertical line over the editor from the top of a span's first line to the bottom of its last, blue where the
 * comment is posted inline, grey where it becomes a note. It is an overlay widget, so that it also runs across the
 * view zones between the lines (deleted lines, comment cards), which whole-line decorations leave out; it follows
 * scrolling, layout and zone height changes and starts hidden.
 */
export class SpanLine {
  private readonly domNode = document.createElement("div");
  private readonly widget: monaco.editor.IOverlayWidget;
  private readonly disposables: monaco.IDisposable[];
  private span: LineSpan | null = null;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** x of the line's left edge in the editor. */
    private readonly leftOf: (layoutInfo: monaco.editor.EditorLayoutInfo) => number,
    /** Distance the line keeps from the span's top and bottom edges at the given line height. */
    private readonly insetOf: (lineHeight: number) => number = () => 0,
  ) {
    this.domNode.className = "hunt-review-span-line";
    this.domNode.hidden = true;
    const id = `hunt.reviewSpanLine.${spanLineCounter++}`;
    // Monaco does not place a widget without a position; `layout` does.
    this.widget = { getId: () => id, getDomNode: () => this.domNode, getPosition: () => null };
    editor.addOverlayWidget(this.widget);
    this.disposables = [
      editor.onDidScrollChange(() => this.layout()),
      editor.onDidLayoutChange(() => this.layout()),
      editor.onDidContentSizeChange(() => this.layout()),
    ];
  }

  show(span: LineSpan, isInline: boolean): void {
    this.span = span;
    this.domNode.classList.toggle("hunt-review-span-line--note", !isInline);
    this.layout();
  }

  hide(): void {
    this.span = null;
    this.layout();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.editor.removeOverlayWidget(this.widget);
  }

  private layout(): void {
    const span = this.span;
    this.domNode.hidden = !span;
    if (!span) return;
    const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
    const inset = this.insetOf(lineHeight);
    const scrollTop = this.editor.getScrollTop();
    const top = this.editor.getTopForLineNumber(span.startLine) + inset - scrollTop;
    const bottom = this.editor.getTopForLineNumber(span.endLine) + lineHeight - inset - scrollTop;
    this.domNode.style.top = `${top}px`;
    this.domNode.style.height = `${Math.max(0, bottom - top)}px`;
    this.domNode.style.left = `${this.leftOf(this.editor.getLayoutInfo())}px`;
  }
}
