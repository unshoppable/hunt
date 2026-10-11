import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { FileDiff } from "../ipc/types";
import { attachIdeLink } from "./ideLink";
import { EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, monacoLanguage, setupMonaco } from "./monaco";
import { anchorBelowLine, type SelectionRequest } from "./selectionContext";
import { attachSelectionAgent } from "../ide/selectionAgent";
import { SelectionChatMarkers } from "../ide/selectionChatMarkers";
import { useSelectionChats } from "../ide/selectionChats";
import { computeChangeBlocks } from "./lineDiff";
import { AddCommentGlyph } from "../review/addCommentGlyph";
import { ReviewCommentZones } from "../review/ReviewCommentZones";
import { isInsideHunk, useReviewedPullRequest, type LineSpan } from "../review/reviewComments";
import { SplitDiffView } from "./SplitDiffView";

setupMonaco();

export type CodeDiffEditorHandle = {
  /** Saves the current editor content, same as Cmd/Ctrl+S inside the editor. */
  save: () => void;
};

type CodeDiffEditorProps = {
  ref?: Ref<CodeDiffEditorHandle>;
  /** The session whose worktree `diff` belongs to; its sub chats about lines of the file get a glyph in the gutter. */
  sessionId: string;
  diff: FileDiff;
  mode: "split" | "unified";
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** CSS font family of the code. */
  fontFamily: string;
  /** Called with the current editor content on Cmd/Ctrl+S. */
  onSave: (content: string) => void;
  /** Reports whether the editor content differs from `diff.newContent`. */
  onDirtyChange: (isDirty: boolean) => void;
  /** Called with the clicked 1-based position on ⌘click in either side (open in the built-in editor). */
  onNavigate: (line: number, column: number) => void;
  /** Called with the clicked 1-based position on ⇧⌘click in either side (open in WebStorm). */
  onOpenInIde: (line: number, column: number) => void;
  /**
   * Opens the sub chat popover: from either side's context menu ("Ask Claude about selection") with the selected
   * lines, or from a click on a sub chat's gutter glyph with that sub session (`subSessionId`).
   */
  onOpenSubChat: (request: SelectionRequest, subSessionId?: string) => void;
  /** Opens or closes the sub chat popover from the floating button at the end of a selection on either side. */
  onToggleSubChat: (request: SelectionRequest) => void;
};

/**
 * Side-by-side (WebStorm-style, see SplitDiffView) or inline diff whose right side is editable; the left side
 * is the committed version and read-only. `diff.newContent` is the saved state: changing it (after a save or an
 * external reload) resets the dirty flag. Switching the mode keeps unsaved edits. Sub chats opened from lines of
 * the file get a glyph on their first line in the right side's gutter; a click on it reopens the chat. Both sides
 * offer the agent features of the editor panes: the context menu entry and the floating button on a selection (a
 * selection on the left side hands over the committed lines).
 */
