import * as monaco from "monaco-editor";
import {
  clipUnchangedRegion,
  computeChangeBlocks,
  computeInnerChanges,
  computeRevertEdit,
  computeUnchangedRegions,
  mapLine,
  rangeLength,
  type ChangeBlock,
  type CharRange,
  type LineRange,
  type Side,
  type UnchangedRegion,
} from "../editor/line-diff.utils";
import { COMPLETION_OPTIONS, EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, SCROLL_TRACK_OPTIONS, changeMark } from "../editor/monaco.constants";
import { borrowImportRoles } from "../editor/semantic-tokens.monaco";
import { DEFAULT_SPLIT_DIFF_SHARE, clampSplitDiffShare } from "../settings/settings.store";
import { trackPointerDrag } from "../ui/pointer-drag.utils";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRADIENT_ID = "hunt-diff-change";
const DELETE_COLOR = "#55302f";
const INSERT_COLOR = "#2b4a32";
const CONTEXT_LINES = 3;
const MINIMUM_HIDDEN_LINES = 3;
const REDIFF_DELAY_MS = 120;
const REVERT_ARROW_SIZE = 16;
const ORIGINAL_LEFT_PADDING = 16;
const FOLD_GLYPH_CLASS = "split-diff__fold";
const REVERT_CLASS = "split-diff__revert";
const GUTTER_DRAGGING_CLASS = "split-diff__gutter--dragging";

/** Monaco keeps `setHiddenAreas` out of the public typings although every code editor implements it. */
type EditorWithHiddenAreas = monaco.editor.IStandaloneCodeEditor & { setHiddenAreas(ranges: monaco.IRange[]): void };

/**
 * With `readOnly`, the modified side cannot be edited and the gutter has no revert arrows. With `collapseUnchanged`,
 * unchanged stretches start collapsed instead of expanded. With `modifiedModel` (a worktree document shared with other
 * editors), the modified side shows that model instead of one made from `modified`; it is never disposed here, and new
 * texts replace its content as an undoable edit. `originalShare` is the share of the width the original side takes
 * (both sides equal by default); dragging the gutter changes it and reports the new share to `onOriginalShareChange`.
 */
export type SplitDiffOptions = {
  original: string;
  modified: string;
  modifiedModel?: monaco.editor.ITextModel;
  language: string;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  readOnly?: boolean;
  collapseUnchanged?: boolean;
  originalShare?: number;
  onOriginalShareChange?: (share: number) => void;
};

const SHARED_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  ...EDITOR_APPEARANCE_OPTIONS,
  theme: MONACO_THEME,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  folding: false,
  glyphMargin: false,
  automaticLayout: true,
  renderLineHighlight: "line",
  scrollbar: { alwaysConsumeMouseWheel: false },
  links: false,
  stickyScroll: { enabled: false },
  // Dragging always selects; moving selected text by drag would fight with selecting for the sub chat.
  dragAndDrop: false,
  // Monaco's translate3d hints put the gutter and text area into their own compositing layers. On macOS WebKit such
  // layers can skip color matching to the display profile, so the editor background (and the line-number column next
  // to it) shows lighter than the page on a non-sRGB display. The hints are only a scrolling optimisation.
  disableLayerHinting: true,
};

/**
 * WebStorm-style side-by-side diff: the read-only original on the left, its line numbers on the right edge next
 * to the connector gutter, the editable modified text on the right. Lines are never padded to align the sides;
 * instead both editors scroll in step through the change blocks and the connectors bend between them.
 * Unchanged stretches can collapse into a "hidden lines" bar that expands on click; an expanded stretch has a fold
 * glyph on its first modified line that collapses it again. The gutter drags to resize the sides against each other;
 * a double click on it makes them equal again.
 */
export class SplitDiffController {
  readonly original: EditorWithHiddenAreas;
  readonly modified: EditorWithHiddenAreas;

