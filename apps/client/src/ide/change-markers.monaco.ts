import * as monaco from "monaco-editor";
import { computeChangeBlocks, computeRevertEdit, type ChangeBlock } from "../editor/line-diff.utils";
import { changeMark } from "../editor/monaco.constants";
import { markersFor, type Marker } from "./marker-layout.utils";

export type { Marker, MarkerKind } from "./marker-layout.utils";

const REDIFF_DELAY_MS = 120;
/** Width of the clickable stripe at the left edge of the line decorations area, in pixels. */
const STRIPE_HIT_WIDTH = 10;

/**
 * One decoration per line of the marker: Monaco renders a line decoration per line, so the first and last line
 * carry `--start` / `--end` for the rounded ends of a stripe while the lines between join seamlessly; a hovered marker
 * carries `--hover` on every line, which widens its stripe.
 */
function toDecorations(marker: Marker, isHovered: boolean): monaco.editor.IModelDeltaDecoration[] {
  const edge = marker.edge ? ` hunt-change--${marker.edge}` : "";
  const hover = isHovered ? " hunt-change--hover" : "";
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  for (let line = marker.startLine; line <= marker.endLine; line++) {
    const start = line === marker.startLine ? " hunt-change--start" : "";
    const end = line === marker.endLine ? " hunt-change--end" : "";
    decorations.push({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { linesDecorationsClassName: `hunt-change hunt-change--${marker.kind}${edge}${hover}${start}${end}`, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    });
  }
  return decorations;
}

/**
 * WebStorm-style change stripes next to the line numbers of an editor, each repeated as a mark in the scroll track
 * (see `changeMark`): the editor's model is diffed against the file's HEAD content (`headTextOf`), recomputed shortly
 * after every edit and whenever the shown model changes. The stripe under the mouse widens, a click on it reports its
 * marker; `revert` puts a block back to its HEAD lines.
 */
export class ChangeMarkers {
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: monaco.IDisposable[] = [];
  private contentSubscription: monaco.IDisposable | null = null;
  private rediffTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changeListeners = new Set<() => void>();
  private readonly clickListeners = new Set<(marker: Marker) => void>();
  /** Bumped per model load so a late HEAD response of an earlier model is ignored. */
  private generation = 0;
  private headText: string | null = null;
  /** Whether the base content of the current model has arrived (as text or as "not in the base"). */
  private isHeadLoaded = false;
  private currentBlocks: ChangeBlock[] = [];
  private currentMarkers: Marker[] = [];
  /** Marker whose stripe is under the mouse. */
  private hoveredMarker: Marker | null = null;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** Base content of the model's file, empty for a file the changes add, or null for a file outside the changes (then nothing is marked). */
    private readonly headTextOf: (model: monaco.editor.ITextModel) => Promise<string | null>,
  ) {
    this.decorations = editor.createDecorationsCollection();
    this.disposables.push(
      editor.onDidChangeModel(() => this.trackModel()),
      editor.onMouseDown((event) => this.onMouseDown(event)),
      editor.onMouseMove((event) => this.hover(this.markerUnder(event.target))),
      editor.onMouseLeave(() => this.hover(null)),
    );
    this.trackModel();
  }

  get markers(): Marker[] {
    return this.currentMarkers;
  }

  /** Change blocks of the model against the base content; a file the changes add is one block holding all its lines. */
  get blocks(): ChangeBlock[] {
    return this.currentBlocks;
  }

  /** Lines of the HEAD content the markers are relative to; empty while nothing is loaded. */
  get headLines(): string[] {
    return this.headText === null ? [] : this.headText.split(/\r?\n/);
  }

  /** Fires after the markers were recomputed. */
  onDidChange(listener: () => void): monaco.IDisposable {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  onDidClickMarker(listener: (marker: Marker) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  /** Fetches the HEAD content again (after a commit or revert on disk) and recomputes the markers. */
  reload(): void {
    this.trackModel();
  }

  /** Replaces the block's lines with its HEAD lines as one undoable edit. */
  revert(block: ChangeBlock): void {
    const model = this.editor.getModel();
    if (!model || this.headText === null) return;
    const edit = computeRevertEdit(this.headLines, model.getLinesContent(), block, model.getEOL());
    const range = new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn);
    this.editor.pushUndoStop();
    this.editor.executeEdits("hunt-change-revert", [{ range, text: edit.text }]);
    this.editor.pushUndoStop();
    this.editor.setPosition({ lineNumber: edit.startLine, column: edit.startColumn });
    this.editor.focus();
  }

  dispose(): void {
    this.generation += 1;
    this.cancelRediff();
    this.contentSubscription?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.decorations.clear();
    this.changeListeners.clear();
    this.clickListeners.clear();
  }

  private trackModel(): void {
    this.generation += 1;
    const generation = this.generation;
    this.cancelRediff();
    this.contentSubscription?.dispose();
    this.contentSubscription = null;
    this.headText = null;
    this.isHeadLoaded = false;
    this.applyDiff();

    const model = this.editor.getModel();
    if (!model) return;
    this.contentSubscription = model.onDidChangeContent(() => this.scheduleRediff());
    this.headTextOf(model)
      .then((text) => {
        if (generation !== this.generation) return;
        this.headText = text;
        this.isHeadLoaded = true;
        this.applyDiff();
      })
      .catch(() => {});
  }

  private scheduleRediff(): void {
    this.cancelRediff();
    this.rediffTimer = setTimeout(() => {
      this.rediffTimer = null;
      this.applyDiff();
    }, REDIFF_DELAY_MS);
  }

  private cancelRediff(): void {
    if (this.rediffTimer) {
      clearTimeout(this.rediffTimer);
      this.rediffTimer = null;
    }
  }

  private applyDiff(): void {
    const model = this.editor.getModel();
    this.hoveredMarker = null;
    if (!model || !this.isHeadLoaded || this.headText === null) {
      this.currentBlocks = [];
      this.currentMarkers = [];
      this.decorations.clear();
    } else {
      this.currentBlocks = computeChangeBlocks(this.headText, model.getValue());
      this.currentMarkers = markersFor(this.currentBlocks, model.getLineCount());
      this.render();
    }
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private render(): void {
    this.decorations.set([
      ...this.currentMarkers.flatMap((marker) => toDecorations(marker, marker === this.hoveredMarker)),
      ...this.currentMarkers.map((marker) => changeMark(marker.startLine, marker.endLine)),
    ]);
  }

  private hover(marker: Marker | null): void {
    if (marker === this.hoveredMarker) return;
    this.hoveredMarker = marker;
    this.render();
  }

  /** A click on the stripe reports its marker. */
  private onMouseDown(event: monaco.editor.IEditorMouseEvent): void {
    const marker = this.markerUnder(event.target);
    if (!marker) return;
    for (const listener of this.clickListeners) {
      listener(marker);
    }
  }

  /** Marker of the stripe (the left edge of the line decorations area) at `target`, or null outside every stripe. */
  private markerUnder(target: monaco.editor.IMouseTarget): Marker | null {
    if (target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !target.position) return null;
    const stripeLeft = target.detail.glyphMarginWidth + target.detail.lineNumbersWidth;
    if (target.detail.offsetX < stripeLeft || target.detail.offsetX > stripeLeft + STRIPE_HIT_WIDTH) return null;
    const line = target.position.lineNumber;
    return this.currentMarkers.find((candidate) => candidate.startLine <= line && line <= candidate.endLine) ?? null;
  }
}
