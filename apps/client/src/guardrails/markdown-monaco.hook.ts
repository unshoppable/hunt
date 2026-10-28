import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { EDITOR_APPEARANCE_OPTIONS, MONACO_THEME } from "../editor/monaco.constants";
import { onShortcut } from "../editor/shortcuts.monaco";
import { setupMonaco } from "../editor/setup.monaco";
import { useSettingsStore } from "../settings/settings.store";

/**
 * Monaco editor for Markdown with soft wrapping, sized like the editor panes, created without a model in the host
 * `hostRef` points to; ⌘S calls `onSave` with the editor.
 */
export function useMarkdownMonaco(onSave: (editor: monaco.editor.IStandaloneCodeEditor) => void) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const latestOnSave = useRef(onSave);
  latestOnSave.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setupMonaco();
    const editor = monaco.editor.create(host, {
      ...EDITOR_APPEARANCE_OPTIONS,
      theme: MONACO_THEME,
      model: null,
      fontSize,
      lineHeight,
      fontFamily,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      renderLineHighlight: "line",
      scrollbar: { alwaysConsumeMouseWheel: false },
      wordWrap: "on",
      links: false,
      dragAndDrop: false,
      padding: { top: 12, bottom: 12 },
    });
    onShortcut(editor, "editor.save", () => latestOnSave.current(editor));
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.setModel(null);
      editor.dispose();
    };
    // Created once; the font options follow the settings below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, lineHeight, fontFamily });
  }, [fontSize, lineHeight, fontFamily]);

  return { hostRef, editorRef };
}
