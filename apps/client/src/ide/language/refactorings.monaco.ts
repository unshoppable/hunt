import * as monaco from "monaco-editor";
import { addKeymapAction, onShortcut } from "../../editor/shortcuts.monaco";
import { commands } from "../../ipc/commands";
import { errorText } from "../../ui/error-text.utils";
import { formattingEdits, renameTarget, unusedImportEdits, type RenameTarget } from "./language-service.utils";
import { toMonacoRange, type TextEdit } from "../lsp/lsp-protocol.utils";
import { editsToText } from "./reformat.utils";

export type RefactoringHandlers = {
  /** The session and worktree-relative path of the file `model` holds; null when it holds no worktree file. */
  fileOf: (model: monaco.editor.ITextModel) => { sessionId: string; path: string } | null;
  /** Opens the Rename dialog for `target`, found in `model`. */
  onRename: (model: monaco.editor.ITextModel, target: RenameTarget) => void;
  /** Called with null when a refactoring starts and with the reason when it fails. */
  onError: (message: string | null) => void;
};

/**
 * Gives an editor that shows a worktree document the refactorings of the editor panes: ⌘Ü or "Rename…" in the
 * context menu finds the symbol at the caret and hands it to `onRename`, ⌘G removes unused imports and formats the
 * file (see `reformat`). Both do nothing while the editor is read-only.
 */
export function attachRefactorings(editor: monaco.editor.IStandaloneCodeEditor, handlers: RefactoringHandlers): monaco.IDisposable {
  const reformatShortcut = onShortcut(editor, "editor.reformat", () => {
    const model = editor.getModel();
    const file = model ? handlers.fileOf(model) : null;
    if (!file) return;
    const report = (reason: unknown) => handlers.onError(errorText(reason));
    handlers.onError(null);
    reformat(editor, file.sessionId, file.path, report).catch(report);
  });

  const rename = addKeymapAction(editor, "editor.rename", {
    id: "hunt.rename",
    label: "Rename…",
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 0,
    precondition: "!editorReadonly",
    run: () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      handlers.onError(null);
      renameTarget(model, position)
        .then((target) => editor.getModel() === model && handlers.onRename(model, target))
        .catch((reason) => handlers.onError(errorText(reason)));
    },
  });

  return {
    dispose: () => {
      reformatShortcut.dispose();
      rename.dispose();
    },
  };
}

/**
 * Removes the unused imports of the editor's file `path` through the language server, then formats it with the
 * Prettier the worktree installs (its config and plugins apply), or with the language server's formatter when it has
 * none. A failed import cleanup goes to `onImportError` and the file is still formatted. Stops when the text or file
 * changes meanwhile; the edits made until then undo as one step.
 */
async function reformat(editor: monaco.editor.ICodeEditor, sessionId: string, path: string, onImportError: (reason: unknown) => void): Promise<void> {
  const model = editor.getModel();
  if (!model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  let version = model.getVersionId();
  const isCurrent = () => editor.getModel() === model && model.getVersionId() === version;
  let hasEdited = false;
  const apply = (edits: monaco.editor.IIdentifiedSingleEditOperation[]) => {
    if (edits.length === 0) return;
    if (!hasEdited) {
      editor.pushUndoStop();
    }
    hasEdited = true;
    editor.executeEdits("hunt-reformat", edits);
    version = model.getVersionId();
  };
  const fromLsp = (edits: TextEdit[]) => edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));

  try {
    const importEdits = await unusedImportEdits(model).catch((reason) => {
      onImportError(reason);
      return [];
    });
    if (!isCurrent()) return;
    apply(fromLsp(importEdits));

    const prettier = await commands.formatWithPrettier(sessionId, path, model.getValue());
    if (!isCurrent()) return;
    if (prettier.installed) {
      const edits = prettier.formatted === null ? [] : editsToText(model.getLinesContent(), model.getEOL(), prettier.formatted);
      apply(edits.map((edit) => ({ range: new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn), text: edit.text })));
      return;
    }
    const edits = await formattingEdits(model);
    if (!edits || !isCurrent()) return;
    apply(fromLsp(edits));
  } finally {
    if (hasEdited) {
      editor.pushUndoStop();
    }
  }
}
