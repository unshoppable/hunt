import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import * as monaco from "monaco-editor";
import { SubChatPopover } from "../../chat/sub-chat/SubChatPopover";
import { useSubChatPopover } from "../../chat/sub-chat/sub-chat-popover.hook";
import { useFileIconUrl } from "../../ui/file-icons/file-icons.hook";
import { PREVIEW_EDITOR_OPTIONS } from "../../editor/monaco.constants";
import { setupMonaco } from "../../editor/setup.monaco";
import type { SelectionRequest } from "../../editor/selection-request.monaco";
import { commands } from "../../ipc/commands";
import { PopupModeButton, PopupWindowTitleBar } from "../../ui/PopupTitleBar";
import type { PopupActions } from "../../ui/popup-protocol.utils";
import { useDetachedPopup } from "../../ui/detached-popup.hook";
import { openInHostWindow } from "../../ui/detached-popup.utils";
import { useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../../sessions/hunt.store";
import { isWorktreeLocked, WORKTREE_LOCKED_MESSAGE } from "../../sessions/remote/remote-session.utils";
import { STATUS_BAR } from "../../ui/bars.constants";
import { SearchIcon } from "../../ui/Icons";
import { Modal } from "../../ui/Modal";
import { splitPath } from "../../common/path/path.utils";
import { isShortcut } from "../../ui/shortcuts.utils";
import { useLoad } from "../../ui/load.hook";
import { errorText } from "../../ui/error-text.utils";
import { usePopupSize } from "../../ui/popup-size.hook";
import { useViewportSize } from "../../ui/viewport-size.hook";
import { searchFiles, parseQuery, type FileMatch } from "./file-search.utils";
import { KindIcon } from "../KindIcon";
import { loadProjectsOf } from "../language/language-service.utils";
import { lspClientFor } from "../lsp/lsp-client.service";
import type { WorkspaceSymbol } from "../lsp/lsp-protocol.utils";
import { workspaceFor } from "../documents/documents.service";
import { attachSelectionAgent } from "../selection/selection-agent.monaco";
import { MARKING_SELECTION_SOURCE } from "../selection/selection-ask-button.monaco";
import { declarationQuery, declarationsOf, isSymbolQuery, mentionQuery, mergeResults, rankSymbols, resultGroup, workspaceSymbolsIn, type SearchResult, type SymbolCandidate, type SymbolMatch } from "./symbol-search.utils";

/** Timeout for the second Shift press of "double shift", and the interval of a second press when Shift stays down. */
const DOUBLE_SHIFT_MS = 400;

const MIN_SIZE = { width: 520, height: 240 };
/** The largest share of the window's width and height the dialog may take. */
const MAX_WIDTH_SHARE = 0.94;
const MAX_HEIGHT_SHARE = 0.84;
/** Pause after the last keystroke before symbols are searched. */
const SYMBOL_SEARCH_DELAY_MS = 150;

function rowKey(row: SearchResult): string {
  return row.type === "file" ? row.match.path : `symbol:${row.match.path}:${row.match.line}:${row.match.name}`;
}

/** The language server's workspace symbols and the declarations a text search finds for `text`; a failing source adds none. */
/**
 * The symbols named like `text`: class members and the like from the TypeScript server, whose search covers only the
 * projects it has loaded, so the projects of the files mentioning `text` are loaded first; top-level declarations
 * from a text search, which also finds them in projects the server could not load.
 */
async function findSymbols(sessionId: string, worktreePath: string, text: string, files: ReadonlySet<string>): Promise<SymbolCandidate[]> {
  const client = lspClientFor(sessionId, worktreePath);
  const workspaceSymbols = async () => {
    const mentions = await commands.findInFiles(sessionId, mentionQuery(text)).catch(() => null);
    await loadProjectsOf(client, [...new Set((mentions?.matches ?? []).map((match) => match.path))]);
    return client.request<WorkspaceSymbol[] | null>("workspace/symbol", { query: text });
  };
  const [symbols, declarations] = await Promise.all([workspaceSymbols().catch(() => null), commands.findInFiles(sessionId, declarationQuery(text)).catch(() => null)]);
  return [...workspaceSymbolsIn(symbols ?? [], worktreePath, files), ...declarationsOf(declarations?.matches ?? [])];
}

/**
 * Calls `onTrigger` for the keymap's "Go to file" (⌘P by default) and for double shift (two plain Shift presses within 400 ms with nothing in between),
 * like WebStorm's "Go to File" and "Search Everywhere".
 */
export function useFileSearchShortcut(onTrigger: () => void) {
  const triggerRef = useRef(onTrigger);
  triggerRef.current = onTrigger;

  useEffect(() => {
    let lastShiftAt = 0;
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.key === "Shift" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const now = performance.now();
        if (now - lastShiftAt < DOUBLE_SHIFT_MS) {
          lastShiftAt = 0;
          triggerRef.current();
        } else {
          lastShiftAt = now;
        }
        return;
      }
      lastShiftAt = 0;
      if (isShortcut(event, "editor.goToFile")) {
        event.preventDefault();
        event.stopPropagation();
        triggerRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/** What the File Search window shows (see detached-popup.hook.ts). */
export type FileSearchContent = { sessionId: string; worktreePath: string; openPaths: string[] };

/** 1-based caret position, if any; `inRightSplit` asks for the file right of the current pane (WebStorm's "Open In Right Split"). */
type OpenFile = (path: string, line: number | undefined, column: number | undefined, inRightSplit: boolean) => void;

type FileSearchPopupProps = {
  sessionId: string;
  /** Files currently open in the editor, most recently opened last; shown while the query is empty. */
  openPaths: string[];
  /** Changes with every ⌘P or double shift, which brings the File Search window to the front again. */
  revision: number;
  onOpen: OpenFile;
  onClose: () => void;
};

/**
 * "Go to file or symbol" (see `FileSearchView`) inside the app window or in a window of its own, as the user chose
 * (see detached-popup.hook.ts). The window stays open while files are opened from it.
 */
export function FileSearchPopup({ sessionId, openPaths, revision, onOpen, onClose }: FileSearchPopupProps) {
  const isDetached = useSettingsStore((state) => state.detachedPopups.fileSearch);
  const worktreePath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.worktreePath ?? "");
  if (isDetached) {
    return <DetachedFileSearch sessionId={sessionId} worktreePath={worktreePath} openPaths={openPaths} revision={revision} onOpen={onOpen} onClose={onClose} />;
  }
  return <FileSearchView sessionId={sessionId} worktreePath={worktreePath} openPaths={openPaths} isDetached={false} onOpen={onOpen} onClose={onClose} />;
}

/** The File Search window's host side: hands the session over and opens the files picked there in the host. */
function DetachedFileSearch({ sessionId, worktreePath, openPaths, revision, onOpen, onClose }: FileSearchPopupProps & { worktreePath: string }) {
  const content = useMemo<FileSearchContent>(() => ({ sessionId, worktreePath, openPaths }), [sessionId, worktreePath, openPaths]);
  useDetachedPopup("fileSearch", content, {
    revision,
    anchor: () => "top",
    onAction: (action: PopupActions["fileSearch"]) => openInHostWindow(() => onOpen(action.path, action.line, action.column, action.inRightSplit)),
    onClose,
  });
  return null;
}

/** File Search in its own window (see PopupWindow.tsx); the files picked here open in the host window. */
export function FileSearchWindowContent({
  content,
  onAction,
  onClose,
}: {
  content: FileSearchContent;
  onAction: (action: PopupActions["fileSearch"]) => void;
  onClose: () => void;
}) {
  return (
    <FileSearchView
      sessionId={content.sessionId}
      worktreePath={content.worktreePath}
      openPaths={content.openPaths}
      isDetached
      onOpen={(path, line, column, inRightSplit) => onAction({ type: "open", path, line, column, inRightSplit })}
      onClose={onClose}
    />
  );
}

/**
 * WebStorm-style "Search Everywhere" for files and symbols: a search field over every project file with fuzzy ranking
 * (see file-search.utils.ts) and, for an identifier, over the declared classes and symbols (see symbol-search.utils.ts).
 * With an empty query the open files are listed; the session's last query comes back selected, so typing replaces
 * it. The selected file is previewed below the list like in WebStorm's
 * "Search Everywhere", with its path and an "Open In Right Split" action in the footer. ↑/↓ move the selection,
 * Enter opens (`name:12` places the caret on line 12, a symbol at its name), ⇧Enter opens in a right split.
 * Inside the app it is a dialog that Esc or a click on the backdrop closes, as does opening a file; dragging a side or
 * the bottom edge resizes it and the size is remembered across sessions. `isDetached` fills a popup window instead.
 * Text selected in the preview opens a sub chat about it over the dialog; while that is open, Esc closes only the sub chat.
 */
/** The last query of each session, shown again when its search opens; per page, as the popup window has one of its own. */
const lastQueries = new Map<string, string>();

function FileSearchView({
  sessionId,
  worktreePath,
  openPaths,
  isDetached,
  onOpen,
  onClose,
}: {
  sessionId: string;
  worktreePath: string;
  openPaths: string[];
  isDetached: boolean;
  onOpen: OpenFile;
  onClose: () => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const [query, setQuery] = useState(() => lastQueries.get(sessionId) ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const [files, setFiles] = useState<string[] | null>(null);
  const [symbolCandidates, setSymbolCandidates] = useState<SymbolCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const viewport = useViewportSize();
  const { size, grips } = usePopupSize("fileSearch", { min: MIN_SIZE, max: { width: viewport.width * MAX_WIDTH_SHARE, height: viewport.height * MAX_HEIGHT_SHARE } });
  /** Where the mouse was last seen over the list; the rows scrolling under a resting mouse must not change the selection. */
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const subChat = useSubChatPopover();
  /** A sub chat in a window of its own leaves the dialog free to close. */
  const isSubChatDetached = useSettingsStore((state) => state.detachedPopups.subChat);

  useLoad(() => commands.listFiles(sessionId), { onValue: setFiles, onError: (reason) => setError(errorText(reason)) }, [sessionId]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const fileSet = useMemo(() => new Set(files ?? []), [files]);
  const isSymbolSearch = isSymbolQuery(parsed.text);
  useLoad(
    () => findSymbols(sessionId, worktreePath, parsed.text, fileSet),
    { onValue: setSymbolCandidates, onError: () => setSymbolCandidates([]) },
    [sessionId, worktreePath, parsed.text, fileSet],
    { delayMs: SYMBOL_SEARCH_DELAY_MS, isEnabled: isSymbolSearch && !!files && !!worktreePath },
  );

  const rows = useMemo<SearchResult[]>(() => {
    const fileMatches = parsed.text ? searchFiles(files ?? [], parsed.text) : [...openPaths].reverse().map((path) => ({ path, ...splitPath(path), score: 0, positions: [] }));
    // Candidates of the previous query stay until the new ones arrive, ranked against the current text.
    return mergeResults(fileMatches, isSymbolSearch ? rankSymbols(symbolCandidates, parsed.text) : []);
  }, [files, parsed.text, openPaths, isSymbolSearch, symbolCandidates]);
  const hasSymbols = rows.some((row) => row.type === "symbol");

  const selected = Math.min(selectedIndex, Math.max(rows.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const selectedRow = rows[selected] as SearchResult | undefined;
  const selectedPath = selectedRow?.match.path;

  const open = (row: SearchResult | undefined, inRightSplit = false) => {
    if (!row) return;
    if (row.type === "file") {
      onOpen(row.match.path, parsed.line ?? undefined, undefined, inRightSplit);
    } else {
      onOpen(row.match.path, row.match.line, row.match.column, inRightSplit);
    }
    // A window of its own stays open for the next file.
    if (!isDetached) {
      onClose();
    }
  };

  const selectUnderMouse = (event: ReactMouseEvent, index: number) => {
    const last = mouseRef.current;
    mouseRef.current = { x: event.clientX, y: event.clientY };
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    setSelectedIndex(index);
  };

  /** ↑ / ↓ and Enter act on the list from anywhere in the dialog (the preview keeps the keys it handled). */
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === "ArrowDown") {
      setSelectedIndex(rows.length ? (selected + 1) % rows.length : 0);
    } else if (event.key === "ArrowUp") {
      setSelectedIndex(rows.length ? (selected - 1 + rows.length) % rows.length : 0);
    } else if (event.key === "Enter") {
      open(selectedRow, event.shiftKey);
    } else {
      return;
    }
    event.preventDefault();
  };

  const body = (
    <>
      {/* `contents` keeps the rows in the dialog's own column layout; the keys bubble up through it. */}
      <div className="contents" onKeyDown={onKeyDown}>
        <div className="flex shrink-0 items-center gap-2 border-b border-(--line) px-3">
          <SearchIcon className="size-4 shrink-0 text-neutral-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              lastQueries.set(sessionId, event.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Go to file or symbol (append :line to jump to a line)"
            autoFocus
            spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-500"
          />
          <span className="text-[13px] text-neutral-500">{files ? `${files.length} files` : "Loading…"}</span>
          {isDetached ? null : <PopupModeButton popupKey="fileSearch" isDetached={false} />}
        </div>
        {error ? <p className="shrink-0 px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
        {/* With a preview the list leaves it at least half of the dialog; without one it takes the whole height. */}
        <ul ref={listRef} className={`min-h-0 overflow-auto py-1 text-[13px] ${selectedRow ? "max-h-[45%] shrink-0 border-b border-(--line)" : ""}`}>
          {rows.map((row, index) => (
            <Fragment key={rowKey(row)}>
              {hasSymbols && (index === 0 || resultGroup(rows[index - 1]) !== resultGroup(row)) ? (
                <li className="px-3 pt-2 pb-1 text-[12px] text-neutral-500">{resultGroup(row)}</li>
              ) : null}
              <li
                onMouseMove={(event) => selectUnderMouse(event, index)}
                onClick={() => open(row)}
                data-row={index}
                data-selected={index === selected}
                className="tree-row flex cursor-pointer items-center gap-2 px-3 py-1.5"
              >
                {row.type === "file" ? <FileRow match={row.match} iconUrl={fileIconUrl(row.match.path)} /> : <SymbolRow match={row.match} iconUrl={fileIconUrl(row.match.path)} />}
              </li>
            </Fragment>
          ))}
          {!rows.length ? (
            <li className="px-3 py-2 text-[13px] text-neutral-500">
              {parsed.text ? (files ? (isSymbolSearch ? "No matching files or symbols" : "No matching files") : "Loading…") : "No open files"}
            </li>
          ) : null}
        </ul>
        {selectedRow && selectedPath ? (
          <>
            {selectedRow.type === "file" ? (
              <FilePreview sessionId={sessionId} path={selectedPath} line={parsed.line} onOpenSubChat={subChat.open} onToggleSubChat={subChat.toggle} />
            ) : (
              <FilePreview
                sessionId={sessionId}
                path={selectedPath}
                line={selectedRow.match.line}
                column={selectedRow.match.column}
                endColumn={selectedRow.match.column + selectedRow.match.name.length}
                onOpenSubChat={subChat.open}
                onToggleSubChat={subChat.toggle}
              />
            )}
            <div className={`${STATUS_BAR} gap-3`}>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-neutral-400" title={`${worktreePath}/${selectedPath}`}>
                <img src={fileIconUrl(selectedPath)} alt="" className="size-4 shrink-0" />
                <span className="truncate">
                  {abbreviateHome(worktreePath)}/{selectedPath}
                </span>
              </span>
              <button
                type="button"
                title="Open In Right Split (⇧Enter)"
                onClick={() => open(selectedRow, true)}
                className="shrink-0 rounded-md px-2 py-1 text-[#548af7] hover:bg-white/10 hover:text-[#7ea6ff]"
              >
                Open In Right Split
              </button>
            </div>
          </>
        ) : null}
      </div>
      {/* Inside the dialog, so that the popover floats above it; its keys do not reach the list. */}
      {subChat.shown ? (
        <SubChatPopover key={subChat.shown.key} parentSessionId={sessionId} request={subChat.shown.request} subSessionId={subChat.shown.subSessionId} onClose={subChat.close} />
      ) : null}
    </>
  );

  if (isDetached) {
    return (
      <div role="dialog" aria-label="Go to file or symbol" className="flex h-screen flex-col bg-(--surface-inspector)">
        <PopupWindowTitleBar popupKey="fileSearch">
          <span className="min-w-0 flex-1 truncate font-semibold text-neutral-200">Go to File or Symbol</span>
        </PopupWindowTitleBar>
        {body}
      </div>
    );
  }
  // Without a preview the dialog is as tall as its list, up to the remembered height.
  const style = { width: size.width, height: selectedRow ? size.height : undefined, maxHeight: size.height };
  return (
    <Modal label="Go to file or symbol" onClose={onClose} isCloseable={!subChat.shown || isSubChatDetached} align="top" className="bg-(--surface-inspector)" style={style} resize={grips}>
      {body}
    </Modal>
  );
}

/** A file result: its icon, its name and its directory with the matched characters marked. */
function FileRow({ match, iconUrl }: { match: FileMatch; iconUrl: string }) {
  return (
    <>
      <img src={iconUrl} alt="" className="size-4 shrink-0" />
      <span className="shrink-0 text-neutral-100">
        <Highlighted text={match.name} positions={match.positions} offset={match.path.length - match.name.length} />
      </span>
      {match.dir ? (
        <span className="truncate text-neutral-500">
          <Highlighted text={match.dir} positions={match.positions} offset={0} />
        </span>
      ) : null}
    </>
  );
}

/** A symbol result: its kind badge, its name with the matched characters marked, its container and its file. */
function SymbolRow({ match, iconUrl }: { match: SymbolMatch; iconUrl: string }) {
  return (
    <>
      <KindIcon kind={match.kind} />
      <span className="shrink-0 text-neutral-100">
        <Highlighted text={match.name} positions={match.positions} offset={0} />
      </span>
      {match.containerName ? <span className="shrink-0 text-neutral-500">{match.containerName} ·</span> : null}
      <img src={iconUrl} alt="" className="size-4 shrink-0" />
      <span className="truncate text-neutral-500">
        {match.path}:{match.line}
      </span>
    </>
  );
}

/** `/Users/name/Development/x` as `~/Development/x`, like WebStorm's footer. */
export function abbreviateHome(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}

/**
 * Monaco view of `path` below the search results, colored and sized like the editor panes. It shows the file's shared
 * document (see documents.service.ts) with the unsaved edits of every editor, and typing in it edits that document like
 * an editor tab; ⌘S saves every file with unsaved edits. `isReadOnly` and a locked worktree only show it. `line` (from a
 * `name:12` query) is placed in the middle of the view and highlighted, and the 1-based columns `column..endColumn` of
 * that line (a Find in Files match) are selected. Selecting text shows the floating button that toggles the sub chat
 * popover for the selected lines (see selection-ask-button.monaco.ts); the selected match does not.
 */
export function FilePreview({
  sessionId,
  path,
  line,
  column,
  endColumn,
  isReadOnly = false,
  onEdited,
  onOpenSubChat,
  onToggleSubChat,
}: {
  sessionId: string;
  path: string;
  line: number | null;
  column?: number;
  endColumn?: number;
  /** Shows the file without letting it be edited. */
  isReadOnly?: boolean;
  /** Called when the preview loses the focus after it was edited, once the edits have reached the shared document. */
  onEdited?: () => void;
  /** Opens the sub chat popover for the selected lines; without it the preview has no agent features. */
  onOpenSubChat?: (request: SelectionRequest) => void;
  /** Toggles the sub chat popover from the floating button at the end of a selection. */
  onToggleSubChat?: (request: SelectionRequest) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const worktreePath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.worktreePath ?? "");
  const isLocked = useHuntStore((state) => isWorktreeLocked(state.sessions, state.remoteLinks, sessionId));
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const workspace = useMemo(() => (worktreePath ? workspaceFor(sessionId, worktreePath) : null), [sessionId, worktreePath]);
  const latest = useRef({ workspace, onEdited, onOpenSubChat, onToggleSubChat });
  latest.current = { workspace, onEdited, onOpenSubChat, onToggleSubChat };
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const [loaded, setLoaded] = useState<{ path: string; model: monaco.editor.ITextModel } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setupMonaco();
    const editor = monaco.editor.create(host, { ...PREVIEW_EDITOR_OPTIONS, model: null, fontSize, lineHeight, fontFamily });
    editorRef.current = editor;
    const agent = latest.current.onOpenSubChat
      ? attachSelectionAgent(editor, {
          pathOf: (model) => latest.current.workspace?.pathOf(model.uri) ?? null,
          onOpen: (request) => latest.current.onOpenSubChat?.(request),
          onToggle: (request) => latest.current.onToggleSubChat?.(request),
        })
      : null;
    let isEdited = false;
    editor.onDidChangeModelContent(() => {
      if (editor.hasTextFocus()) {
        isEdited = true;
      }
    });
    editor.onDidBlurEditorText(() => {
      const current = latest.current.workspace;
      if (!isEdited || !current) return;
      isEdited = false;
      // Resolves after the document updates queued before it, i.e. the last keystroke.
      void current.lsp.enqueue(() => Promise.resolve()).then(() => latest.current.onEdited?.());
    });
    return () => {
      agent?.dispose();
      editorRef.current = null;
      // The model is the shared document, which outlives the preview.
      editor.dispose();
    };
    // Created once; the font options are updated below so the view stays put while the selection moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, lineHeight, fontFamily });
  }, [fontSize, lineHeight, fontFamily]);

  useEffect(() => {
    const readOnlyMessage = isLocked ? { value: WORKTREE_LOCKED_MESSAGE } : undefined;
    editorRef.current?.updateOptions({ readOnly: isReadOnly || isLocked, domReadOnly: isReadOnly, readOnlyMessage });
  }, [isReadOnly, isLocked]);

  useLoad(
    async () => (workspace ? workspace.load(path) : null),
    {
      onValue: (document) => {
        setError(null);
        setLoaded(document);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [workspace, path],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !loaded || loaded.model.isDisposed()) return;
    editor.setModel(loaded.model);
    const lineNumber = line ? Math.min(line, loaded.model.getLineCount()) : 1;
    if (line && column) {
      editor.setSelection(
        { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: endColumn ?? column },
        MARKING_SELECTION_SOURCE,
      );
    } else {
      editor.setPosition({ lineNumber, column: 1 });
    }
    if (line) {
      editor.revealLineInCenter(lineNumber);
    } else {
      editor.setScrollTop(0);
    }
  }, [loaded, line, column, endColumn]);

  /**
   * An editable preview keeps its keys like an editor tab, so they do not reach the dialog's list; ⌘S saves. Escape and
   * ⌘ shortcuts still reach the window, which closes on Escape and ⌘W.
   */
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (isReadOnly || event.key === "Escape") return;
    if (workspace && isShortcut(event.nativeEvent, "editor.save")) {
      event.preventDefault();
      event.stopPropagation();
      workspace
        .saveAll()
        .then(() => setError(null))
        .catch((reason) => setError(errorText(reason)))
        .finally(() => noteWorktreeChanged(sessionId));
      return;
    }
    if (event.metaKey) return;
    event.stopPropagation();
  };

  const isStale = loaded?.path !== path;
  return (
    <div className="relative min-h-0 flex-1" onKeyDown={onKeyDown}>
      <div ref={hostRef} className={`absolute inset-0 ${isStale ? "invisible" : ""}`} />
      {error ? <p className="absolute inset-x-0 top-0 px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
      {isStale && !error ? <p className="absolute inset-x-0 top-0 px-3 py-2 text-[13px] text-neutral-500">Loading…</p> : null}
    </div>
  );
}

/** `text` with the characters at `positions - offset` emphasized; `positions` index into the whole path. */
function Highlighted({ text, positions, offset }: { text: string; positions: number[]; offset: number }) {
  const marked = new Set(positions.map((position) => position - offset));
  const parts: { text: string; isMatch: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const isMatch = marked.has(index);
    const last = parts[parts.length - 1];
    if (last && last.isMatch === isMatch) {
      last.text += text[index];
    } else {
      parts.push({ text: text[index], isMatch });
    }
  }
  return (
    <>
      {parts.map((part, index) =>
        part.isMatch ? (
          <mark key={index} className="rounded-sm bg-amber-300/30 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
