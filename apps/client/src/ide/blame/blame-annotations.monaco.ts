import * as monaco from "monaco-editor";
import { commands } from "../../ipc/commands";
import { errorText } from "../../ui/error-text.utils";
import type { BlameCommit, LineCommits } from "./blame.types";
import { ANNOTATION_WIDTH, annotationOf, blameHover, blameRuns, lineCommits, withEdits } from "./blame.utils";

/** Context key that is true while the shown file is annotated; it decides which of the two menu entries shows. */
const SHOWN_KEY = "huntBlameShown";
const ANNOTATION_CLASS = "hunt-blame";
/** The blame is read again once the text rested this long. */
const RELOAD_DELAY_MS = 400;
const NBSP = " ";

const GUTTER_TARGETS: ReadonlySet<monaco.editor.MouseTargetType> = new Set([
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
]);

/** Monaco's context menu contribution, whose `showContextMenu` its typings leave out. */
type ContextMenuContribution = monaco.editor.IEditorContribution & { showContextMenu: (anchor: monaco.editor.IEditorMouseEvent["event"]) => void };

export type BlameHandlers = {
  /** Session and worktree path of a model, or null for models that are not worktree files. */
  fileOf: (model: monaco.editor.ITextModel) => { sessionId: string; path: string } | null;
  onError: (message: string) => void;
};

/** Monaco writes a custom line number into the gutter as HTML. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, NBSP);
}

/**
 * WebStorm's "Annotate with Git Blame": the context menu, which this class also opens on a right click in the gutter,
 * offers it for the shown file and "Close Annotations" once it is annotated. An annotated file shows the day and the
 * author of each line's commit left of its line number; the hover names the commit and a click reports it. A line no
 * commit holds shows its number only. The blame is of the editor's text, unsaved changes included: an edit clears
 * the lines it touches at once, and the blame is read again shortly after. Which files are annotated is remembered
 * per editor while it lives.
 */
export class BlameAnnotations {
  /** The annotated models with the commits of their lines; null until the first blame arrived. */
  private readonly blames = new WeakMap<monaco.editor.ITextModel, LineCommits | null>();
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly shownKey: monaco.editor.IContextKey<boolean>;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly clickListeners = new Set<(commit: BlameCommit) => void>();
  private readonly plainLineNumbers: monaco.editor.IEditorOptions["lineNumbers"];
  private readonly plainMinChars: number;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private isRendered = false;

  constructor(
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    private readonly handlers: BlameHandlers,
  ) {
    const options = editor.getRawOptions();
    this.plainLineNumbers = options.lineNumbers ?? "on";
    this.plainMinChars = options.lineNumbersMinChars ?? 5;
    this.decorations = editor.createDecorationsCollection();
    this.shownKey = editor.createContextKey(SHOWN_KEY, false);
    this.disposables.push(
      editor.addAction({
        id: "hunt.annotateWithGitBlame",
        label: "Annotate with Git Blame",
        contextMenuGroupId: "z_git",
        precondition: `!${SHOWN_KEY}`,
        run: () => this.annotate(),
      }),
      editor.addAction({
        id: "hunt.closeAnnotations",
        label: "Close Annotations",
        contextMenuGroupId: "z_git",
        precondition: SHOWN_KEY,
        run: () => this.close(),
      }),
      editor.onContextMenu((event) => this.onContextMenu(event)),
      editor.onMouseDown((event) => this.onMouseDown(event)),
      editor.onDidChangeModel(() => {
        this.render();
        this.load();
      }),
      editor.onDidChangeModelContent((event) => this.onDidChangeContent(event)),
    );
  }

