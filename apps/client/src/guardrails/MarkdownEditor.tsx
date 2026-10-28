import * as monaco from "monaco-editor";
import type { DocumentWorkspace } from "../ide/documents/documents.service";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { useMarkdownMonaco } from "./markdown-monaco.hook";

/** Markdown editor on the workspace document of `path`; ⌘S saves it. */
export function MarkdownEditor({ workspace, path, onSave, onError }: { workspace: DocumentWorkspace; path: string; onSave: (path: string) => void; onError: (error: string | null) => void }) {
  const { hostRef, editorRef } = useMarkdownMonaco((editor) => {
    const shownPath = workspace.pathOf(editor.getModel()?.uri ?? monaco.Uri.parse("inmemory://none"));
    if (shownPath) {
      onSave(shownPath);
    }
  });

  useLoad(
    () => workspace.open(path),
    {
      onValue: (document) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.setModel(document.model);
        editor.setScrollTop(0);
        editor.focus();
        onError(null);
      },
      onError: (reason) => onError(errorText(reason)),
    },
    [workspace, path, onError],
  );

  return (
    <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}