export function CodeDiffEditor({ ref, sessionId, diff, mode, fontSize, lineHeight, fontFamily, onSave, onDirtyChange, onNavigate, onOpenInIde, onOpenSubChat, onToggleSubChat }: CodeDiffEditorProps) {
  const modifiedEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const chatMarkersRef = useRef<SelectionChatMarkers | null>(null);
  const selectionChats = useSelectionChats(sessionId, diff.path);
  /** The editable right side once it exists; the review comment zones render into it. */
  const [modifiedEditor, setModifiedEditor] = useState<monaco.editor.ICodeEditor | null>(null);
  const pullRequest = useReviewedPullRequest(sessionId);
  const isReviewRef = useRef(!!pullRequest);
  isReviewRef.current = !!pullRequest;
  /** Lines a review comment is being written for. */
  const [composer, setComposer] = useState<LineSpan | null>(null);
  /** Change blocks of the saved state, which decide whether a review comment on a line is posted inline. */
  const blocks = useMemo(() => computeChangeBlocks(diff.oldContent ?? "", diff.newContent ?? ""), [diff.oldContent, diff.newContent]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const savedContentRef = useRef(diff.newContent ?? "");
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onNavigateRef = useRef(onNavigate);
  const onOpenInIdeRef = useRef(onOpenInIde);
  const onOpenSubChatRef = useRef(onOpenSubChat);
  const onToggleSubChatRef = useRef(onToggleSubChat);
  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;
  onNavigateRef.current = onNavigate;
  onOpenInIdeRef.current = onOpenInIde;
  onOpenSubChatRef.current = onOpenSubChat;
  onToggleSubChatRef.current = onToggleSubChat;
  const selectionChatsRef = useRef(selectionChats);
  selectionChatsRef.current = selectionChats;

  /** Text the editable editor starts with; carried over when the mode switches so unsaved edits survive. */
  const [modifiedValue, setModifiedValue] = useState(diff.newContent ?? "");
  const [previousMode, setPreviousMode] = useState(mode);
  if (previousMode !== mode) {
    setPreviousMode(mode);
    setComposer(null);
    const liveContent = modifiedEditorRef.current?.getValue();
    if (liveContent !== undefined && liveContent !== modifiedValue) {
      setModifiedValue(liveContent);
    }
  }

  useImperativeHandle(ref, () => ({
    save: () => {
      const content = modifiedEditorRef.current?.getValue();
      if (content !== undefined) {
        onSaveRef.current(content);
      }
    },
  }));

  useEffect(() => {
    chatMarkersRef.current?.set(diff.path, selectionChats);
  }, [diff.path, selectionChats]);

  useEffect(() => {
    savedContentRef.current = diff.newContent ?? "";
    setModifiedValue(diff.newContent ?? "");
    const current = modifiedEditorRef.current?.getValue();
    if (current !== undefined) {
      onDirtyChangeRef.current(current !== savedContentRef.current);
    }
  }, [diff.newContent]);

  /**
   * ⌘click opens the position in the built-in editor, ⇧⌘click in WebStorm (Monaco's own go-to-definition stays
   * off); the context menu and the floating selection button hand a selection to the agent.
   */
  const attachSideFeatures = (sideEditor: monaco.editor.IStandaloneCodeEditor) => {
    const link = attachIdeLink(sideEditor, {
      onNavigate: (line, column) => onNavigateRef.current(line, column),
      onOpenInIde: (line, column) => onOpenInIdeRef.current(line, column),
    });
    const agent = attachSelectionAgent(sideEditor, {
      pathOf: () => diff.path,
      onOpen: (request) => onOpenSubChatRef.current(request),
      onToggle: (request) => onToggleSubChatRef.current(request),
    });
    sideEditor.onDidDispose(() => {
      link.dispose();
      agent.dispose();
    });
  };

  const setupEditors = (originalEditor: monaco.editor.IStandaloneCodeEditor, modifiedEditor: monaco.editor.IStandaloneCodeEditor) => {
    modifiedEditorRef.current = modifiedEditor;
    attachSideFeatures(originalEditor);
    attachSideFeatures(modifiedEditor);
    // The right side always shows the working-tree version of `diff.path`, which the selections' lines refer to.
    const chatMarkers = new SelectionChatMarkers(modifiedEditor, () => diff.path);
    chatMarkers.set(diff.path, selectionChatsRef.current);
    chatMarkersRef.current = chatMarkers;
    chatMarkers.onDidClickChat((chat) => onOpenSubChatRef.current({ selection: chat.selection, anchor: anchorBelowLine(modifiedEditor, chat.selection.startLine) }, chat.sessionId));
    const addCommentGlyph = isReviewRef.current ? new AddCommentGlyph(modifiedEditor, () => diff.path, (span) => isInsideHunk(blocksRef.current, span.startLine, span.line)) : null;
    addCommentGlyph?.onDidClick((span) => setComposer(span));
    setModifiedEditor(modifiedEditor);
    modifiedEditor.onDidDispose(() => {
      chatMarkers.dispose();
      if (chatMarkersRef.current === chatMarkers) {
        chatMarkersRef.current = null;
      }
      addCommentGlyph?.dispose();
      setModifiedEditor((current) => (current === modifiedEditor ? null : current));
    });
    modifiedEditor.onDidChangeModelContent(() => {
      onDirtyChangeRef.current(modifiedEditor.getValue() !== savedContentRef.current);
    });
    modifiedEditor.addAction({
      id: "hunt.save",
      label: "Save file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => onSaveRef.current(modifiedEditor.getValue()),
    });
  };

  const unifiedOptions = useMemo<monaco.editor.IDiffEditorConstructionOptions>(
    () => ({
      ...EDITOR_APPEARANCE_OPTIONS,
      fontSize,
      lineHeight,
      fontFamily,
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false,
      readOnly: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      glyphMargin: true,
      lineNumbersMinChars: 2,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
      diffAlgorithm: "advanced",
      automaticLayout: true,
      links: false,
      dragAndDrop: false,
    }),
    [fontSize, lineHeight, fontFamily],
  );

  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const handleUnifiedMount: DiffOnMount = (diffEditor) => {
    diffEditorRef.current = diffEditor;
    // The standalone diff editor builds both sides as standalone editors; only its typing hides the actions API of the left one.
    setupEditors(diffEditor.getOriginalEditor() as monaco.editor.IStandaloneCodeEditor, diffEditor.getModifiedEditor());
  };

  const language = monacoLanguage(diff.path);
  const reviewZones =
    pullRequest && modifiedEditor ? (
      <ReviewCommentZones editor={modifiedEditor} sessionId={sessionId} path={diff.path} blocks={blocks} composer={composer} onCloseComposer={() => setComposer(null)} />
    ) : null;

  if (mode === "split") {
    return (
      <>
        <SplitDiffView original={diff.oldContent ?? ""} modified={modifiedValue} language={language} fontSize={fontSize} lineHeight={lineHeight} fontFamily={fontFamily} onEditorsCreated={setupEditors} />
        {reviewZones}
      </>
    );
  }

  return (
    <UnifiedDiffView diffEditorRef={diffEditorRef}>
      <DiffEditor
        original={diff.oldContent ?? ""}
        modified={modifiedValue}
        language={language}
        theme={MONACO_THEME}
        options={unifiedOptions}
        onMount={handleUnifiedMount}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        loading={<span className="text-[13px] text-neutral-500">Loading editor…</span>}
        wrapperProps={{ className: "absolute inset-0" }}
      />
      {reviewZones}
    </UnifiedDiffView>
  );
}

/**
 * Detaches and disposes the diff models before `DiffEditor` disposes the widget on unmount. The library would
 * dispose the models first, which Monaco rejects ("TextModel got disposed before DiffEditorWidget model got reset").
 */
function UnifiedDiffView({ diffEditorRef, children }: { diffEditorRef: RefObject<monaco.editor.IStandaloneDiffEditor | null>; children: ReactNode }) {
  useEffect(
    () => () => {
      const diffEditor = diffEditorRef.current;
      const model = diffEditor?.getModel();
      if (!diffEditor || !model) return;
      diffEditor.setModel(null);
      model.original.dispose();
      model.modified.dispose();
    },
    [diffEditorRef],
  );
  return children;
}
