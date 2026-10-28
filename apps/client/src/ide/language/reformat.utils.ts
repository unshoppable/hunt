import { computeChangeBlocks, computeRevertEdit, type TextEdit } from "../../editor/line-diff.utils";
import type { TextDocumentEdit, TextEdit as LspTextEdit, WorkspaceEdit } from "../lsp/lsp-protocol.utils";

/**
 * Edits that turn a model holding `lines` (its `getLinesContent()`, joined by `eol`) into `formatted`, one per changed
 * run of lines, so the caret and the scroll position stay where the lines around them did not change.
 */
export function editsToText(lines: string[], eol: string, formatted: string): TextEdit[] {
  const target = formatted.split(/\r?\n/);
  // Every line, the empty last one included, ends in a line break, so a block covers an added or removed final break.
  const blocks = computeChangeBlocks(`${target.join("\n")}\n`, `${lines.join("\n")}\n`);
  return blocks.map((block) => computeRevertEdit(target, lines, block, eol));
}

/** The edits a workspace edit makes to the document `uri`, from `changes` or from `documentChanges`. */
export function documentEdits(edit: WorkspaceEdit | undefined, uri: string): LspTextEdit[] {
  if (!edit) return [];
  if (edit.changes) return edit.changes[uri] ?? [];
  return (edit.documentChanges ?? [])
    .filter((change): change is TextDocumentEdit => "textDocument" in change && change.textDocument.uri === uri)
    .flatMap((change) => change.edits);
}
