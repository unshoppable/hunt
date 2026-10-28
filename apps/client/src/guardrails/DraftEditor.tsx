import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useMarkdownMonaco } from "./markdown-monaco.hook";

/** Markdown editor on the content of a file not written yet; it takes over `value` whenever that changes, ⌘S calls `onSave`. */
export function DraftEditor({ value, onChange, onSave }: { value: string; onChange: (value: string) => void; onSave: () => void }) {
  const { hostRef, editorRef } = useMarkdownMonaco(() => onSave());
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = monaco.editor.createModel(value, "markdown");
    const subscription = model.onDidChangeContent(() => latestOnChange.current(model.getValue()));
    editor.setModel(model);
    return () => {
      subscription.dispose();
      editor.setModel(null);
      model.dispose();
    };
    // One model per draft; later values reach it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorRef]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || model.getValue() === value) return;
    model.setValue(value);
  }, [editorRef, value]);

  return (
    <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}
