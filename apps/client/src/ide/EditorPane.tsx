import { useEffect, useRef, useState, type MouseEvent } from "react";
import * as monaco from "monaco-editor";
import { commands } from "../ipc/commands";
import { attachIdeLink } from "../diff/ideLink";
import { useFileIconUrl } from "../diff/fileIcons";
import { COMPLETION_OPTIONS, EDITOR_APPEARANCE_OPTIONS, MONACO_THEME, SCROLL_TRACK_OPTIONS, setupMonaco } from "../diff/monaco";
import { anchorBelowLine, type SelectionRequest } from "../diff/selectionContext";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { isWorktreeLocked, WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";
import { ChangeMarkers, type Marker } from "./changeMarkers";
import { ChangePopover } from "./ChangePopover";
import type { Workspace } from "./documents";
import { noteCaret, noteViewState, useIdeStore, viewStateOf, type PendingPosition } from "./ideStore";
import { findUsages, navigationAt, symbolPathAt, type RenameTarget, type SymbolCrumb } from "./languageService";
import type { Pane } from "./paneGrid";
import { attachRefactorings } from "./refactorings";
import { RenameDialog } from "./RenameDialog";
import type { ChangeBlock } from "../diff/lineDiff";
import { AddCommentGlyph, type CommentTarget } from "../review/addCommentGlyph";
import { ReviewCommentZones } from "../review/ReviewCommentZones";
import { isInsideHunk, useReviewedPullRequest } from "../review/reviewComments";
import { attachSelectionAgent } from "./selectionAgent";
import { SelectionChatMarkers } from "./selectionChatMarkers";
import { useBusyChatIds, useSelectionChats } from "./selectionChats";
import { UsagesPopover, type UsagesQuery } from "./UsagesPopover";
import type { Usage } from "./usages";
import { STATUS_BAR } from "../ui/bars";
import { CloseIcon } from "../ui/icons";
import { baseName } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";

const SYMBOL_PATH_DELAY_MS = 150;
/** The caret and scroll position are remembered once they rested this long. */
const VIEW_STATE_DELAY_MS = 300;
/** Empty space the editor can scroll past the last line, instead of Monaco's default of a whole viewport. */
const EDITOR_OVERSCROLL_PX = 400;

type EditorPaneProps = {
  sessionId: string;
  workspace: Workspace;
  pane: Pane;
  /** The pane keyboard shortcuts act on; its active tab is marked in the accent color. */
  isActive: boolean;
  dirtyPaths: readonly string[];
  pendingPosition: PendingPosition | null;
  /**
   * Opens the sub chat popover: from the context menu ("Ask Claude about selection") with the selected lines, or
   * from a click on a sub chat's gutter glyph with that sub session (`subSessionId`).
   */
  onOpenSubChat?: (request: SelectionRequest, subSessionId?: string) => void;
  /** Toggles the sub chat popover from the floating button at the end of a selection (see selectionAskButton.ts). */
  onToggleSubChat?: (request: SelectionRequest) => void;
};

/**
 * One editor group: a tab bar, a Monaco editor showing the active tab's model and a breadcrumb with the file path
 * and the declarations around the caret. ⌘click goes to the declaration (opened in this pane) or, on a declaration,
 * opens the usages popup; ⇧⌘click opens the position in WebStorm, ⌘G removes unused imports and formats
 * (see `reformat`), ⌘Ü or "Rename…" in the context menu opens the Rename dialog for the symbol at the caret, the
 * context menu offers "Ask Claude about selection" like the diff view. Lines that differ from HEAD get a change stripe next to the line numbers; a
 * click on it opens the popup with the old lines. A selection a sub chat was opened from gets a glyph left of its
 * first line number; a click on it reopens the sub chat in its popover. Releasing a selection shows a floating
 * button at its active end that toggles the popover for the selected lines.
 */
export function EditorPane({ sessionId, workspace, pane, isActive, dirtyPaths, pendingPosition, onOpenSubChat, onToggleSubChat }: EditorPaneProps) {
  const fileIconUrl = useFileIconUrl();
  const fontSize = useSettingsStore((state) => state.panes.editor.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.editor.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.editor.fontFamily);
  const openFile = useIdeStore((state) => state.openFile);
  const activatePane = useIdeStore((state) => state.activatePane);
  const activateTab = useIdeStore((state) => state.activateTab);
  const closeTab = useIdeStore((state) => state.closeTab);
  const clearPendingPosition = useIdeStore((state) => state.clearPendingPosition);
  const isLocked = useHuntStore((state) => isWorktreeLocked(state.sessions, state.remoteLinks, sessionId));

  const hostRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownPathRef = useRef<string | null>(null);
  const markersRef = useRef<ChangeMarkers | null>(null);
  const chatMarkersRef = useRef<SelectionChatMarkers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<SymbolCrumb[]>([]);
  /** Change marker whose popup is open. */
  const [shownMarker, setShownMarker] = useState<Marker | null>(null);
  const selectionChats = useSelectionChats(sessionId, pane.activePath);
  const busyChatIds = useBusyChatIds();
  /** Declaration whose usages popup is open. */
  const [usagesQuery, setUsagesQuery] = useState<UsagesQuery | null>(null);
  /** Symbol whose Rename dialog is open, with the model it was started in. */
  const [renameQuery, setRenameQuery] = useState<{ model: monaco.editor.ITextModel; target: RenameTarget } | null>(null);
  const pullRequest = useReviewedPullRequest(sessionId);
  /** The editor once created, for the components that render into it. */
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  /** Change blocks of the shown file against the diff base, as the change markers computed them. */
  const [blocks, setBlocks] = useState<ChangeBlock[]>([]);
  /** Lines a review comment is being written for and the line its box sits under. */
  const [composer, setComposer] = useState<CommentTarget | null>(null);

  const isReview = !!pullRequest;
  const latest = useRef({ sessionId, workspace, pane, isReview, openFile, activatePane, onOpenSubChat, onToggleSubChat });
  latest.current = { sessionId, workspace, pane, isReview, openFile, activatePane, onOpenSubChat, onToggleSubChat };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setupMonaco();
    const editor = monaco.editor.create(host, {
      ...EDITOR_APPEARANCE_OPTIONS,
      theme: MONACO_THEME,
      model: null,
      automaticLayout: true,
      glyphMargin: true,
      lineNumbersMinChars: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { bottom: EDITOR_OVERSCROLL_PX },
      ...SCROLL_TRACK_OPTIONS,
      renderLineHighlight: "line",
      scrollbar: { alwaysConsumeMouseWheel: false },
      links: false,
      dragAndDrop: false,
      ...COMPLETION_OPTIONS,
    });
    editorRef.current = editor;

    const refactorings = attachRefactorings(editor, {
      fileOf: (model) => {
        const { workspace: current, sessionId: id } = latest.current;
        const path = current.pathOf(model.uri);
        return path ? { sessionId: id, path } : null;
      },
      onRename: (model, target) => setRenameQuery({ model, target }),
      onError: setError,
    });

    const agent = latest.current.onOpenSubChat
      ? attachSelectionAgent(editor, {
          pathOf: (model) => latest.current.workspace.pathOf(model.uri),
          onOpen: (request) => latest.current.onOpenSubChat?.(request),
          onToggle: (request) => latest.current.onToggleSubChat?.(request),
        })
      : null;

    const link = attachIdeLink(editor, {
      onNavigate: (line, column) => {
        const model = editor.getModel();
        if (!model) return;
        const { workspace: current, sessionId: id, pane: currentPane, openFile: open } = latest.current;
        const position = { lineNumber: line, column };
        navigationAt(model, position)
          .then((navigation) => {
            if (!navigation || editor.getModel() !== model) return;
            if (navigation.type === "definition") {
              const path = current.pathOf(navigation.target.uri);
              if (!path) return;
              open(id, path, { paneId: currentPane.id, line: navigation.target.range.startLineNumber, column: navigation.target.range.startColumn });
              return;
            }
            const path = current.pathOf(model.uri);
            if (!path) return;
            const query: UsagesQuery = { declaration: navigation.declaration, path, anchor: position, usages: null };
            setUsagesQuery(query);
            findUsages(current, model, position)
              .then((usages) => setUsagesQuery((shown) => (shown === query ? { ...query, usages } : shown)))
              .catch((reason) => {
                setUsagesQuery((shown) => (shown === query ? null : shown));
                setError(String(reason));
              });
          })
          .catch(() => {});
      },
      onOpenInIde: (line, column) => {
        const { workspace: current, sessionId: id } = latest.current;
        const path = current.pathOf(editor.getModel()?.uri ?? monaco.Uri.parse("inmemory://none"));
        if (!path) return;
        commands.openFileInWebstorm(id, path, line, column).catch((reason) => setError(String(reason)));
      },
    });

    const markers = new ChangeMarkers(editor, (model) => {
      const { workspace: current } = latest.current;
      const path = current.pathOf(model.uri);
      return path ? current.headText(path) : Promise.resolve(null);
    });
    markersRef.current = markers;
    const chatMarkers = new SelectionChatMarkers(editor, (model) => latest.current.workspace.pathOf(model.uri));
    chatMarkersRef.current = chatMarkers;
    const addCommentGlyph = new AddCommentGlyph(
      editor,
      (model) => (latest.current.isReview ? latest.current.workspace.pathOf(model.uri) : null),
      (span) => isInsideHunk(markers.blocks, span.startLine, span.line),
    );
    setEditor(editor);

    let symbolTimer: ReturnType<typeof setTimeout> | null = null;
    let viewStateTimer: ReturnType<typeof setTimeout> | null = null;
    /** Remembers the shown file's caret, selection and scroll position, so the tab shows them again, also after a restart. */
    const saveViewState = () => {
      viewStateTimer = null;
      const shownPath = shownPathRef.current;
      if (shownPath) {
        noteViewState(latest.current.sessionId, latest.current.pane.id, shownPath, editor.saveViewState());
      }
    };
    const scheduleViewState = () => {
      if (viewStateTimer) {
        clearTimeout(viewStateTimer);
      }
      viewStateTimer = setTimeout(saveViewState, VIEW_STATE_DELAY_MS);
    };
    const subscriptions = [
      markers.onDidClickMarker((marker) => setShownMarker(marker)),
      markers.onDidChange(() => {
        setBlocks(markers.blocks);
        addCommentGlyph.refresh();
      }),
      chatMarkers.onDidClickChat((chat) =>
        latest.current.onOpenSubChat?.({ selection: chat.selection, anchor: anchorBelowLine(editor, chat.selection.startLine) }, chat.sessionId),
      ),
      addCommentGlyph.onDidClick((target) => setComposer(target)),
      editor.onDidChangeModelContent(() => {
        setShownMarker(null);
        setUsagesQuery(null);
      }),
      editor.onDidChangeModel(() => {
        setShownMarker(null);
        setUsagesQuery(null);
        setComposer(null);
      }),
      editor.onDidFocusEditorWidget(() => latest.current.activatePane(latest.current.sessionId, latest.current.pane.id)),
      editor.onDidScrollChange(scheduleViewState),
      editor.onDidChangeCursorPosition((event) => {
        scheduleViewState();
        const { workspace: current, sessionId: id, pane: currentPane } = latest.current;
        const caretPath = current.pathOf(editor.getModel()?.uri ?? monaco.Uri.parse("inmemory://none"));
        if (caretPath) {
          noteCaret(id, { paneId: currentPane.id, path: caretPath, line: event.position.lineNumber, column: event.position.column });
        }
        if (symbolTimer) {
          clearTimeout(symbolTimer);
        }
        symbolTimer = setTimeout(() => {
          const model = editor.getModel();
          if (!model) return;
          symbolPathAt(model, event.position)
            .then((path) => editor.getModel() === model && setCrumbs(path))
            .catch(() => {});
        }, SYMBOL_PATH_DELAY_MS);
      }),
    ];

    return () => {
      if (symbolTimer) {
        clearTimeout(symbolTimer);
      }
      if (viewStateTimer) {
        clearTimeout(viewStateTimer);
      }
      saveViewState();
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      link.dispose();
      markers.dispose();
      markersRef.current = null;
      chatMarkers.dispose();
      chatMarkersRef.current = null;
      addCommentGlyph.dispose();
      refactorings.dispose();
      agent?.dispose();
      setEditor(null);
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // A commit or revert moves the markers' baseline; the workspace drops its HEAD cache and the markers refetch.
  useEffect(() => workspace.onHeadChange(() => markersRef.current?.reload()).dispose, [workspace]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, lineHeight, fontFamily });
  }, [fontSize, lineHeight, fontFamily]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: isLocked, readOnlyMessage: { value: WORKTREE_LOCKED_MESSAGE } });
  }, [isLocked]);

  useEffect(() => {
    chatMarkersRef.current?.set(pane.activePath, selectionChats, busyChatIds);
  }, [pane.activePath, selectionChats, busyChatIds]);

  // Shows the active tab's model and applies a pending caret position once the model is in place.
  const activePath = pane.activePath;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || activePath) return;
    shownPathRef.current = null;
    editor.setModel(null);
    setCrumbs([]);
  }, [activePath]);
  useLoad(
    () => workspace.open(activePath ?? ""),
    {
      onValue: (document) => {
        const editor = editorRef.current;
        if (!editor || !activePath) return;
        if (editor.getModel() !== document.model) {
          if (shownPathRef.current) {
            noteViewState(sessionId, pane.id, shownPathRef.current, editor.saveViewState());
          }
          editor.setModel(document.model);
          shownPathRef.current = activePath;
          const viewState = viewStateOf(sessionId, pane.id, activePath);
          if (viewState) {
            editor.restoreViewState(viewState);
          }
          setCrumbs([]);
        }
        setError(null);
        if (pendingPosition && pendingPosition.paneId === pane.id && pendingPosition.path === activePath) {
          const position = { lineNumber: pendingPosition.line, column: pendingPosition.column };
          if (pendingPosition.endLine) {
            const range = new monaco.Range(position.lineNumber, 1, pendingPosition.endLine, document.model.getLineMaxColumn(pendingPosition.endLine));
            editor.setSelection(range);
            editor.revealRangeInCenterIfOutsideViewport(range);
          } else {
            editor.setPosition(position);
            editor.revealPositionInCenterIfOutsideViewport(position);
          }
          editor.focus();
          clearPendingPosition(sessionId, pendingPosition.nonce);
        }
        // The shown file is where the next navigation starts from, even before the caret moves.
        const caret = editor.getPosition();
        if (caret) {
          noteCaret(sessionId, { paneId: pane.id, path: activePath, line: caret.lineNumber, column: caret.column });
        }
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [workspace, activePath, pane.id, pendingPosition, sessionId, clearPendingPosition],
    { isEnabled: !!activePath },
  );

  useEffect(() => {
    if (isActive && editorRef.current?.getModel()) {
      editorRef.current.focus();
    }
  }, [isActive]);

  // A pane narrower than its tabs scrolls the tab bar; the active tab stays in view.
  useEffect(() => {
    tabListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activePath]);

  const openUsage = (usage: Usage) => {
    setUsagesQuery(null);
    openFile(sessionId, usage.path, { paneId: pane.id, line: usage.line, column: usage.column });
  };

  const requestClose = (path: string, event?: MouseEvent) => {
    event?.stopPropagation();
    noteViewState(sessionId, pane.id, path, null);
    closeTab(sessionId, pane.id, path);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--diff-bg)" onMouseDown={() => activatePane(sessionId, pane.id)}>
      <div ref={tabListRef} role="tablist" className="ide-tabs flex h-10 shrink-0 items-center overflow-x-auto border-b border-(--line) bg-(--surface-inspector) px-1 text-[13px]">
        {pane.tabs.map((path) => {
          const name = baseName(path);
          const isCurrentTab = path === activePath;
          const isDirty = dirtyPaths.includes(path);
          return (
            <div
              key={path}
              role="tab"
              aria-selected={isCurrentTab}
              title={path}
              onClick={() => activateTab(sessionId, pane.id, path)}
              onAuxClick={(event) => event.button === 1 && requestClose(path, event)}
              className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 ${
                isCurrentTab ? `${isActive ? "border-[#3a5ea5] bg-[#2e4470]" : "border-white/15 bg-white/8"} text-white` : "border-transparent text-neutral-400 hover:bg-(--row-hover) hover:text-white"
              }`}
            >
              <img src={fileIconUrl(path)} alt="" className="size-4 shrink-0" />
              <span className="whitespace-nowrap">{name}</span>
              <button
                type="button"
                onClick={(event) => requestClose(path, event)}
                className={`-my-1 ml-0.5 flex size-5 items-center justify-center rounded text-neutral-500 hover:bg-white/10 hover:text-white ${isDirty || isCurrentTab ? "" : "opacity-0 group-hover:opacity-100"}`}
                title={isDirty ? "Unsaved changes · close" : "Close"}
              >
                {isDirty ? <span className="size-2 rounded-full bg-amber-300 group-hover:hidden" /> : null}
                <CloseIcon className={`size-3 ${isDirty ? "hidden group-hover:block" : ""}`} />
              </button>
            </div>
          );
        })}
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        {!activePath ? <p className="absolute inset-0 flex items-center justify-center text-[13px] text-neutral-500">No file open</p> : null}
        {shownMarker && editorRef.current && markersRef.current ? (
          <ChangePopover editor={editorRef.current} markers={markersRef.current} marker={shownMarker} onShowMarker={setShownMarker} onClose={() => setShownMarker(null)} />
        ) : null}
        {usagesQuery && editorRef.current ? <UsagesPopover editor={editorRef.current} workspace={workspace} query={usagesQuery} onOpen={openUsage} onClose={() => setUsagesQuery(null)} /> : null}
        {renameQuery ? (
          <RenameDialog
            workspace={workspace}
            model={renameQuery.model}
            target={renameQuery.target}
            onClose={() => {
              setRenameQuery(null);
              editorRef.current?.focus();
            }}
          />
        ) : null}
        {pullRequest && editor && activePath ? (
          <ReviewCommentZones key={activePath} editor={editor} sessionId={sessionId} path={activePath} blocks={blocks} composer={composer} onCloseComposer={() => setComposer(null)} />
        ) : null}
      </div>
      <Breadcrumb path={activePath} crumbs={crumbs} />
    </div>
  );
}

/** The file name followed by the declarations around the caret, like WebStorm's editor breadcrumbs. */
function Breadcrumb({ path, crumbs }: { path: string | null; crumbs: SymbolCrumb[] }) {
  const name = path ? baseName(path) : null;
  return (
    <div className={`${STATUS_BAR} gap-1.5 bg-(--surface-inspector)`} title={path ?? undefined}>
      {name ? <span className="text-neutral-400">{name}</span> : null}
      {crumbs.map((crumb, index) => (
        <span key={`${index}:${crumb.name}`} className="flex items-center gap-1">
          <span className="text-neutral-600">›</span>
          <span className="text-neutral-200" title={crumb.kind}>
            {crumb.name}
          </span>
        </span>
      ))}
    </div>
  );
}