  private readonly originalModel: monaco.editor.ITextModel;
  private readonly modifiedModel: monaco.editor.ITextModel;
  private readonly elements: HTMLElement[];
  private readonly originalElement: HTMLElement;
  private readonly modifiedElement: HTMLElement;
  private readonly numbersElement: HTMLElement;
  private readonly gutterElement: HTMLElement;
  private readonly onOriginalShareChange: ((share: number) => void) | undefined;
  private readonly shapes: SVGGElement;
  private readonly revertLayer: HTMLElement;
  private readonly originalDecorations: monaco.editor.IEditorDecorationsCollection;
  private readonly modifiedDecorations: monaco.editor.IEditorDecorationsCollection;
  private readonly foldDecorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: monaco.IDisposable[] = [];
  /** Hidden-lines bar zones per side, keyed by zone id, so a click on a bar can find its region. */
  private zoneRegions: Record<Side, Map<string, UnchangedRegion>> = { original: new Map(), modified: new Map() };
  private blocks: ChangeBlock[] = [];
  /** Collapsed unchanged stretches, each behind a hidden-lines bar. */
  private hiddenRegions: UnchangedRegion[] = [];
  /** Expanded unchanged stretches, each with a fold glyph. */
  private shownRegions: UnchangedRegion[] = [];
  private isCollapsingUnchanged: boolean;
  private frame = 0;
  private rediffTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncingScroll = false;
  private readonly isReadOnly: boolean;
  private readonly ownsModifiedModel: boolean;

  constructor(root: HTMLElement, options: SplitDiffOptions) {
    this.isReadOnly = !!options.readOnly;
    this.ownsModifiedModel = !options.modifiedModel;
    this.isCollapsingUnchanged = !!options.collapseUnchanged;
    this.onOriginalShareChange = options.onOriginalShareChange;
    const originalElement = createElement("div", "split-diff__editor");
    this.originalElement = originalElement;
    this.numbersElement = createElement("div", "split-diff__numbers");
    this.gutterElement = createElement("div", "split-diff__gutter");
    const modifiedElement = createElement("div", "split-diff__editor");
    this.modifiedElement = modifiedElement;
    this.elements = [originalElement, this.numbersElement, this.gutterElement, modifiedElement];
    root.append(...this.elements);
    this.setOriginalShare(options.originalShare ?? DEFAULT_SPLIT_DIFF_SHARE);
    this.gutterElement.addEventListener("pointerdown", (event) => this.onGutterPointerDown(event));
    this.gutterElement.addEventListener("dblclick", (event) => this.onGutterDoubleClick(event));

    this.originalModel = monaco.editor.createModel(options.original, options.language);
    this.modifiedModel = options.modifiedModel ?? monaco.editor.createModel(options.modified, options.language);
    borrowImportRoles(this.originalModel, this.modifiedModel);
    this.original = monaco.editor.create(originalElement, {
      ...SHARED_EDITOR_OPTIONS,
      model: this.originalModel,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      fontFamily: options.fontFamily,
      readOnly: true,
      domReadOnly: true,
      lineNumbers: "off",
      renderLineHighlight: "none",
      // No line numbers on this side; the decorations column only keeps the text off the pane edge.
      lineDecorationsWidth: ORIGINAL_LEFT_PADDING,
      lineNumbersMinChars: 0,
      scrollbar: { ...SHARED_EDITOR_OPTIONS.scrollbar, vertical: "hidden" },
    }) as EditorWithHiddenAreas;
    this.modified = monaco.editor.create(modifiedElement, {
      ...SHARED_EDITOR_OPTIONS,
      ...SCROLL_TRACK_OPTIONS,
      model: this.modifiedModel,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight,
      fontFamily: options.fontFamily,
      ...COMPLETION_OPTIONS,
      readOnly: this.isReadOnly,
      domReadOnly: this.isReadOnly,
      lineDecorationsWidth: 10,
      glyphMargin: true,
      lineNumbersMinChars: 2,
    }) as EditorWithHiddenAreas;
    this.originalDecorations = this.original.createDecorationsCollection();
    this.modifiedDecorations = this.modified.createDecorationsCollection();
    this.foldDecorations = this.modified.createDecorationsCollection();

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "split-diff__connectors");
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.innerHTML = `<linearGradient id="${GRADIENT_ID}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${DELETE_COLOR}"/><stop offset="1" stop-color="${INSERT_COLOR}"/></linearGradient>`;
    this.shapes = document.createElementNS(SVG_NS, "g");
    svg.append(defs, this.shapes);
    this.revertLayer = createElement("div", "split-diff__reverts");
    this.gutterElement.append(svg, this.revertLayer);

