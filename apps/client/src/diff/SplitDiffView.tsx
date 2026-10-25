import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { SplitDiffController } from "./splitDiff";
import { useSettingsStore } from "../state/settings";

/**
 * React host for the side-by-side diff. The editors are created once per mount; `original` / `modified`
 * updates replace the texts, so the parent must remount (key) when a different file is shown. The width share of
 * the sides lives in the settings, so every split diff follows a drag in any of them.
 */
export function SplitDiffView({
  original,
  modified,
  modifiedModel,
  language,
  fontSize,
  lineHeight,
  fontFamily,
  readOnly,
  collapseUnchanged,
  onEditorsCreated,
}: {
  original: string;
  modified: string;
  /** A worktree document the modified side shows instead of a model of its own; it outlives the view. */
  modifiedModel?: editor.ITextModel;
  language: string;
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** CSS font family of the code. */
  fontFamily: string;
  /** The modified side cannot be edited and has no revert arrows. */
  readOnly?: boolean;
  /** Collapses every unchanged stretch into a hidden-lines bar; false expands them all. */
  collapseUnchanged: boolean;
  /** Receives both editors right after they were created; only `modified` is editable. */
  onEditorsCreated: (original: editor.IStandaloneCodeEditor, modified: editor.IStandaloneCodeEditor) => void;
}) {
  const originalShare = useSettingsStore((state) => state.splitDiffShare);
  const setSplitDiffShare = useSettingsStore((state) => state.setSplitDiffShare);
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SplitDiffController | null>(null);
  const initialRef = useRef({
    original,
    modified,
    modifiedModel,
    language,
    fontSize,
    lineHeight,
    fontFamily,
    readOnly,
    collapseUnchanged,
    originalShare,
    onOriginalShareChange: setSplitDiffShare,
    onEditorsCreated,
  });

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

  useEffect(() => {
    controllerRef.current?.setCollapseUnchanged(collapseUnchanged);
  }, [collapseUnchanged]);

  useEffect(() => {
    controllerRef.current?.setOriginalShare(originalShare);
  }, [originalShare]);

  return <div ref={rootRef} className="split-diff" />;
}
