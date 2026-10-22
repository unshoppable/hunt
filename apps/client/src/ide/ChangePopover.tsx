import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as monaco from "monaco-editor";
import { computeInnerChanges, rangeLength } from "../diff/lineDiff";
import { PREVIEW_EDITOR_OPTIONS } from "../diff/monaco";
import type { ChangeMarkers, Marker } from "./changeMarkers";
import { CopyIcon } from "../ui/icons";
import { ResizeGrips } from "../ui/ResizeGrips";
import { useDismiss } from "../ui/useDismiss";
import { usePopupSize } from "../ui/usePopupSize";

const MIN_SIZE = { width: 320, height: 120 };
const EDGE_GAP = 12;

type Position = { top: number; left: number; maxWidth: number };

type ChangePopoverProps = {
  editor: monaco.editor.IStandaloneCodeEditor;
  markers: ChangeMarkers;
  marker: Marker;
  /** Called with the marker to show after ↑ / ↓. */
  onShowMarker: (marker: Marker) => void;
  onClose: () => void;
};

/**
 * WebStorm's change popup for one gutter marker: a toolbar (previous / next change, rollback, copy) above the lines
 * the block had at HEAD, shown read-only on the deletion tint with the original line numbers. It sits over the
 * block's first line, follows the editor's scrolling and closes on Esc, a click outside or when the line leaves
 * the viewport. It is as tall as the lines up to the remembered height; dragging its right or bottom edge resizes it.
 * A block of inserted lines has no original lines: its popup is just the toolbar, as wide as its buttons and placed
 * above the block so that the inserted lines stay visible.
 */