  onDidClickCommit(listener: (commit: BlameCommit) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  /** Reads the blame of the shown file again, after its history changed. */
  reload(): void {
    this.load();
  }

  dispose(): void {
    this.cancelReload();
    this.generation += 1;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.decorations.clear();
    this.clickListeners.clear();
  }

  private annotate(): void {
    const model = this.editor.getModel();
    if (!model || !this.handlers.fileOf(model)) return;
    this.blames.set(model, null);
    this.render();
    this.load();
  }

  private close(): void {
    const model = this.editor.getModel();
    if (!model) return;
    this.cancelReload();
    this.generation += 1;
    this.blames.delete(model);
    this.render();
  }

  /** Reads the blame of the shown model's text when the model is annotated. */
  private load(): void {
    this.cancelReload();
    const generation = ++this.generation;
    const model = this.editor.getModel();
    const file = model ? this.handlers.fileOf(model) : null;
    if (!model || !file || !this.blames.has(model)) return;
    const isCurrent = () => generation === this.generation && this.blames.has(model);
    commands.blameFile(file.sessionId, file.path, model.getValue()).then(
      (blame) => {
        if (!isCurrent()) return;
        this.blames.set(model, lineCommits(blame));
        this.render();
      },
      (reason) => {
        if (!isCurrent()) return;
        // A file that never got its blame, as one HEAD does not hold, is not annotated.
        if (!this.blames.get(model)) {
          this.blames.delete(model);
          this.render();
        }
        this.handlers.onError(errorText(reason));
      },
    );
  }

  private scheduleReload(): void {
    this.cancelReload();
    this.reloadTimer = setTimeout(() => this.load(), RELOAD_DELAY_MS);
  }

  private cancelReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private onDidChangeContent(event: monaco.editor.IModelContentChangedEvent): void {
    const model = this.editor.getModel();
    if (!model || !this.blames.has(model)) return;
    const lines = this.blames.get(model);
    if (lines) {
      const edits = event.changes.map((change) => ({
        startLine: change.range.startLineNumber,
        endLine: change.range.endLineNumber,
        insertedLineBreaks: change.text.split("\n").length - 1,
      }));
      this.blames.set(model, withEdits(lines, edits));
      this.render();
    }
    this.scheduleReload();
  }

  /** Shows the annotations of the shown model, or plain line numbers when it has none. */
  private render(): void {
    const model = this.editor.getModel();
    const lines = model ? this.blames.get(model) : undefined;
    this.shownKey.set(lines !== undefined);
    if (!model || !lines) {
      if (this.isRendered) {
        this.isRendered = false;
        this.editor.updateOptions({ lineNumbers: this.plainLineNumbers, lineNumbersMinChars: this.plainMinChars });
        this.decorations.clear();
      }
      return;
    }
    this.isRendered = true;
    const digits = Math.max(this.plainMinChars, String(model.getLineCount()).length);
    this.editor.updateOptions({
      lineNumbers: (line) => {
        const commit = lines[line - 1];
        // The number is padded, so the annotations of all lines start at the same column.
        return commit ? `<span class="${ANNOTATION_CLASS}">${escapeHtml(annotationOf(commit))}</span>${NBSP}${String(line).padStart(digits, NBSP)}` : String(line);
      },
      lineNumbersMinChars: ANNOTATION_WIDTH + 1 + digits,
    });
    this.decorations.set(
      blameRuns(lines).map((run) => ({
        range: new monaco.Range(run.startLine, 1, run.endLine, 1),
        options: { lineNumberHoverMessage: { value: blameHover(run.commit) }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      })),
    );
  }

  /** Monaco opens its context menu on the text only; this opens the same menu for the gutter, where WebStorm offers the annotations. */
  private onContextMenu(event: monaco.editor.IEditorMouseEvent): void {
    if (!GUTTER_TARGETS.has(event.target.type)) return;
    this.editor.focus();
    this.editor.getContribution<ContextMenuContribution>("editor.contrib.contextmenu")?.showContextMenu(event.event);
  }

  /** A click on an annotation reports its commit. */
  private onMouseDown(event: monaco.editor.IEditorMouseEvent): void {
    const { target } = event;
    if (!event.event.leftButton || event.event.ctrlKey || target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || !target.position) return;
    if (!target.element?.closest(`.${ANNOTATION_CLASS}`)) return;
    const model = this.editor.getModel();
    const commit = model ? this.blames.get(model)?.[target.position.lineNumber - 1] : null;
    if (!commit) return;
    for (const listener of this.clickListeners) {
      listener(commit);
    }
  }
}
