import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import * as monaco from "monaco-editor";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { useFileIconUrl } from "../diff/fileIcons";
import { PREVIEW_EDITOR_OPTIONS, monacoLanguage, setupMonaco } from "../diff/monaco";
import type { SelectionRequest } from "../diff/selectionContext";
import { commands } from "../ipc/commands";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { STATUS_BAR } from "../ui/bars";
import { SearchIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { splitPath } from "../ui/path";
import { isShortcut } from "../ui/shortcuts";
import { errorText, useLoad } from "../ui/useLoad";
import { usePopupSize } from "../ui/usePopupSize";
import { useViewportSize } from "../ui/useViewportSize";
import { searchFiles, parseQuery, type FileMatch } from "./fileSearch";
import { KindIcon } from "./KindIcon";
import { lspClientFor } from "./lsp/client";
import type { WorkspaceSymbol } from "./lsp/protocol";
import { attachSelectionAgent } from "./selectionAgent";
import { MARKING_SELECTION_SOURCE } from "./selectionAskButton";
import { CLASS_KINDS, declarationQuery, declarationsOf, isSymbolQuery, rankSymbols, workspaceSymbolsIn, type SymbolCandidate, type SymbolMatch } from "./symbolSearch";

/** Timeout for the second Shift press of "double shift", and the interval of a second press when Shift stays down. */
const DOUBLE_SHIFT_MS = 400;
/** URI scheme of the preview's models; their path is the worktree path with a leading slash. */
const PREVIEW_SCHEME = "preview";

const MIN_SIZE = { width: 520, height: 240 };
/** The largest share of the window's width and height the dialog may take. */
const MAX_WIDTH_SHARE = 0.94;
const MAX_HEIGHT_SHARE = 0.84;
/** Pause after the last keystroke before symbols are searched. */
const SYMBOL_SEARCH_DELAY_MS = 150;

/** A result row: classes come first, then files, then the other symbols, like WebStorm's "Search Everywhere". */
type Row = { type: "file"; match: FileMatch } | { type: "symbol"; match: SymbolMatch };

function rowGroup(row: Row): string {
  if (row.type === "file") return "Files";
  return CLASS_KINDS.has(row.match.kind) ? "Classes" : "Symbols";
}

function rowKey(row: Row): string {
  return row.type === "file" ? row.match.path : `symbol:${row.match.path}:${row.match.line}:${row.match.name}`;
}

/** The language server's workspace symbols and the declarations a text search finds for `text`; a failing source adds none. */
async function findSymbols(sessionId: string, worktreePath: string, text: string, files: ReadonlySet<string>): Promise<SymbolCandidate[]> {
  const [symbols, declarations] = await Promise.all([
    lspClientFor(sessionId, worktreePath)
      .request<WorkspaceSymbol[] | null>("workspace/symbol", { query: text })
      .catch(() => null),
    commands.findInFiles(sessionId, declarationQuery(text)).catch(() => null),
  ]);
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

/**
 * WebStorm-style "Search Everywhere" for files and symbols: a search field over every project file with fuzzy ranking
 * (see fileSearch.ts) and, for an identifier, over the declared classes and symbols (see symbolSearch.ts).
 * With an empty query the open files are listed. The selected file is previewed below the list like in WebStorm's
 * "Search Everywhere", with its path and an "Open In Right Split" action in the footer. ↑/↓ move the selection,
 * Enter opens (`name:12` places the caret on line 12, a symbol at its name), ⇧Enter opens in a right split, Esc or a click on the
 * backdrop closes. Dragging a side or the bottom edge resizes the dialog; the size is remembered across sessions.
 * Text selected in the preview opens a sub chat about it over the dialog; while that is open, Esc closes only the sub chat.
 */
export function FileSearchDialog({
  sessionId,
  openPaths,
  onOpen,
  onClose,
}: {
  sessionId: string;
  /** Files currently open in the editor, most recently opened last; shown while the query is empty. */
  openPaths: string[];
  /** 1-based caret position, if any; `inRightSplit` asks for the file right of the current pane (WebStorm's "Open In Right Split"). */
  onOpen: (path: string, line: number | undefined, column: number | undefined, inRightSplit: boolean) => void;
  onClose: () => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const worktreePath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.worktreePath ?? "");
  const [query, setQuery] = useState("");
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

  const rows = useMemo<Row[]>(() => {
    const fileMatches = parsed.text ? searchFiles(files ?? [], parsed.text) : [...openPaths].reverse().map((path) => ({ path, ...splitPath(path), score: 0, positions: [] }));
    const fileRows = fileMatches.map((match): Row => ({ type: "file", match }));
    if (!isSymbolSearch) return fileRows;
    // Candidates of the previous query stay until the new ones arrive, ranked against the current text.
    const symbolRows = rankSymbols(symbolCandidates, parsed.text).map((match): Row => ({ type: "symbol", match }));
    return [...symbolRows.filter((row) => rowGroup(row) === "Classes"), ...fileRows, ...symbolRows.filter((row) => rowGroup(row) === "Symbols")];
  }, [files, parsed.text, openPaths, isSymbolSearch, symbolCandidates]);
  const hasSymbols = rows.some((row) => row.type === "symbol");

  const selected = Math.min(selectedIndex, Math.max(rows.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const selectedRow = rows[selected] as Row | undefined;
  const selectedPath = selectedRow?.match.path;

  const open = (row: Row | undefined, inRightSplit = false) => {
    if (!row) return;
    if (row.type === "file") {
      onOpen(row.match.path, parsed.line ?? undefined, undefined, inRightSplit);
    } else {
      onOpen(row.match.path, row.match.line, row.match.column, inRightSplit);
    }
    onClose();
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

  // Without a preview the dialog is as tall as its list, up to the remembered height.
  const style = { width: size.width, height: selectedRow ? size.height : undefined, maxHeight: size.height };
  return (
    <Modal label="Go to file or symbol" onClose={onClose} isCloseable={!subChat.shown} align="top" className="bg-(--surface-inspector)" style={style} resize={grips}>
      {/* `contents` keeps the rows in the dialog's own column layout; the keys bubble up through it. */}
      <div className="contents" onKeyDown={onKeyDown}>
        <div className="flex shrink-0 items-center gap-2 border-b border-(--line) px-3">
          <SearchIcon className="size-4 shrink-0 text-neutral-500" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Go to file or symbol (append :line to jump to a line)"
            autoFocus
            spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-500"
          />
          <span className="text-[13px] text-neutral-500">{files ? `${files.length} files` : "Loading…"}</span>
        </div>
        {error ? <p className="shrink-0 px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
        {/* With a preview the list leaves it at least half of the dialog; without one it takes the whole height. */}
        <ul ref={listRef} className={`min-h-0 overflow-auto py-1 text-[13px] ${selectedRow ? "max-h-[45%] shrink-0 border-b border-(--line)" : ""}`}>
          {rows.map((row, index) => (
            <Fragment key={rowKey(row)}>
              {hasSymbols && (index === 0 || rowGroup(rows[index - 1]) !== rowGroup(row)) ? (
                <li className="px-3 pt-2 pb-1 text-[12px] text-neutral-500">{rowGroup(row)}</li>
              ) : null}
              <li
                onMouseMove={(event) => selectUnderMouse(event, index)}
                onClick={() => open(row)}
                data-row={index}
                data-selected={index === selected}
                className="tree-row flex cursor-pointer items-center gap-2 px-3 py-1.5"
              >
                {row.type === "file" ? <FileRow match={row.match} iconUrl={fileIconUrl(row.match.path)} /> : <SymbolRow match={row.match} />}
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
              <span className="min-w-0 flex-1 truncate text-neutral-400" title={`${worktreePath}/${selectedPath}`}>
                {abbreviateHome(worktreePath)}/{selectedPath}
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
function SymbolRow({ match }: { match: SymbolMatch }) {
  return (
    <>
      <KindIcon kind={match.kind} />
      <span className="shrink-0 text-neutral-100">
        <Highlighted text={match.name} positions={match.positions} offset={0} />
      </span>
      <span className="truncate text-neutral-500">
        {match.containerName ? `${match.containerName} · ` : ""}
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
 * Read-only Monaco view of `path` below the search results, colored and sized like the editor panes. The file is
 * read once per dialog and kept in a throwaway `preview:` model, so previewing never opens it in the workspace;
 * `line` (from a `name:12` query) is placed in the middle of the view and highlighted, and the 1-based columns
 * `column..endColumn` of that line (a Find in Files match) are selected. Selecting text shows the floating button
 * that toggles the sub chat popover for the selected lines (see selectionAskButton.ts); the selected match does not.
 */
export function FilePreview({
  sessionId,
  path,
  line,
  column,
  endColumn,
  onOpenSubChat,
  onToggleSubChat,
}: {
  sessionId: string;
  path: string;
  line: number | null;
  column?: number;
  endColumn?: number;
  /** Opens the sub chat popover for the selected lines; without it the preview has no agent features. */
  onOpenSubChat?: (request: SelectionRequest) => void;
  /** Toggles the sub chat popover from the floating button at the end of a selection. */
  onToggleSubChat?: (request: SelectionRequest) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ onOpenSubChat, onToggleSubChat });
  latest.current = { onOpenSubChat, onToggleSubChat };
  const textsRef = useRef(new Map<string, Promise<string>>());
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const [loaded, setLoaded] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setupMonaco();
    const editor = monaco.editor.create(host, { ...PREVIEW_EDITOR_OPTIONS, model: null, fontSize, lineHeight, fontFamily });
    editorRef.current = editor;
    const agent = latest.current.onOpenSubChat
      ? attachSelectionAgent(editor, {
          pathOf: (model) => (model.uri.scheme === PREVIEW_SCHEME ? model.uri.path.slice(1) : null),
          onOpen: (request) => latest.current.onOpenSubChat?.(request),
          onToggle: (request) => latest.current.onToggleSubChat?.(request),
        })
      : null;
    return () => {
      agent?.dispose();
      editorRef.current = null;
      const model = editor.getModel();
      editor.dispose();
      model?.dispose();
    };
    // Created once; the font options are updated below so the view stays put while the selection moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, lineHeight, fontFamily });
  }, [fontSize, lineHeight, fontFamily]);

  useLoad(
    () => {
      let pending = textsRef.current.get(path);
      if (!pending) {
        pending = commands.readFile(sessionId, path);
        textsRef.current.set(path, pending);
      }
      return pending;
    },
    {
      onValue: (text) => {
        setError(null);
        setLoaded({ path, text });
      },
      onError: (reason) => {
        textsRef.current.delete(path);
        setError(errorText(reason));
      },
    },
    [sessionId, path],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !loaded) return;
    const uri = monaco.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${loaded.path}` });
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(loaded.text, monacoLanguage(loaded.path), uri);
    const previous = editor.getModel();
    editor.setModel(model);
    if (previous && previous !== model) {
      previous.dispose();
    }
    const lineNumber = line ? Math.min(line, model.getLineCount()) : 1;
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

  const isStale = loaded?.path !== path;
  return (
    <div className="relative min-h-0 flex-1">
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