export function ChangePopover({ editor, markers, marker, onShowMarker, onClose }: ChangePopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(() => anchorOf(editor, marker));
  const layout = editor.getLayoutInfo();
  const { size, isHeightSet, grips } = usePopupSize("change", { min: MIN_SIZE, max: { width: position?.maxWidth ?? layout.width, height: layout.height - 2 } });
  const { block } = marker;
  const originalLines = markers.headLines.slice(block.original.start - 1, block.original.end - 1);
  const index = markers.markers.indexOf(marker);
  const count = markers.markers.length;
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const isInsert = marker.kind === "insert";

  useEffect(() => {
    const update = () => {
      const next = anchorOf(editor, marker);
      if (next) {
        setPosition(next);
      } else {
        onClose();
      }
    };
    update();
    const subscriptions = [editor.onDidScrollChange(update), editor.onDidLayoutChange(update)];
    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  }, [editor, marker, onClose]);

  // Keeps the popup inside the editor when the block is near the bottom; a toolbar alone sits above the block.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !position) return;
    const height = editor.getLayoutInfo().height;
    const top = isInsert ? position.top - root.offsetHeight : position.top;
    root.style.top = `${Math.max(0, Math.min(top, height - root.offsetHeight - 2))}px`;
  }, [editor, position, isInsert, originalLines.length, size.height, isHeightSet]);

  useDismiss(rootRef, onClose);

  useEffect(() => {
    const host = codeRef.current;
    const model = editor.getModel();
    if (!host || !model || !originalLines.length) return;
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const firstLine = block.original.start;
    const previewModel = monaco.editor.createModel(originalLines.join("\n"), model.getLanguageId());
    const preview = monaco.editor.create(host, {
      ...PREVIEW_EDITOR_OPTIONS,
      model: previewModel,
      fontSize: fontInfo.fontSize,
      fontFamily: fontInfo.fontFamily,
      lineHeight,
      lineNumbers: (line) => String(firstLine + line - 1),
      lineNumbersMinChars: String(block.original.end - 1).length + 1,
      lineDecorationsWidth: 8,
      renderLineHighlight: "none",
      scrollbar: { ...PREVIEW_EDITOR_OPTIONS.scrollbar, vertical: "auto" },
    });
    const shift = firstLine - 1;
    const inner = computeInnerChanges(block, markers.headLines, model.getLinesContent()).original;
    preview.createDecorationsCollection([
      { range: previewModel.getFullModelRange(), options: { isWholeLine: true, className: "split-diff-line-delete", marginClassName: "hunt-change-popover__margin" } },
      ...inner.map((range) => ({
        range: { startLineNumber: range.line - shift, startColumn: range.startColumn, endLineNumber: range.line - shift, endColumn: range.endColumn },
        options: { inlineClassName: "split-diff-char-delete" },
      })),
    ]);
    return () => {
      preview.dispose();
      previewModel.dispose();
    };
    // `block` and `originalLines` derive from `markers` and `marker`, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, markers, marker, lineHeight]);

  if (!position) return null;

  const showNeighbour = (delta: number) => {
    const next = markers.markers[index + delta];
    if (!next) return;
    editor.revealLineInCenterIfOutsideViewport(next.startLine);
    onShowMarker(next);
  };

  const rollback = () => {
    markers.revert(block);
    onClose();
  };

  const copyOriginal = () => {
    navigator.clipboard?.writeText(originalLines.join("\n")).catch(() => {});
  };

  const insertedCount = rangeLength(block.modified);
  const summary = isInsert ? `${insertedCount} inserted ${insertedCount === 1 ? "line" : "lines"}` : null;
  const sizeStyle = isInsert ? {} : { width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Change"
      className="hunt-change-popover absolute z-20 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-(--surface-inspector) shadow-xl shadow-black/50"
      style={{ top: position.top, left: position.left, ...sizeStyle }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className={`flex shrink-0 items-center gap-0.5 px-2 py-2 text-neutral-300 ${isInsert ? "" : "border-b border-(--line)"}`}>
        <ToolbarButton title="Previous change" disabled={index <= 0} onClick={() => showNeighbour(-1)}>
          <ArrowIcon direction="up" />
        </ToolbarButton>
        <ToolbarButton title="Next change" disabled={index < 0 || index >= count - 1} onClick={() => showNeighbour(1)}>
          <ArrowIcon direction="down" />
        </ToolbarButton>
        <span className="mx-1 h-4 w-px bg-(--line)" />
        <ToolbarButton title="Rollback" onClick={rollback}>
          <RollbackIcon />
        </ToolbarButton>
        {isInsert ? null : (
          <ToolbarButton title="Copy original lines" disabled={!originalLines.length} onClick={copyOriginal}>
            <CopyIcon className="size-[14px]" />
          </ToolbarButton>
        )}
        <span className="ml-auto pr-1 pl-3 text-[12px] whitespace-nowrap text-neutral-500">{summary ?? `${count ? index + 1 : 0} / ${count}`}</span>
      </div>
      {originalLines.length ? <div ref={codeRef} className="min-h-0 shrink" style={{ height: originalLines.length * lineHeight }} /> : null}
      {isInsert ? null : <ResizeGrips edges={{ right: true, bottom: true }} {...grips} />}
    </div>
  );
}

/** Position over the marker's first line, or null when that line is outside the viewport. */
function anchorOf(editor: monaco.editor.ICodeEditor, marker: Marker): Position | null {
  const layout = editor.getLayoutInfo();
  const line = editor.getScrolledVisiblePosition({ lineNumber: marker.startLine, column: 1 });
  if (!line || line.top + line.height < 0 || line.top > layout.height) return null;
  const top = marker.edge === "bottom" ? line.top + line.height : line.top;
  return { top, left: layout.contentLeft, maxWidth: layout.width - layout.contentLeft - EDGE_GAP };
}

function ToolbarButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ArrowIcon({ direction }: { direction: "up" | "down" }) {
  const path = direction === "up" ? "M8 13V3M4 7l4-4 4 4" : "M8 3v10M4 9l4 4 4-4";
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RollbackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3 3v3h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