    this.disposables.push(
      this.original.onDidScrollChange((event) => this.onScroll("original", event)),
      this.modified.onDidScrollChange((event) => this.onScroll("modified", event)),
      this.original.onDidLayoutChange(() => this.scheduleRedraw()),
      this.modified.onDidLayoutChange(() => this.scheduleRedraw()),
      this.original.onDidChangeHiddenAreas(() => this.scheduleRedraw()),
      this.modified.onDidChangeHiddenAreas(() => this.scheduleRedraw()),
      this.original.onMouseDown((event) => this.onMouseDown("original", event)),
      this.modified.onMouseDown((event) => this.onMouseDown("modified", event)),
      this.modified.onMouseUp((event) => this.onMouseUp(event)),
      this.modifiedModel.onDidChangeContent(() => this.scheduleRediff()),
    );

    this.applyDiff(true);
  }

  /**
   * Renders both editors, the line numbers and the connectors now instead of at the next animation frame. A window
   * that is still hidden gets no animation frames (see diff/DiffWindow.tsx); rendering before it shows itself
   * keeps the content from popping in after the window is already visible.
   */
  renderNow(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.original.render(true);
    this.modified.render(true);
    this.drawNumbers();
    this.drawConnectors();
  }

  /** Replaces the texts (e.g. after a reload from disk) and recomputes everything including the hidden regions. */
  setContents(original: string, modified: string): void {
    let hasChanged = false;
    if (this.originalModel.getValue() !== original) {
      this.originalModel.setValue(original);
      hasChanged = true;
    }
    if (this.modifiedModel.getValue() !== modified) {
      if (this.ownsModifiedModel) {
        this.modifiedModel.setValue(modified);
      } else {
        this.modifiedModel.pushEditOperations([], [{ range: this.modifiedModel.getFullModelRange(), text: modified }], () => null);
      }
      hasChanged = true;
    }
    if (hasChanged) {
      this.cancelRediff();
      this.applyDiff(true);
    }
  }

  /** Collapses every unchanged stretch or expands them all; stretches toggled one by one follow suit. */
  setCollapseUnchanged(isCollapsed: boolean): void {
    if (isCollapsed === this.isCollapsingUnchanged) return;
    this.isCollapsingUnchanged = isCollapsed;
    this.resetRegions();
    this.applyHiddenRegions();
    this.scheduleRedraw();
  }

  /** Gives the original side `share` of the width the two sides have together; Monaco's automatic layout follows. */
  setOriginalShare(share: number): void {
    const clamped = clampSplitDiffShare(share);
    this.originalElement.style.flexGrow = String(clamped);
    this.modifiedElement.style.flexGrow = String(1 - clamped);
  }

  /** `lineHeight` is a multiple of the font size (Monaco treats values below 8 as a factor). */
  setTextMetrics(fontSize: number, lineHeight: number, fontFamily: string): void {
    this.original.updateOptions({ fontSize, lineHeight, fontFamily });
    this.modified.updateOptions({ fontSize, lineHeight, fontFamily });
    this.scheduleRedraw();
  }

  dispose(): void {
    this.cancelRediff();
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.original.dispose();
    this.modified.dispose();
    this.originalModel.dispose();
    if (this.ownsModifiedModel) {
      this.modifiedModel.dispose();
    }
    for (const element of this.elements) {
      element.remove();
    }
  }

  private scheduleRediff(): void {
    this.cancelRediff();
    this.rediffTimer = setTimeout(() => {
      this.rediffTimer = null;
      this.applyDiff(false);
    }, REDIFF_DELAY_MS);
  }

  private cancelRediff(): void {
    if (this.rediffTimer) {
      clearTimeout(this.rediffTimer);
      this.rediffTimer = null;
    }
  }

  /** Recomputes the blocks; `resetRegions` finds the unchanged stretches afresh, otherwise existing ones only shrink. */
  private applyDiff(resetRegions: boolean): void {
    const originalLines = this.originalModel.getLinesContent();
    const modifiedLines = this.modifiedModel.getLinesContent();
    this.blocks = computeChangeBlocks(this.originalModel.getValue(), this.modifiedModel.getValue());

    if (resetRegions) {
      this.resetRegions();
    } else {
      const clip = (regions: UnchangedRegion[]) =>
        regions
          .map((region) => clipUnchangedRegion(region, this.blocks, originalLines.length, modifiedLines.length, CONTEXT_LINES))
          .filter((region): region is UnchangedRegion => region !== null);
      this.hiddenRegions = clip(this.hiddenRegions);
      this.shownRegions = clip(this.shownRegions);
    }

    this.applyDecorations(originalLines, modifiedLines);
    this.applyHiddenRegions();
    this.scheduleRedraw();
  }

  private applyDecorations(originalLines: string[], modifiedLines: string[]): void {
    const original: monaco.editor.IModelDeltaDecoration[] = [];
    const modified: monaco.editor.IModelDeltaDecoration[] = [];
    for (const block of this.blocks) {
      if (rangeLength(block.original) > 0) {
        original.push(lineDecoration(block.original, "split-diff-line-delete", "split-diff-margin-delete"));
      }
      if (rangeLength(block.modified) > 0) {
        modified.push(lineDecoration(block.modified, "split-diff-line-insert", "split-diff-margin-insert"));
        modified.push(changeMark(block.modified.start, block.modified.end - 1));
      } else {
        // A deletion is marked on the line above its seam.
        const line = Math.max(1, block.modified.start - 1);
        modified.push(changeMark(line, line));
      }
      const inner = computeInnerChanges(block, originalLines, modifiedLines);
      original.push(...inner.original.map((range) => charDecoration(range, "split-diff-char-delete")));
      modified.push(...inner.modified.map((range) => charDecoration(range, "split-diff-char-insert")));
    }
    this.originalDecorations.set(original);
    this.modifiedDecorations.set(modified);
  }

  /** Splits the unchanged stretches of the current blocks into collapsed and expanded ones by `isCollapsingUnchanged`. */
  private resetRegions(): void {
    const regions = computeUnchangedRegions(this.blocks, this.originalModel.getLineCount(), this.modifiedModel.getLineCount(), CONTEXT_LINES, MINIMUM_HIDDEN_LINES);
    this.hiddenRegions = this.isCollapsingUnchanged ? regions : [];
    this.shownRegions = this.isCollapsingUnchanged ? [] : regions;
  }

  /** Hides the collapsed stretches behind their bars on both sides and puts a fold glyph on each expanded one. */
  private applyHiddenRegions(): void {
    this.foldDecorations.set(
      this.shownRegions.map((region) => ({
        range: toRange({ start: region.modified.start, end: region.modified.start + 1 }),
        options: { glyphMarginClassName: `${FOLD_GLYPH_CLASS} codicon codicon-fold`, glyphMarginHoverMessage: { value: "Collapse unchanged lines" } },
      })),
    );
    for (const side of ["original", "modified"] as const) {
      const editor = side === "original" ? this.original : this.modified;
      editor.setHiddenAreas(this.hiddenRegions.map((region) => toRange(region[side])));
      editor.changeViewZones((accessor) => {
        for (const id of this.zoneRegions[side].keys()) {
          accessor.removeZone(id);
        }
        this.zoneRegions[side] = new Map(
          this.hiddenRegions.map((region) => [
            accessor.addZone({
              afterLineNumber: region[side].start - 1,
              heightInPx: editor.getOption(monaco.editor.EditorOption.lineHeight),
              domNode: createHiddenBar(region),
              // Monaco collapses a zone whose following line is hidden; the bar stands in for exactly those lines.
              showInHiddenAreas: true,
            }),
            region,
          ]),
        );
      });
    }
  }

  /** The editor's lines layer covers view zones, so a click on a hidden-lines bar arrives as a view-zone mouse target. */
  private onMouseDown(side: Side, event: monaco.editor.IEditorMouseEvent): void {
    const { target } = event;
    if (target.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE && target.type !== monaco.editor.MouseTargetType.GUTTER_VIEW_ZONE) return;
    const region = this.zoneRegions[side].get(target.detail.viewZoneId);
    if (!region) return;
    this.hiddenRegions = this.hiddenRegions.filter((candidate) => candidate !== region);
    this.shownRegions = sortRegions([...this.shownRegions, region]);
    this.applyHiddenRegions();
    this.scheduleRedraw();
  }

  /** A click on an expanded stretch's fold glyph collapses it; on mouse up, as the mouse down already moved the caret. */
  private onMouseUp(event: monaco.editor.IEditorMouseEvent): void {
    const { target } = event;
    if (event.event.rightButton || target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    if (!target.element?.classList.contains(FOLD_GLYPH_CLASS)) return;
    const region = this.shownRegions.find((candidate) => candidate.modified.start === target.position.lineNumber);
    if (!region) return;
    this.shownRegions = this.shownRegions.filter((candidate) => candidate !== region);
    this.hiddenRegions = sortRegions([...this.hiddenRegions, region]);
    this.applyHiddenRegions();
    this.scheduleRedraw();
  }

  /** A primary press on the gutter (not on a revert arrow) drags the seam between the sides. */
  private onGutterPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || isRevertArrow(event.target)) return;
    const width = this.originalElement.clientWidth + this.modifiedElement.clientWidth;
    if (!width) return;
    const startWidth = this.originalElement.clientWidth;
    let share = clampSplitDiffShare(startWidth / width);
    this.gutterElement.classList.add(GUTTER_DRAGGING_CLASS);
    trackPointerDrag(
      this.gutterElement,
      event,
      (dx) => {
        share = clampSplitDiffShare((startWidth + dx) / width);
        this.setOriginalShare(share);
      },
      () => {
        this.gutterElement.classList.remove(GUTTER_DRAGGING_CLASS);
        this.onOriginalShareChange?.(share);
      },
    );
  }

  private onGutterDoubleClick(event: MouseEvent): void {
    if (isRevertArrow(event.target)) return;
    this.setOriginalShare(DEFAULT_SPLIT_DIFF_SHARE);
    this.onOriginalShareChange?.(DEFAULT_SPLIT_DIFF_SHARE);
  }

  private onScroll(side: Side, event: monaco.IScrollEvent): void {
    this.scheduleRedraw();
    if (this.isSyncingScroll || (!event.scrollTopChanged && !event.scrollLeftChanged)) return;
    const source = side === "original" ? this.original : this.modified;
    const target = side === "original" ? this.modified : this.original;
    this.isSyncingScroll = true;
    try {
      if (event.scrollLeftChanged) {
        target.setScrollLeft(event.scrollLeft, monaco.editor.ScrollType.Immediate);
      }
      if (event.scrollTopChanged) {
        target.setScrollTop(this.mappedScrollTop(side, source, target), monaco.editor.ScrollType.Immediate);
      }
    } finally {
      this.isSyncingScroll = false;
    }
  }

  /** Scroll top for `target` that keeps the first visible line of `source` level with its counterpart. */
  private mappedScrollTop(side: Side, source: monaco.editor.ICodeEditor, target: monaco.editor.ICodeEditor): number {
    const [visible] = source.getVisibleRanges();
    if (!visible) return target.getScrollTop();
    const anchor = visible.startLineNumber;
    const offset = source.getScrollTop() - source.getTopForLineNumber(anchor);
    const mapped = mapLine(this.blocks, side, anchor);
    const wholeLine = Math.floor(mapped);
    const fraction = mapped - wholeLine;
    const top = lineTop(target, wholeLine) + fraction * (lineTop(target, wholeLine + 1) - lineTop(target, wholeLine));
    return Math.max(0, top + offset);
  }

  private scheduleRedraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.drawNumbers();
      this.drawConnectors();
    });
  }

  /** Renders the original's line numbers for its visible lines, deleted lines on the red gutter color. */
  private drawNumbers(): void {
    const fontInfo = this.original.getOption(monaco.editor.EditorOption.fontInfo);
    const lineHeight = this.original.getOption(monaco.editor.EditorOption.lineHeight);
    const digits = String(this.originalModel.getLineCount()).length;
    this.numbersElement.style.width = `${Math.ceil(digits * fontInfo.typicalHalfwidthCharacterWidth) + 14}px`;
    this.numbersElement.style.fontFamily = fontInfo.fontFamily;
    this.numbersElement.style.fontSize = `${fontInfo.fontSize}px`;

    const scrollTop = this.original.getScrollTop();
    const deletedLines = new Set<number>();
    for (const block of this.blocks) {
      for (let line = block.original.start; line < block.original.end; line++) {
        deletedLines.add(line);
      }
    }
    const numbers: HTMLElement[] = [];
    for (const range of this.original.getVisibleRanges()) {
      for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
        const number = createElement("div", deletedLines.has(line) ? "split-diff__number split-diff__number--deleted" : "split-diff__number");
        number.style.top = `${this.original.getTopForLineNumber(line) - scrollTop}px`;
        number.style.height = `${lineHeight}px`;
        number.style.lineHeight = `${lineHeight}px`;
        number.textContent = String(line);
        numbers.push(number);
      }
    }
    this.numbersElement.replaceChildren(...numbers);
  }

  /**
   * Draws one connector per block between the original lines and their modified counterpart, plus the revert
   * arrow that applies the original lines to the modified side.
   */
  private drawConnectors(): void {
    const width = this.gutterElement.clientWidth;
    const height = this.gutterElement.clientHeight;
    const lineHeight = this.modified.getOption(monaco.editor.EditorOption.lineHeight);
    const paths: SVGPathElement[] = [];
    const arrows: HTMLElement[] = [];
    for (const block of this.blocks) {
      const left = blockBounds(this.original, block.original);
      const right = blockBounds(this.modified, block.modified);
      if (Math.max(left[1], right[1]) < 0 || Math.min(left[0], right[0]) > height) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", connectorPath(width, left, right));
      const fill = rangeLength(block.original) === 0 ? INSERT_COLOR : rangeLength(block.modified) === 0 ? DELETE_COLOR : `url(#${GRADIENT_ID})`;
      path.setAttribute("fill", fill);
      paths.push(path);
      // The arrow sits at the modified side's top, which may lie outside the gutter while the connector still shows.
      if (this.isReadOnly || right[0] < -REVERT_ARROW_SIZE || right[0] > height) continue;
      arrows.push(createRevertArrow(block, right[0], rangeLength(block.modified) === 0 ? 0 : lineHeight, () => this.revertBlock(block)));
    }
    this.shapes.replaceChildren(...paths);
    this.revertLayer.replaceChildren(...arrows);
  }

  /** Replaces the block's modified lines with the original ones as a single undoable edit; the rediff follows. */
  private revertBlock(block: ChangeBlock): void {
    const edit = computeRevertEdit(this.originalModel.getLinesContent(), this.modifiedModel.getLinesContent(), block, this.modifiedModel.getEOL());
    const range = new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn);
    this.modified.pushUndoStop();
    this.modified.executeEdits("split-diff-revert", [{ range, text: edit.text }]);
    this.modified.pushUndoStop();
    this.modified.focus();
  }
}

