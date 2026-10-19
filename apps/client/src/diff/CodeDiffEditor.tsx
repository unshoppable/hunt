import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { FileDiff } from "../ipc/types";
import { attachIdeLink } from "./ideLink";
import { EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, SCROLL_TRACK_OPTIONS, changeMark, monacoLanguage, onShortcut, setupMonaco } from "./monaco";
import { mirrorDiagnostics } from "./diagnostics";
import { anchorBelowLine, type SelectionRequest } from "./selectionContext";
import { workspaceFor } from "../ide/documents";
import { attachSelectionAgent } from "../ide/selectionAgent";
import { SelectionChatMarkers } from "../ide/selectionChatMarkers";
import { useBusyChatIds, useSelectionChats } from "../ide/selectionChats";
import { computeChangeBlocks, mapLine, type Side } from "./lineDiff";
import { AddCommentGlyph, type CommentTarget } from "../review/addCommentGlyph";
import { ReviewCommentZones } from "../review/ReviewCommentZones";
import { FILE_SPAN, isInsideHunk, useReviewedPullRequest } from "../review/reviewComments";
import { useHuntStore } from "../state/store";
import { SplitDiffView } from "./SplitDiffView";
import { WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";

setupMonaco();

export type CodeDiffEditorHandle = {
  /** Saves the current editor content, same as Cmd/Ctrl+S inside the editor. */
  save: () => void;
  /** Scrolls to the top and opens the box for a review comment on the whole file there; only in a pull request review. */
  commentOnFile: () => void;
};

type CodeDiffEditorProps = {
  ref?: Ref<CodeDiffEditorHandle>;
  /** The session whose worktree `diff` belongs to; its sub chats about lines of the file get a glyph in the gutter. */
  sessionId: string;
  diff: FileDiff;
  mode: "split" | "unified";
  /**
   * Collapses every unchanged stretch into a hidden-lines bar; false expands them all. Either way single stretches
   * expand on a click on their bar and collapse again on their fold glyph.
   */
  collapseUnchanged: boolean;
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** CSS font family of the code. */
  fontFamily: string;
  /**
   * Shows the diff without editing, saving or reverting. `diff.newContent` then need not be the file on disk, so the
   * right side has no sub chat glyphs, review comments, editor links or selection agent; the left side keeps them.
   */
  readOnly?: boolean;
  /**
   * The diff belongs to no local worktree (a remote session's changes on its VM): neither side gets editor links, the
   * selection agent or sub chats. Use together with `readOnly`.
   */
  isDetached?: boolean;
  /**
   * The worktree may not change right now (see `isWorktreeLocked`): the right side cannot be edited until it may again,
   * and keeps its features and unsaved edits meanwhile.
   */
  isLocked?: boolean;
  /** Called with the current editor content on Cmd/Ctrl+S. */
  onSave: (content: string) => void;
  /** Reports whether the editor content differs from `diff.newContent`. */
  onDirtyChange: (isDirty: boolean) => void;
  /**
   * Called on ⌘click on a name in either side (go to its declaration) with the name and its 1-based position in the
   * saved right side (`diff.newContent`); a click on a changed line of the left side reports the nearest line of the
   * right side, and the receiver locates the name from there (see `resolveDefinition` in ide/languageService.ts).
   */
  onNavigate: (line: number, column: number, name: string) => void;
  /** Called with the clicked 1-based position on ⇧⌘click in either side (open in WebStorm). */
  onOpenInIde: (line: number, column: number) => void;
  /**
   * Opens the sub chat popover: from either side's context menu ("Ask Claude about selection") with the selected
   * lines, or from a click on a sub chat's gutter glyph with that sub session (`subSessionId`). Without it the editor
   * offers no sub chat.
   */
  onOpenSubChat?: (request: SelectionRequest, subSessionId?: string) => void;
  /** Opens or closes the sub chat popover from the floating button at the end of a selection on either side. */
  onToggleSubChat?: (request: SelectionRequest) => void;
  /**
   * Reports the client x of the left edge of the editable right side's line numbers in split mode, again whenever
   * its layout changes, and null in unified mode or without an editable side; hosts line header content up with it.
   */
  onLineNumbersLeftChange?: (clientX: number | null) => void;
};

/**
 * Side-by-side (WebStorm-style, see SplitDiffView) or inline diff whose right side is editable; the left side
 * is the committed version and read-only. `diff.newContent` is the saved state: changing it (after a save or an
 * external reload) resets the dirty flag. Switching the mode keeps unsaved edits. Sub chats opened from lines of
 * the file get a glyph on their first line in the right side's gutter; a click on it reopens the chat. Both sides
 * offer the agent features of the editor panes: the context menu entry and the floating button on a selection (a
 * selection on the left side hands over the committed lines).
 */
export function CodeDiffEditor({
  ref,
  sessionId,
  diff,
  mode,
  collapseUnchanged,
  fontSize,
  lineHeight,
  fontFamily,
  readOnly = false,
  isDetached = false,
  isLocked = false,
  onSave,
  onDirtyChange,
  onNavigate,
  onOpenInIde,
  onOpenSubChat,
  onToggleSubChat,
  onLineNumbersLeftChange,
}: CodeDiffEditorProps) {
  const modifiedEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const chatMarkersRef = useRef<SelectionChatMarkers | null>(null);
  const selectionChats = useSelectionChats(sessionId, diff.path);
  const busyChatIds = useBusyChatIds();
  /** The editable right side once it exists; the review comment zones render into it. */
  const [modifiedEditor, setModifiedEditor] = useState<monaco.editor.ICodeEditor | null>(null);
  const worktreePath = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId)?.worktreePath);
  const pullRequest = useReviewedPullRequest(sessionId);
  const isReviewRef = useRef(!!pullRequest);
  isReviewRef.current = !!pullRequest;
  /** Lines a review comment is being written for and the line its box sits under. */
  const [composer, setComposer] = useState<CommentTarget | null>(null);
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
  const onLineNumbersLeftChangeRef = useRef(onLineNumbersLeftChange);
  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;
  onNavigateRef.current = onNavigate;
  onOpenInIdeRef.current = onOpenInIde;
  onOpenSubChatRef.current = onOpenSubChat;
  onToggleSubChatRef.current = onToggleSubChat;
  onLineNumbersLeftChangeRef.current = onLineNumbersLeftChange;
  const selectionChatsRef = useRef(selectionChats);
  selectionChatsRef.current = selectionChats;
  const busyChatIdsRef = useRef(busyChatIds);
  busyChatIdsRef.current = busyChatIds;

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
      if (readOnly) return;
      const content = modifiedEditorRef.current?.getValue();
      if (content !== undefined) {
        onSaveRef.current(content);
      }
    },
    commentOnFile: () => {
      const editor = modifiedEditorRef.current;
      if (readOnly || !isReviewRef.current || !editor) return;
      editor.setScrollTop(0);
      setComposer({ span: FILE_SPAN, underLine: 0 });
    },
  }));

  useEffect(() => {
    chatMarkersRef.current?.set(diff.path, selectionChats, busyChatIds);
  }, [diff.path, selectionChats, busyChatIds]);

  // Reports where the right side's line numbers start. Right after a mode switch `modifiedEditor` may still be the
  // disposed editor of the other mode, whose node is detached.
  useEffect(() => {
    if (mode !== "split" || !modifiedEditor) {
      onLineNumbersLeftChangeRef.current?.(null);
      return;
    }
    const container = modifiedEditor.getContainerDomNode();
    const report = () => {
      if (!container.isConnected) return;
      onLineNumbersLeftChangeRef.current?.(container.getBoundingClientRect().left + modifiedEditor.getLayoutInfo().lineNumbersLeft);
    };
    report();
    const subscription = modifiedEditor.onDidLayoutChange(report);
    return () => subscription.dispose();
  }, [mode, modifiedEditor]);

  useEffect(() => {
    savedContentRef.current = diff.newContent ?? "";
    setModifiedValue(diff.newContent ?? "");
    const current = modifiedEditorRef.current?.getValue();
    if (current !== undefined) {
      onDirtyChangeRef.current(current !== savedContentRef.current);
    }
  }, [diff.newContent]);

  // The editable side shows the diagnostics of the file as saved, which the workspace document holds (see diagnostics.ts).
  useEffect(() => {
    if (!modifiedEditor || !worktreePath) return;
    const diagnostics = mirrorDiagnostics(modifiedEditor, workspaceFor(sessionId, worktreePath), diff.path);
    return () => diagnostics.dispose();
  }, [modifiedEditor, sessionId, worktreePath, diff.path]);

  // Keeps that document at the saved content after saves here and changes by agents.
  useEffect(() => {
    if (readOnly || !worktreePath) return;
    void workspaceFor(sessionId, worktreePath).reloadFromDisk([diff.path]);
  }, [readOnly, sessionId, worktreePath, diff.path, diff.newContent]);

  /**
   * ⌘click on a name reports it to `onNavigate`, ⇧⌘click opens the position in WebStorm (Monaco's own
   * go-to-definition stays off); the context menu and the floating selection button hand a selection to the agent.
   */
  const attachSideFeatures = (sideEditor: monaco.editor.IStandaloneCodeEditor, side: Side) => {
    const link = attachIdeLink(sideEditor, {
      onNavigate: (line, column) => {
        const name = sideEditor.getModel()?.getWordAtPosition({ lineNumber: line, column })?.word;
        if (!name) return;
        const savedLine = side === "modified" ? line : Math.max(1, Math.round(mapLine(blocksRef.current, "original", line)));
        onNavigateRef.current(savedLine, column, name);
      },
      onOpenInIde: (line, column) => onOpenInIdeRef.current(line, column),
    });
    const agent = onOpenSubChatRef.current
      ? attachSelectionAgent(sideEditor, {
          pathOf: () => diff.path,
          onOpen: (request) => onOpenSubChatRef.current?.(request),
          onToggle: (request) => onToggleSubChatRef.current?.(request),
        })
      : null;
    sideEditor.onDidDispose(() => {
      link.dispose();
      agent?.dispose();
    });
  };

  const setupEditors = (originalEditor: monaco.editor.IStandaloneCodeEditor, modifiedEditor: monaco.editor.IStandaloneCodeEditor) => {
    modifiedEditorRef.current = modifiedEditor;
    if (isDetached) return;
    attachSideFeatures(originalEditor, "original");
    if (readOnly) return;
    attachSideFeatures(modifiedEditor, "modified");
    // The right side always shows the working-tree version of `diff.path`, which the selections' lines refer to.
    const chatMarkers = new SelectionChatMarkers(modifiedEditor, () => diff.path);
    chatMarkers.set(diff.path, selectionChatsRef.current, busyChatIdsRef.current);
    chatMarkersRef.current = chatMarkers;
    chatMarkers.onDidClickChat((chat) =>
      onOpenSubChatRef.current?.({ selection: chat.selection, anchor: anchorBelowLine(modifiedEditor, chat.selection.startLine) }, chat.sessionId),
    );
    const addCommentGlyph = isReviewRef.current ? new AddCommentGlyph(modifiedEditor, () => diff.path, (span) => isInsideHunk(blocksRef.current, span.startLine, span.line)) : null;
    addCommentGlyph?.onDidClick((target) => setComposer(target));
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
    onShortcut(modifiedEditor, "editor.save", () => onSaveRef.current(modifiedEditor.getValue()));
  };

  const unifiedOptions = useMemo<monaco.editor.IDiffEditorConstructionOptions>(
    () => ({
      ...EDITOR_APPEARANCE_OPTIONS,
      ...SCROLL_TRACK_OPTIONS,
      fontSize,
      lineHeight,
      fontFamily,
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false,
      readOnly: readOnly || isLocked,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      glyphMargin: true,
      lineNumbersMinChars: 2,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
      stickyScroll: { enabled: false },
      diffAlgorithm: "advanced",
      automaticLayout: true,
      links: false,
      dragAndDrop: false,
    }),
    [fontSize, lineHeight, fontFamily, readOnly, isLocked],
  );

  useEffect(() => {
    modifiedEditor?.updateOptions({ readOnly: isLocked, readOnlyMessage: { value: WORKTREE_LOCKED_MESSAGE } });
  }, [modifiedEditor, isLocked]);

  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const collapseUnchangedRef = useRef(collapseUnchanged);
  collapseUnchangedRef.current = collapseUnchanged;
  const handleUnifiedMount: DiffOnMount = (diffEditor) => {
    diffEditorRef.current = diffEditor;
    // Monaco always starts with collapsed stretches; they exist once the first diff is computed and keep their
    // state through later diffs.
    const firstDiff = diffEditor.onDidUpdateDiff(() => {
      firstDiff.dispose();
      setUnchangedRegionsCollapsed(diffEditor, collapseUnchangedRef.current);
    });
    const changeMarks = diffEditor.getModifiedEditor().createDecorationsCollection();
    diffEditor.onDidUpdateDiff(() => changeMarks.set((diffEditor.getLineChanges() ?? []).map(lineChangeMark)));
    // The standalone diff editor builds both sides as standalone editors; only its typing hides the actions API of the left one.
    setupEditors(diffEditor.getOriginalEditor() as monaco.editor.IStandaloneCodeEditor, diffEditor.getModifiedEditor());
  };

  useEffect(() => {
    if (diffEditorRef.current) {
      setUnchangedRegionsCollapsed(diffEditorRef.current, collapseUnchanged);
    }
  }, [collapseUnchanged]);

  const language = monacoLanguage(diff.path);
  const reviewZones =
    pullRequest && modifiedEditor ? (
      <ReviewCommentZones editor={modifiedEditor} sessionId={sessionId} path={diff.path} blocks={blocks} composer={composer} onCloseComposer={() => setComposer(null)} />
    ) : null;

  if (mode === "split") {
    return (
      <>
        <SplitDiffView
          original={diff.oldContent ?? ""}
          modified={modifiedValue}
          language={language}
          fontSize={fontSize}
          lineHeight={lineHeight}
          fontFamily={fontFamily}
          readOnly={readOnly}
          collapseUnchanged={collapseUnchanged}
          onEditorsCreated={setupEditors}
        />
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

/** Monaco keeps these diff editor methods out of the public typings. */
type DiffEditorWithUnchangedRegions = monaco.editor.IStandaloneDiffEditor & { collapseAllUnchangedRegions(): void; showAllUnchangedRegions(): void };

/** Scroll track mark of a change in the inline diff; a deletion (no modified lines) is marked on the line above its seam. */
function lineChangeMark(change: monaco.editor.ILineChange): monaco.editor.IModelDeltaDecoration {
  if (!change.modifiedEndLineNumber) {
    const line = Math.max(1, change.modifiedStartLineNumber);
    return changeMark(line, line);
  }
  return changeMark(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
}

function setUnchangedRegionsCollapsed(diffEditor: monaco.editor.IStandaloneDiffEditor, isCollapsed: boolean): void {
  const editor = diffEditor as DiffEditorWithUnchangedRegions;
  if (isCollapsed) {
    editor.collapseAllUnchangedRegions();
  } else {
    editor.showAllUnchangedRegions();
  }
}

/**
 * Detaches and disposes the diff models before `DiffEditor` disposes the widget on unmount. The library would
 * dispose the models first, which Monaco rejects ("TextModel got disposed before DiffEditorWidget model got reset").
 */
function UnifiedDiffView({ diffEditorRef, children }: { diffEditorRef: RefObject<monaco.editor.IStandaloneDiffEditor | null>; children: ReactNode }) {
  useEffect(
    () => () => {
      const diffEditor = diffEditorRef.current;
      diffEditorRef.current = null;
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
