import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { SplitDiffController } from "./splitDiff";

/**
 * React host for the side-by-side diff. The editors are created once per mount; `original` / `modified`
 * updates replace the texts, so the parent must remount (key) when a different file is shown.
 */
export function SplitDiffView({
  original,
  modified,
  language,
  fontSize,
  lineHeight,
  fontFamily,
  onEditorsCreated,
}: {
  original: string;
  modified: string;
  language: string;
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** CSS font family of the code. */
  fontFamily: string;
  /** Receives both editors right after they were created; only `modified` is editable. */
  onEditorsCreated: (original: editor.IStandaloneCodeEditor, modified: editor.IStandaloneCodeEditor) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SplitDiffController | null>(null);
  const initialRef = useRef({ original, modified, language, fontSize, lineHeight, fontFamily, onEditorsCreated });

  useEffect(() => {
    if (!rootRef.current) return;
    const initial = initialRef.current;
    const controller = new SplitDiffController(rootRef.current, initial);
    controllerRef.current = controller;
    initial.onEditorsCreated(controller.original, controller.modified);
    controller.renderNow();
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setContents(original, modified);
  }, [original, modified]);

  useEffect(() => {
    controllerRef.current?.setTextMetrics(fontSize, lineHeight, fontFamily);
  }, [fontSize, lineHeight, fontFamily]);

  return <div ref={rootRef} className="split-diff" />;
}
