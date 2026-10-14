import * as monaco from "monaco-editor";
import type { Workspace } from "../ide/documents";
import { MARKER_OWNER } from "../ide/lsp/providers";

/** Owner of the markers copied onto a diff's editable side. */
const MIRROR_OWNER = "lsp-diff";

/**
 * Shows the language server's diagnostics of the worktree file `path` in `editor`, the editable side of its diff:
 * squiggles, hover messages and marks in the scroll track. The diagnostics belong to the workspace document of the
 * file, which holds the file as saved, so they are copied only while both texts are equal; edits in between move the
 * copied markers along.
 */
export function mirrorDiagnostics(editor: monaco.editor.ICodeEditor, workspace: Workspace, path: string): monaco.IDisposable {
  const target = editor.getModel();
  let source: monaco.editor.ITextModel | null = null;
  let isDisposed = false;

  const copy = () => {
    if (isDisposed || !source || !target || target.isDisposed() || source.getValue() !== target.getValue()) return;
    monaco.editor.setModelMarkers(target, MIRROR_OWNER, monaco.editor.getModelMarkers({ resource: source.uri, owner: MARKER_OWNER }));
  };

  // Monaco drops the event of a marker change made while it delivers one, so the copy waits until the delivery is over.
  const subscription = monaco.editor.onDidChangeMarkers((uris) => {
    const sourceUri = source?.uri.toString();
    if (!sourceUri || !uris.some((uri) => uri.toString() === sourceUri)) return;
    queueMicrotask(copy);
  });

  workspace
    .load(path)
    .then((document) => {
      source = document.model;
      copy();
    })
    // A file that cannot be read has no diagnostics to show.
    .catch(() => undefined);

  return {
    dispose: () => {
      isDisposed = true;
      subscription.dispose();
      if (target) {
        monaco.editor.setModelMarkers(target, MIRROR_OWNER, []);
      }
    },
  };
}
