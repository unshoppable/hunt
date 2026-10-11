import type * as monaco from "monaco-editor";
import type { SelectionContext } from "../ipc/types";

/** A selection handed to the sub chat plus the viewport point to anchor its popover at. */
export type SelectionRequest = { selection: SelectionContext; anchor: { x: number; y: number } };

/** Inclusive line span of a selection; a selection ending at column 1 does not include that line. */
export function selectedLineSpan(selection: monaco.IRange): { startLine: number; endLine: number } {
  const endsBeforeLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber;
  return { startLine: selection.startLineNumber, endLine: endsBeforeLine ? selection.endLineNumber - 1 : selection.endLineNumber };
}

/** Viewport point under `line` at the left edge of the code, where a popover about that line is anchored. */
export function anchorBelowLine(editor: monaco.editor.ICodeEditor, line: number): { x: number; y: number } {
  const domNode = editor.getDomNode();
  const editorRect = domNode?.getBoundingClientRect();
  const position = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
  if (!editorRect || !position) return { x: 24, y: 24 };
  return { x: editorRect.left + editor.getLayoutInfo().contentLeft, y: editorRect.top + position.top + position.height + 6 };
}

/** Reads the current selection of `editor` for `path`; `null` when nothing is selected. */
export function readSelectionRequest(editor: monaco.editor.ICodeEditor, path: string): SelectionRequest | null {
  const selection = editor.getSelection();
  const model = editor.getModel();
  const domNode = editor.getDomNode();
  if (!selection || !model || !domNode || selection.isEmpty()) return null;

  const text = model.getValueInRange(selection).replace(/\r?\n$/, "");
  if (!text.trim()) return null;

  const { startLine, endLine } = selectedLineSpan(selection);
  const editorRect = domNode.getBoundingClientRect();
  const end = editor.getScrolledVisiblePosition(selection.getEndPosition());
  const anchor = end
    ? { x: editorRect.left + Math.min(end.left, editorRect.width / 2), y: editorRect.top + end.top + end.height + 6 }
    : { x: editorRect.left + 24, y: editorRect.top + 24 };
  return { selection: { path, startLine, endLine, text }, anchor };
}