function isRevertArrow(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`.${REVERT_CLASS}`) !== null;
}

function createElement(tag: string, className: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function createHiddenBar(region: UnchangedRegion): HTMLElement {
  const bar = createElement("div", "split-diff__hidden");
  const count = rangeLength(region.original);
  bar.textContent = `${count} hidden ${count === 1 ? "line" : "lines"} · click to show`;
  return bar;
}

function sortRegions(regions: UnchangedRegion[]): UnchangedRegion[] {
  return regions.sort((first, second) => first.original.start - second.original.start);
}

function toRange(range: LineRange): monaco.IRange {
  return { startLineNumber: range.start, startColumn: 1, endLineNumber: range.end - 1, endColumn: 1 };
}

function lineDecoration(range: LineRange, className: string, marginClassName: string): monaco.editor.IModelDeltaDecoration {
  return { range: toRange(range), options: { isWholeLine: true, className, marginClassName } };
}

function charDecoration(range: CharRange, inlineClassName: string): monaco.editor.IModelDeltaDecoration {
  return {
    range: { startLineNumber: range.line, startColumn: range.startColumn, endLineNumber: range.line, endColumn: range.endColumn },
    options: { inlineClassName },
  };
}

/** Top of `line` in scrollable coordinates; one past the last line is the bottom of the document. */
function lineTop(editor: monaco.editor.ICodeEditor, line: number): number {
  const lineCount = editor.getModel()?.getLineCount() ?? 1;
  if (line > lineCount) return editor.getBottomForLineNumber(lineCount);
  return editor.getTopForLineNumber(Math.max(1, line));
}

/** Pixel extent of a line range inside the visible editor area; an empty range collapses to the seam before `start`. */
function blockBounds(editor: monaco.editor.ICodeEditor, range: LineRange): [number, number] {
  const scrollTop = editor.getScrollTop();
  const top = lineTop(editor, range.start) - scrollTop;
  if (rangeLength(range) === 0) return [top, top];
  return [top, editor.getBottomForLineNumber(range.end - 1) - scrollTop];
}

/** Arrow button for a block, vertically centred on the block's first modified line (`slotHeight` 0 marks an empty side). */
function createRevertArrow(block: ChangeBlock, top: number, slotHeight: number, onClick: () => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = REVERT_CLASS;
  button.title = rangeLength(block.original) === 0 ? "Remove inserted lines" : "Revert to original";
  button.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  button.style.top = `${top + (slotHeight - REVERT_ARROW_SIZE) / 2}px`;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", onClick);
  return button;
}

function connectorPath(width: number, [leftTop, leftBottom]: [number, number], [rightTop, rightBottom]: [number, number]): string {
  const mid = width / 2;
  return `M0 ${leftTop} C${mid} ${leftTop} ${mid} ${rightTop} ${width} ${rightTop} L${width} ${rightBottom} C${mid} ${rightBottom} ${mid} ${leftBottom} 0 ${leftBottom} Z`;
}
