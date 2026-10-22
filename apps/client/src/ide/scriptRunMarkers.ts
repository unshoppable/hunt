import * as monaco from "monaco-editor";
import { packageScriptLines, type PackageScriptLine } from "./packageScripts";

const GLYPH_CLASS = "hunt-script-run";
const RESCAN_DELAY_MS = 120;

/** A script a run glyph was clicked for, with the worktree path of its package.json. */
export type ScriptRunClick = {
  path: string;
  script: string;
};

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

function toDecoration(scriptLine: PackageScriptLine): monaco.editor.IModelDeltaDecoration {
  return {
    range: { startLineNumber: scriptLine.line, startColumn: 1, endLineNumber: scriptLine.line, endColumn: 1 },
    options: {
      glyphMarginClassName: GLYPH_CLASS,
      glyphMarginHoverMessage: { value: `Run 'npm run ${escapeMarkdown(scriptLine.script)}'` },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/**
 * WebStorm's green run triangles in the glyph margin of a package.json: one on the line of every key of its top-level
 * `"scripts"` object (see packageScripts.ts), rescanned shortly after every edit and whenever the shown model changes.
 * A click on a triangle reports the script; the scan at the click reads the model as it is then.
 */
export class ScriptRunMarkers {
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly clickListeners = new Set<(click: ScriptRunClick) => void>();
  private contentSubscription: monaco.IDisposable | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Worktree path of the shown package.json, or null while the shown model gets no triangles. */
  private path: string | null = null;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** Worktree path of a model that gets run triangles, or null for every other model. */
    private readonly packageJsonPathOf: (model: monaco.editor.ITextModel) => string | null,
  ) {
    this.decorations = editor.createDecorationsCollection();
    this.disposables.push(
      editor.onDidChangeModel(() => this.trackModel()),
      editor.onMouseDown((event) => this.onMouseDown(event)),
    );
    this.trackModel();
  }

  onDidClickScript(listener: (click: ScriptRunClick) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  /** Asks `packageJsonPathOf` again for the shown model, after something it depends on changed. */
  refresh(): void {
    this.trackModel();
  }

  dispose(): void {
    this.cancelRescan();
    this.contentSubscription?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.decorations.clear();
    this.clickListeners.clear();
  }

  private trackModel(): void {
    this.cancelRescan();
    this.contentSubscription?.dispose();
    this.contentSubscription = null;
    const model = this.editor.getModel();
    this.path = model ? this.packageJsonPathOf(model) : null;
    if (!model || !this.path) {
      this.decorations.clear();
      return;
    }
    this.contentSubscription = model.onDidChangeContent(() => this.scheduleRescan());
    this.rescan();
  }

  private scheduleRescan(): void {
    this.cancelRescan();
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan();
    }, RESCAN_DELAY_MS);
  }

  private cancelRescan(): void {
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
  }

  private rescan(): void {
    const model = this.editor.getModel();
    if (!model || !this.path) return;
    this.decorations.set(packageScriptLines(model.getValue()).map(toDecoration));
  }

  private onMouseDown(event: monaco.editor.IEditorMouseEvent): void {
    const { target } = event;
    if (!event.event.leftButton || event.event.ctrlKey || target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !target.position) return;
    const model = this.editor.getModel();
    const path = this.path;
    if (!model || !path) return;
    const line = target.position.lineNumber;
    const scriptLine = packageScriptLines(model.getValue()).find((candidate) => candidate.line === line);
    if (!scriptLine) return;
    for (const listener of this.clickListeners) {
      listener({ path, script: scriptLine.script });
    }
  }
}
