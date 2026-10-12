import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import * as monaco from "monaco-editor";
import { useFileIconUrl } from "../diff/fileIcons";
import { PREVIEW_EDITOR_OPTIONS, monacoLanguage, setupMonaco } from "../diff/monaco";
import { commands } from "../ipc/commands";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { STATUS_BAR } from "../ui/bars";
import { SearchIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { splitPath } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";
import { usePopupSize } from "../ui/usePopupSize";
import { useViewportSize } from "../ui/useViewportSize";
import { searchFiles, parseQuery, type FileMatch } from "./fileSearch";

/** Timeout for the second Shift press of "double shift", and the interval of a second press when Shift stays down. */
const DOUBLE_SHIFT_MS = 400;

const MIN_SIZE = { width: 520, height: 240 };
/** The largest share of the window's width and height the dialog may take. */
const MAX_WIDTH_SHARE = 0.94;
const MAX_HEIGHT_SHARE = 0.84;

/**
 * Calls `onTrigger` for ⌘P and for double shift (two plain Shift presses within 400 ms with nothing in between),
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
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
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
 * WebStorm-style "Go to File": a search field over every project file with fuzzy ranking (see fileSearch.ts).
 * With an empty query the open files are listed. The selected file is previewed below the list like in WebStorm's
 * "Search Everywhere", with its path and an "Open In Right Split" action in the footer. ↑/↓ move the selection,
 * Enter opens (`name:12` places the caret on line 12), ⇧Enter opens in a right split, Esc or a click on the
 * backdrop closes. Dragging a side or the bottom edge resizes the dialog; the size is remembered across sessions.
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
  /** `inRightSplit` asks for the file right of the current pane (WebStorm's "Open In Right Split"). */
  onOpen: (path: string, line: number | null, inRightSplit: boolean) => void;
  onClose: () => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const worktreePath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.worktreePath ?? "");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const viewport = useViewportSize();
  const { size, grips } = usePopupSize("fileSearch", { min: MIN_SIZE, max: { width: viewport.width * MAX_WIDTH_SHARE, height: viewport.height * MAX_HEIGHT_SHARE } });
  /** Where the mouse was last seen over the list; the rows scrolling under a resting mouse must not change the selection. */
  const mouseRef = useRef<{ x: number; y: number } | null>(null);

  useLoad(() => commands.listFiles(sessionId), { onValue: setFiles, onError: (reason) => setError(errorText(reason)) }, [sessionId]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const matches = useMemo<FileMatch[]>(() => {
    if (parsed.text) return searchFiles(files ?? [], parsed.text);
    return [...openPaths].reverse().map((path) => ({ path, ...splitPath(path), score: 0, positions: [] }));
  }, [files, parsed.text, openPaths]);

  const selected = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected, matches]);

  const selectedMatch = matches[selected] as FileMatch | undefined;

  const open = (match: FileMatch | undefined, inRightSplit = false) => {
    if (!match) return;
    onOpen(match.path, parsed.line, inRightSplit);
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
      setSelectedIndex(matches.length ? (selected + 1) % matches.length : 0);
    } else if (event.key === "ArrowUp") {
      setSelectedIndex(matches.length ? (selected - 1 + matches.length) % matches.length : 0);
    } else if (event.key === "Enter") {
      open(selectedMatch, event.shiftKey);
    } else {
      return;
    }
    event.preventDefault();
  };

  // Without a preview the dialog is as tall as its list, up to the remembered height.
  const style = { width: size.width, height: selectedMatch ? size.height : undefined, maxHeight: size.height };
  return (
    <Modal label="Go to file" onClose={onClose} align="top" className="bg-(--surface-inspector)" style={style} resize={grips}>
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
            placeholder="Go to file (append :line to jump to a line)"
            autoFocus
            spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-500"
          />
          <span className="text-[13px] text-neutral-500">{files ? `${files.length} files` : "Loading…"}</span>
        </div>
        {error ? <p className="shrink-0 px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
        {/* With a preview the list leaves it at least half of the dialog; without one it takes the whole height. */}
        <ul ref={listRef} className={`min-h-0 overflow-auto py-1 text-[13px] ${selectedMatch ? "max-h-[45%] shrink-0" : ""}`}>
          {matches.map((match, index) => (
            <li
              key={match.path}
              onMouseMove={(event) => selectUnderMouse(event, index)}
              onClick={() => open(match)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${index === selected ? "bg-(--row-active)" : ""}`}
            >
              <img src={fileIconUrl(match.path)} alt="" className="size-4 shrink-0" />
              <span className="shrink-0 text-neutral-100">
                <Highlighted text={match.name} positions={match.positions} offset={match.path.length - match.name.length} />
              </span>
              {match.dir ? (
                <span className="truncate text-neutral-500">
                  <Highlighted text={match.dir} positions={match.positions} offset={0} />
                </span>
              ) : null}
            </li>
          ))}
          {!matches.length ? (
            <li className="px-3 py-2 text-[13px] text-neutral-500">{parsed.text ? (files ? "No matching files" : "Loading…") : "No open files"}</li>
          ) : null}
        </ul>
        {selectedMatch ? (
          <>
            <FilePreview sessionId={sessionId} path={selectedMatch.path} line={parsed.line} />
            <div className={`${STATUS_BAR} gap-3`}>
              <span className="min-w-0 flex-1 truncate text-neutral-400" title={`${worktreePath}/${selectedMatch.path}`}>
                {abbreviateHome(worktreePath)}/{selectedMatch.path}
              </span>
              <button
                type="button"
                title="Open In Right Split (⇧Enter)"
                onClick={() => open(selectedMatch, true)}
                className="shrink-0 rounded-md px-2 py-1 text-[#548af7] hover:bg-white/10 hover:text-[#7ea6ff]"
              >
                Open In Right Split
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

/** `/Users/name/Development/x` as `~/Development/x`, like WebStorm's footer. */
function abbreviateHome(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}

/**
 * Read-only Monaco view of `path` below the search results, colored and sized like the editor panes. The file is
 * read once per dialog and kept in a throwaway `preview:` model, so previewing never opens it in the workspace;
 * `line` (from a `name:12` query) is placed in the middle of the view and highlighted.
 */
function FilePreview({ sessionId, path, line }: { sessionId: string; path: string; line: number | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
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
    return () => {
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
    const uri = monaco.Uri.from({ scheme: "preview", path: `/${loaded.path}` });
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(loaded.text, monacoLanguage(loaded.path), uri);
    const previous = editor.getModel();
    editor.setModel(model);
    if (previous && previous !== model) {
      previous.dispose();
    }
    const lineNumber = line ? Math.min(line, model.getLineCount()) : 1;
    editor.setPosition({ lineNumber, column: 1 });
    if (line) {
      editor.revealLineInCenter(lineNumber);
    } else {
      editor.setScrollTop(0);
    }
  }, [loaded, line]);

  const isStale = loaded?.path !== path;
  return (
    <div className="relative min-h-0 flex-1 border-t border-(--line)">
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
