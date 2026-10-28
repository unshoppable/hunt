import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { FileDiff } from "./diff.types";
import { attachIdeLink } from "../editor/ide-link.monaco";
import { COMPLETION_OPTIONS, EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, SCROLL_TRACK_OPTIONS, changeMark } from "../editor/monaco.constants";
import { monacoLanguage } from "../editor/language-id.utils";
import { onShortcut } from "../editor/shortcuts.monaco";
import { setupMonaco } from "../editor/setup.monaco";
import { anchorBelowLine, type SelectionRequest } from "../editor/selection-request.monaco";
import { workspaceFor } from "../ide/documents/documents.service";
import { findUsages, navigationAt, type RenameTarget } from "../ide/language/language-service.utils";
import { attachRefactorings } from "../ide/language/refactorings.monaco";
import { RenameDialog } from "../ide/language/RenameDialog";
import { isUsagesPopupInApp, UsagesPopup, type UsagesQuery } from "../ide/language/UsagesPopover";
import type { Usage } from "../ide/language/usages.utils";
import { attachSelectionAgent } from "../ide/selection/selection-agent.monaco";
import { SelectionChatMarkers } from "../ide/selection/selection-chat-markers.monaco";
import { useBusyChatIds, useSelectionChats, useUnseenChatIds } from "../ide/selection/selection-chats.hook";
import { computeChangeBlocks, mapLine, type Side } from "../editor/line-diff.utils";
import { AddCommentGlyph, type CommentTarget } from "../review/add-comment-glyph.monaco";
import { ReviewCommentZones } from "../review/ReviewCommentZones";
import { LineSpan } from "../review/line-span.value-object";
import { useReviewedPullRequest } from "../review/review-comments.hook";
import { useHuntStore } from "../sessions/hunt.store";
import { SplitDiffView } from "./SplitDiffView";
import { OverwriteMarkers, type OverwriteMark } from "./overwrite-markers.monaco";
import { WORKTREE_LOCKED_MESSAGE } from "../sessions/remote/remote-session.utils";
import { errorText } from "../ui/error-text.utils";

setupMonaco();

/**
 * Width of the unified diff's column of "+" and "-": Monaco's 10px plus 8px on their left for the review bar (see
 * `.hunt-code-diff .insert-sign` in index.css).
 */
const DECORATIONS_WIDTH = 18;

