/** The one text of a worktree file that every window edits (`ide/documents.rs`); `version` grows with every change. */
export type DocumentState = { text: string; version: number; isDirty: boolean };
/** The answer to an accepted `documentEdit`. */
export type DocumentEditAck = { version: number; isDirty: boolean };
/** An LSP content change: `text` replaces `range` (zero-based lines, UTF-16 columns). */
export type DocumentContentChange = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string };
/** The document `path` of `worktreePath` reached `version`, through `changes` against `version - 1` or as a whole `text`. */
export type DocumentChangedEvent = {
  worktreePath: string;
  path: string;
  version: number;
  changes: DocumentContentChange[] | null;
  text: string | null;
  isDirty: boolean;
};
/** Whether the document `path` has unsaved edits changed without a text change, e.g. through a save. */
export type DocumentDirtyEvent = { worktreePath: string; path: string; isDirty: boolean };
