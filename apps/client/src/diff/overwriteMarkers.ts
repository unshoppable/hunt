import * as monaco from "monaco-editor";

const GLYPH_CLASS = "hunt-overwrite-glyph";

/** Lines of the own diff that another session overwrote on disk (see `Overwrite` in ownChanges.ts), ready to show. */
export type OverwriteMark = {
  /** 1-based first and last line in the right side. */
  startLine: number;
  endLine: number;
  /** Mark and title of each session that changed the lines afterwards; the one whose change is on disk comes last. */
  owners: { mark: string; title: string }[];
  /** The lines in their place on disk; empty when they were deleted. */
  diskLines: string[];
};

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

/** The hover of a mark: who overwrote the lines and, in a code block in the editor's language, what is on disk now. */
function hoverMessage(overwrite: OverwriteMark): monaco.IMarkdownString {
  const owners = overwrite.owners.map((owner) => `**${escapeMarkdown(owner.mark)}** (${escapeMarkdown(owner.title)})`).join(", then ");
  const isSingle = overwrite.startLine === overwrite.endLine;
  if (!overwrite.diskLines.length) {
    return { value: `${isSingle ? "This line is" : "These lines are"} no longer on disk: deleted afterwards by ${owners}.` };
  }
  const code = overwrite.diskLines.join("\n");
  const longestBackticks = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestBackticks + 1));
  return { value: `${isSingle ? "This line was" : "These lines were"} changed afterwards by ${owners}. On disk now:\n\n${fence}\n${code}\n${fence}` };
}

function glyphWidget(overwrite: OverwriteMark, id: string): monaco.editor.IGlyphMarginWidget {
  const domNode = document.createElement("div");
  domNode.className = GLYPH_CLASS;
  const label = document.createElement("span");
  label.textContent = overwrite.owners[overwrite.owners.length - 1]?.mark ?? "?";
  domNode.append(label);
  const position = {
    lane: monaco.editor.GlyphMarginLane.Center,
    zIndex: 10,
    range: { startLineNumber: overwrite.startLine, startColumn: 1, endLineNumber: overwrite.startLine, endColumn: 1 },
  };
  return { getId: () => id, getDomNode: () => domNode, getPosition: () => position };
}

/**
 * Marks own lines of a read-only diff side that are no longer on disk: the mark of the session whose change is on disk
 * sits in the glyph margin of each run's first line, and hovering it shows the lines on disk now. The mark is a glyph
 * widget that lets the mouse through to a glyph decoration on the same line, which carries the hover.
 */
export class OverwriteMarkers {
  private static nextId = 0;
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly idPrefix = `hunt-overwrite-${OverwriteMarkers.nextId++}`;
  private widgets: monaco.editor.IGlyphMarginWidget[] = [];

  constructor(private readonly editor: monaco.editor.ICodeEditor) {
    this.decorations = editor.createDecorationsCollection();
  }

  set(overwrites: OverwriteMark[]): void {
    this.removeWidgets();
    this.widgets = overwrites.map((overwrite, index) => glyphWidget(overwrite, `${this.idPrefix}-${index}`));
    for (const widget of this.widgets) {
      this.editor.addGlyphMarginWidget(widget);
    }
    this.decorations.set(
      overwrites.map((overwrite) => ({
        range: { startLineNumber: overwrite.startLine, startColumn: 1, endLineNumber: overwrite.startLine, endColumn: 1 },
        options: { glyphMarginClassName: GLYPH_CLASS, glyphMarginHoverMessage: hoverMessage(overwrite) },
      })),
    );
  }

  dispose(): void {
    this.removeWidgets();
    this.decorations.clear();
  }

  private removeWidgets(): void {
    for (const widget of this.widgets) {
      this.editor.removeGlyphMarginWidget(widget);
    }
    this.widgets = [];
  }
}