export type CodeDiffEditorHandle = {
  /** Scrolls to the top and opens the box for a review comment on the whole file there; only in a pull request review. */
  commentOnFile: () => void;
  /** Saves the editable side like ⌘S in it; returns false when the diff has none (read-only or detached). */
  save: () => boolean;
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
  /**
   * Lines of a `readOnly` right side that another session overwrote on disk since (see `ownView`); each run gets the mark
   * of that session in the glyph margin, whose hover shows the lines on disk.
   */
  overwrites?: OverwriteMark[];
  /** Called with the current editor content on ⌘S; the host saves every other file with unsaved edits too (`DocumentWorkspace.saveAll`). */
  onSave: (content: string) => void;
  /** Reports whether the editor content differs from `diff.newContent`. */
  onDirtyChange: (isDirty: boolean) => void;
  /**
   * Called on ⌘click on a name in either side (go to its declaration) with the name and its 1-based position in the
   * saved right side (`diff.newContent`); a click on a changed line of the left side reports the nearest line of the
   * right side, and the receiver locates the name from there (see `resolveDefinition` in ide/language/language-service.utils.ts).
   */
  onNavigate: (line: number, column: number, name: string) => void;
  /** Called with the clicked 1-based position on ⇧⌘click in either side (open in WebStorm). */
  onOpenInIde: (line: number, column: number) => void;
  /** Called with the usage picked in the usages popup of a declaration ⌘clicked in the editable right side. */
  onOpenUsage: (usage: Usage) => void;
  /** Called with the reason a rename, reformat or usages search of the right side failed, and with null when one starts. */
  onError: (message: string | null) => void;
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
 * is the committed version and read-only. The editable side shows the worktree document of the file (see
 * ide/documents/documents.service.ts), shared with the editor tab and served by the language server: completion, hover, signature help
 * and diagnostics while typing, and unsaved edits that show in both. `diff.newContent` is the saved state: changing it
 * (after a save or an external reload) replaces the text and resets the dirty flag. Switching the mode keeps unsaved
 * edits. Sub chats opened from lines of
 * the file get a glyph on their first line in the right side's gutter; a click on it reopens the chat. Both sides
 * offer the agent features of the editor panes: the context menu entry and the floating button on a selection (a
 * selection on the left side hands over the committed lines). The editable side also offers the language features of
 * the editor panes: ⌘click on a declaration opens its usages popup, ⌘Ü or "Rename…" in the context menu the Rename
 * dialog, ⌘G removes unused imports and formats the file.
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
  overwrites,
  onSave,
  onDirtyChange,
  onNavigate,
  onOpenInIde,
  onOpenUsage,
  onError,
  onOpenSubChat,
  onToggleSubChat,
  onLineNumbersLeftChange,
}: CodeDiffEditorProps) {
  const modifiedEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const chatMarkersRef = useRef<SelectionChatMarkers[]>([]);
  const selectionChats = useSelectionChats(sessionId, diff.path);
  const busyChatIds = useBusyChatIds();
  const unseenChatIds = useUnseenChatIds();
  /** The editable right side once it exists; the review comment zones render into it. */
  const [modifiedEditor, setModifiedEditor] = useState<monaco.editor.ICodeEditor | null>(null);
  const worktreePath = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId)?.worktreePath);
  const pullRequest = useReviewedPullRequest(sessionId);
  const isReviewRef = useRef(!!pullRequest);
  isReviewRef.current = !!pullRequest;
  /** Lines a review comment is being written for and the line its box sits under. */
  const [composer, setComposer] = useState<CommentTarget | null>(null);
  /** Declaration whose usages popup is open, with the side editor it was ⌘clicked in. */
  const [usagesQuery, setUsagesQuery] = useState<{ editor: monaco.editor.IStandaloneCodeEditor; query: UsagesQuery } | null>(null);
  /** Symbol whose Rename dialog is open, with the model it was started in. */
  const [renameQuery, setRenameQuery] = useState<{ model: monaco.editor.ITextModel; target: RenameTarget } | null>(null);
  /** Change blocks of the saved state, which decide whether a review comment on a line is posted inline. */
  const blocks = useMemo(() => computeChangeBlocks(diff.oldContent ?? "", diff.newContent ?? ""), [diff.oldContent, diff.newContent]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const savedContentRef = useRef(diff.newContent ?? "");
  const onSaveRef = useRef(onSave);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onNavigateRef = useRef(onNavigate);
  const onOpenInIdeRef = useRef(onOpenInIde);
  const onOpenUsageRef = useRef(onOpenUsage);
  const onErrorRef = useRef(onError);
  const onOpenSubChatRef = useRef(onOpenSubChat);
  const onToggleSubChatRef = useRef(onToggleSubChat);
  const onLineNumbersLeftChangeRef = useRef(onLineNumbersLeftChange);
  onSaveRef.current = onSave;
  onDirtyChangeRef.current = onDirtyChange;
  onNavigateRef.current = onNavigate;
  onOpenInIdeRef.current = onOpenInIde;
  onOpenUsageRef.current = onOpenUsage;
  onErrorRef.current = onError;
  onOpenSubChatRef.current = onOpenSubChat;
  onToggleSubChatRef.current = onToggleSubChat;
  onLineNumbersLeftChangeRef.current = onLineNumbersLeftChange;
  const selectionChatsRef = useRef(selectionChats);
  selectionChatsRef.current = selectionChats;
  const busyChatIdsRef = useRef(busyChatIds);
  busyChatIdsRef.current = busyChatIds;
  const unseenChatIdsRef = useRef(unseenChatIds);
  unseenChatIdsRef.current = unseenChatIds;
  const overwritesRef = useRef(overwrites);
  overwritesRef.current = overwrites;
  const overwriteMarkersRef = useRef<OverwriteMarkers | null>(null);

  /**
   * The worktree document the editable side shows. Read-only and detached diffs, whose right side need not be the file,
   * and deleted files keep a model of their own.
   */
  const [shared] = useState(() => {
    if (readOnly || isDetached || !worktreePath || diff.newContent === null) return null;
    const workspace = workspaceFor(sessionId, worktreePath);
    return { workspace, document: workspace.documentFor(diff.path, diff.newContent) };
  });
  /** Text the editable editor starts with; carried over when the mode switches so unsaved edits survive. */
  const [modifiedValue, setModifiedValue] = useState(shared?.document.model.getValue() ?? diff.newContent ?? "");
  /** The saved content last handed to the editor; the first one is in it already, along with a document's unsaved edits. */
  const appliedContentRef = useRef(diff.newContent);
  const [previousMode, setPreviousMode] = useState(mode);
  if (previousMode !== mode) {
    setPreviousMode(mode);
    setComposer(null);
    if (isUsagesPopupInApp()) {
      setUsagesQuery(null);
    }
    const liveContent = modifiedEditorRef.current?.getValue();
    if (liveContent !== undefined && liveContent !== modifiedValue) {
      setModifiedValue(liveContent);
    }
  }

  useImperativeHandle(ref, () => ({
    commentOnFile: () => {
      const editor = modifiedEditorRef.current;
      if (readOnly || !isReviewRef.current || !editor) return;
      editor.setScrollTop(0);
      setComposer({ span: LineSpan.FILE, underLine: 0 });
    },
    save: () => {
      const editor = modifiedEditorRef.current;
      if (readOnly || isDetached || !editor) return false;
      onSaveRef.current(editor.getValue());
      return true;
    },
  }));

  useEffect(() => {
    for (const chatMarkers of chatMarkersRef.current) {
      chatMarkers.set(diff.path, selectionChats, busyChatIds, unseenChatIds);
    }
  }, [diff.path, selectionChats, busyChatIds, unseenChatIds]);

  useEffect(() => {
    overwriteMarkersRef.current?.set(overwrites ?? []);
  }, [overwrites]);

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
    if (appliedContentRef.current !== diff.newContent) {
      appliedContentRef.current = diff.newContent;
      setModifiedValue(diff.newContent ?? "");
    }
    const current = modifiedEditorRef.current?.getValue();
    if (current !== undefined) {
      onDirtyChangeRef.current(current !== savedContentRef.current);
    }
  }, [diff.newContent]);

  // The shared document counts as saved once it holds the saved content. The editors take a new `modifiedValue` in
  // their own effects, which run before this one, so it runs again after that.
  useEffect(() => {
    shared?.workspace.markSaved(diff.path, diff.newContent ?? "");
  }, [shared, diff.path, diff.newContent, modifiedValue]);

  // Keeps the worktree document at the saved content after saves here and changes by agents.
  useEffect(() => {
    if (readOnly || !worktreePath) return;
    void workspaceFor(sessionId, worktreePath).reloadFromDisk([diff.path]);
  }, [readOnly, sessionId, worktreePath, diff.path, diff.newContent]);

  /**
   * ⌘click on a name reports it to `onNavigate`, on a declaration in the worktree document it opens the usages popup
   * instead; ⇧⌘click opens the position in WebStorm (Monaco's own go-to-definition stays off). The context menu and
   * the floating selection button hand a selection to the agent, and the worktree document gets the refactorings.
   */
  const attachSideFeatures = (sideEditor: monaco.editor.IStandaloneCodeEditor, side: Side) => {
    const link = attachIdeLink(sideEditor, {
      onNavigate: (line, column) => {
        const model = sideEditor.getModel();
        const position = { lineNumber: line, column };
        const name = model?.getWordAtPosition(position)?.word;
        if (!model || !name) return;
        const savedLine = side === "modified" ? line : Math.max(1, Math.round(mapLine(blocksRef.current, "original", line)));
        const navigate = () => onNavigateRef.current(savedLine, column, name);
        if (!shared || model !== shared.document.model) {
          navigate();
          return;
        }
        navigationAt(model, position)
          .catch(() => null)
          .then((navigation) => {
            if (sideEditor.getModel() !== model) return;
            if (navigation?.type !== "declaration") {
              navigate();
              return;
            }
            const query: UsagesQuery = { declaration: navigation.declaration, path: diff.path, anchor: position, usages: null, isComplete: false };
            const isShown = (shown: { query: UsagesQuery } | null) => shown?.query.declaration === query.declaration;
            setUsagesQuery({ editor: sideEditor, query });
            findUsages(shared.workspace, model, position, (usages, isComplete) =>
              setUsagesQuery((shown) => (shown && isShown(shown) ? { ...shown, query: { ...query, usages, isComplete } } : shown)),
            ).catch((reason) => {
              setUsagesQuery((shown) => (isShown(shown) ? null : shown));
              onErrorRef.current(errorText(reason));
            });
          });
      },
      onOpenInIde: (line, column) => onOpenInIdeRef.current(line, column),
    });
    const refactorings =
      shared && side === "modified"
        ? attachRefactorings(sideEditor, {
            fileOf: (model) => (model === shared.document.model ? { sessionId, path: diff.path } : null),
            onRename: (model, target) => setRenameQuery({ model, target }),
            onError: (message) => onErrorRef.current(message),
          })
        : null;
    const withSide = (request: SelectionRequest): SelectionRequest =>
      side === "original" ? { ...request, selection: { ...request.selection, isOriginal: true } } : request;
    const agent = onOpenSubChatRef.current
      ? attachSelectionAgent(sideEditor, {
          pathOf: () => diff.path,
          onOpen: (request) => onOpenSubChatRef.current?.(withSide(request)),
          onToggle: (request) => onToggleSubChatRef.current?.(withSide(request)),
        })
      : null;
    sideEditor.onDidDispose(() => {
      link.dispose();
      refactorings?.dispose();
      agent?.dispose();
    });
  };

  /** Sub chat buttons in the gutter of `sideEditor` for the selections made on `side`; a click reopens the chat. */
  const attachChatMarkers = (sideEditor: monaco.editor.ICodeEditor, side: Side) => {
    const chatMarkers = new SelectionChatMarkers(sideEditor, () => diff.path, side);
    chatMarkers.set(diff.path, selectionChatsRef.current, busyChatIdsRef.current, unseenChatIdsRef.current);
    chatMarkersRef.current = [...chatMarkersRef.current, chatMarkers];
    chatMarkers.onDidClickChat((chat) =>
      onOpenSubChatRef.current?.({ selection: chat.selection, anchor: anchorBelowLine(sideEditor, chat.selection.startLine) }, chat.sessionId),
    );
    sideEditor.onDidDispose(() => {
      chatMarkers.dispose();
      chatMarkersRef.current = chatMarkersRef.current.filter((current) => current !== chatMarkers);
    });
  };

  const setupEditors = (originalEditor: monaco.editor.IStandaloneCodeEditor, modifiedEditor: monaco.editor.IStandaloneCodeEditor) => {
    modifiedEditorRef.current = modifiedEditor;
    const overwriteMarkers = new OverwriteMarkers(modifiedEditor);
    overwriteMarkers.set(overwritesRef.current ?? []);
    overwriteMarkersRef.current = overwriteMarkers;
    modifiedEditor.onDidDispose(() => {
      overwriteMarkers.dispose();
      if (overwriteMarkersRef.current === overwriteMarkers) {
        overwriteMarkersRef.current = null;
      }
    });
    if (isDetached) return;
    attachSideFeatures(originalEditor, "original");
    if (readOnly) return;
    attachSideFeatures(modifiedEditor, "modified");
    // The right side always shows the working-tree version of `diff.path`, the left one the version it is compared
    // against. The inline diff shows the left side's lines only as zones without a gutter, so it has no buttons for them.
    attachChatMarkers(modifiedEditor, "modified");
    if (mode === "split") {
      attachChatMarkers(originalEditor, "original");
    }
    const addCommentGlyph = isReviewRef.current ? new AddCommentGlyph(modifiedEditor, () => diff.path, (span) => span.isInsideHunk(blocksRef.current)) : null;
    addCommentGlyph?.onDidClick((target) => setComposer(target));
    setModifiedEditor(modifiedEditor);
    modifiedEditor.onDidDispose(() => {
      addCommentGlyph?.dispose();
      setModifiedEditor((current) => (current === modifiedEditor ? null : current));
    });
    const reportDirty = () => onDirtyChangeRef.current(modifiedEditor.getValue() !== savedContentRef.current);
    modifiedEditor.onDidChangeModelContent(reportDirty);
    modifiedEditor.onDidChangeModelContent(() => {
      if (isUsagesPopupInApp()) {
        setUsagesQuery(null);
      }
    });
    // A shared document may come with unsaved edits from the editor tab.
    reportDirty();
    onShortcut(modifiedEditor, "editor.save", () => onSaveRef.current(modifiedEditor.getValue()));
  };

  const unifiedOptions = useMemo<monaco.editor.IDiffEditorConstructionOptions>(
    () => ({
      ...EDITOR_APPEARANCE_OPTIONS,
      ...SCROLL_TRACK_OPTIONS,
      ...COMPLETION_OPTIONS,
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
      lineDecorationsWidth: DECORATIONS_WIDTH,
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
  const overlays = (
    <>
      {pullRequest && modifiedEditor ? (
        <ReviewCommentZones editor={modifiedEditor} sessionId={sessionId} path={diff.path} blocks={blocks} composer={composer} onCloseComposer={() => setComposer(null)} />
      ) : null}
      {usagesQuery && shared ? (
        <UsagesPopup
          editor={usagesQuery.editor}
          workspace={shared.workspace}
          query={usagesQuery.query}
          onOpen={(usage) => onOpenUsageRef.current(usage)}
          onClose={() => setUsagesQuery(null)}
        />
      ) : null}
      {renameQuery && shared ? (
        <RenameDialog
          workspace={shared.workspace}
          model={renameQuery.model}
          target={renameQuery.target}
          onClose={() => {
            setRenameQuery(null);
            modifiedEditorRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );

  if (mode === "split") {
    return (
      <>
        <SplitDiffView
          original={diff.oldContent ?? ""}
          modified={modifiedValue}
          modifiedModel={shared?.document.model}
          language={language}
          fontSize={fontSize}
          lineHeight={lineHeight}
          fontFamily={fontFamily}
          readOnly={readOnly}
          collapseUnchanged={collapseUnchanged}
          onEditorsCreated={setupEditors}
        />
        {overlays}
      </>
    );
  }

  return (
    <UnifiedDiffView diffEditorRef={diffEditorRef} keepsModifiedModel={!!shared}>
      <DiffEditor
        original={diff.oldContent ?? ""}
        modified={modifiedValue}
        modifiedModelPath={shared?.document.model.uri.toString()}
        language={language}
        theme={MONACO_THEME}
        options={unifiedOptions}
        onMount={handleUnifiedMount}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        loading={<span className="text-[13px] text-neutral-500">Loading editor…</span>}
        wrapperProps={{ className: "absolute inset-0 hunt-code-diff" }}
      />
      {overlays}
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
 * With `keepsModifiedModel` the right side's model is a worktree document that outlives the view.
 */
function UnifiedDiffView({
  diffEditorRef,
  keepsModifiedModel,
  children,
}: {
  diffEditorRef: RefObject<monaco.editor.IStandaloneDiffEditor | null>;
  keepsModifiedModel: boolean;
  children: ReactNode;
}) {
  useEffect(
    () => () => {
      const diffEditor = diffEditorRef.current;
      diffEditorRef.current = null;
      const model = diffEditor?.getModel();
      if (!diffEditor || !model) return;
      diffEditor.setModel(null);
      model.original.dispose();
      if (!keepsModifiedModel) {
        model.modified.dispose();
      }
    },
    [diffEditorRef, keepsModifiedModel],
  );
  return children;
}
