import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as monaco from "monaco-editor";
import { commands } from "../ipc/commands";
import type { TextMatch, TextQuery, TextRange, TextSearchResult } from "../ipc/types";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { useHuntStore } from "../state/store";
import { STATUS_BAR } from "../ui/bars";
import { SearchIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { splitPath } from "../ui/path";
import { isShortcut } from "../ui/shortcuts";
import { errorText, useLoad } from "../ui/useLoad";
import { usePopupSize } from "../ui/usePopupSize";
import { useViewportSize } from "../ui/useViewportSize";
import { abbreviateHome, FilePreview } from "./FileSearchDialog";
import { matchSummary, selectionQuery, splitByRanges } from "./findInFiles";

const MIN_SIZE = { width: 560, height: 280 };
/** The largest share of the window's width and height the dialog may take. */
const MAX_WIDTH_SHARE = 0.94;
const MAX_HEIGHT_SHARE = 0.84;
/** Smallest heights in pixels the list and the preview can be dragged to: two rows and three lines. */
const MIN_LIST_HEIGHT = 56;
const MIN_PREVIEW_HEIGHT = 64;

/** The last query of this window; the dialog reopens with it like WebStorm's. */
let lastQuery: TextQuery = { text: "", matchCase: false, wholeWords: false, isRegex: false, fileMask: "" };

/** The text selected in the focused Monaco editor, when it is a single line worth searching for. */
function focusedEditorSelection(): string | null {
  const editor = monaco.editor.getEditors().find((candidate) => candidate.hasTextFocus());
  const selection = editor?.getSelection();
  if (!editor || !selection || selection.isEmpty()) return null;
  return selectionQuery(editor.getModel()?.getValueInRange(selection));
}

/**
 * Calls `onTrigger` for the keymap's "Find in files" (⇧⌘F by default, like WebStorm) with the text selected in the focused editor, if any.
 */
export function useFindInFilesShortcut(onTrigger: (selected: string | null) => void) {
  const triggerRef = useRef(onTrigger);
  triggerRef.current = onTrigger;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isShortcut(event, "editor.findInFiles")) return;
      event.preventDefault();
      event.stopPropagation();
      triggerRef.current(focusedEditorSelection());
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/**
 * WebStorm-style "Find in Files": searches the text of every project file (see find_in_files.rs) as you type and
 * lists the matching lines on every keystroke; the selected match is previewed below the list. `initialText` (the editor's selection)
 * replaces the last query. ⌥C, ⌥W and ⌥X toggle Match Case, Words and Regex; the file mask takes comma-separated
 * masks such as `*.ts, !*.spec.ts`. ↑/↓ or a click select a match (hovering only highlights the row), Enter or a
 * double click opens it, ⇧Enter opens it in a right split, Esc or a click on the backdrop closes. The size is remembered across sessions.
 */
export function FindInFilesDialog({
  sessionId,
  initialText,
  onOpen,
  onClose,
}: {
  sessionId: string;
  initialText: string | null;
  /** 1-based position of the match; `inRightSplit` asks for the file right of the current pane. */
  onOpen: (path: string, line: number, column: number, inRightSplit: boolean) => void;
  onClose: () => void;
}) {
  const worktreePath = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.worktreePath ?? "");
  const [query, setQuery] = useState<TextQuery>(() => (initialText ? { ...lastQuery, text: initialText } : lastQuery));
  const [result, setResult] = useState<{ query: TextQuery; value: TextSearchResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const viewport = useViewportSize();
  const { size, grips } = usePopupSize("findInFiles", { min: MIN_SIZE, max: { width: viewport.width * MAX_WIDTH_SHARE, height: viewport.height * MAX_HEIGHT_SHARE } });

  useEffect(() => {
    lastQuery = query;
  }, [query]);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useLoad(
    () => commands.findInFiles(sessionId, query),
    {
      onValue: (value) => {
        setError(null);
        setResult({ query, value });
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, query.text, query.matchCase, query.wholeWords, query.isRegex, query.fileMask],
  );

  const matches = useMemo(() => (query.text && !error ? (result?.value.matches ?? []) : []), [query.text, error, result]);
  const selected = Math.min(selectedIndex, Math.max(matches.length - 1, 0));
  const selectedMatch = matches[selected] as TextMatch | undefined;

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected, matches]);

  const update = (change: Partial<TextQuery>) => {
    setQuery((current) => ({ ...current, ...change }));
    setSelectedIndex(0);
  };

  const open = (match: TextMatch | undefined, inRightSplit = false) => {
    if (!match) return;
    onOpen(match.path, match.line, match.column, inRightSplit);
    onClose();
  };

  /** ↑ / ↓, Enter and the ⌥ toggles act from anywhere in the dialog (the preview keeps the keys it handled). */
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      if (event.code === "KeyC") {
        update({ matchCase: !query.matchCase });
      } else if (event.code === "KeyW") {
        update({ wholeWords: !query.wholeWords });
      } else if (event.code === "KeyX") {
        update({ isRegex: !query.isRegex });
      } else {
        return;
      }
    } else if (event.key === "ArrowDown") {
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

  /** Returns the focus to the query field after a drag of the split, which leaves it on the split line or the body. */
  const onPointerUp = () => {
    const focused = document.activeElement;
    if (focused === document.body || focused?.hasAttribute("data-separator")) {
      inputRef.current?.focus();
    }
  };

  // The last result stays on screen while the next search runs (an empty query's result only loaded the files).
  const status = !query.text ? "" : result?.query.text ? matchSummary(result.value) : "Searching…";
  // Without a preview the dialog is as tall as its list, up to the remembered height.
  const style = { width: size.width, height: selectedMatch ? size.height : undefined, maxHeight: size.height };
  const list = (
    <ul ref={listRef} className={`min-h-0 overflow-auto py-1 text-[13px] ${selectedMatch ? "flex-1" : ""}`}>
      {matches.map((match, index) => {
        const { name, dir } = splitPath(match.path);
        return (
          <li
            key={`${match.path}:${match.line}`}
            // Keeps the focus in the query field, so the keys still reach the dialog after a click.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setSelectedIndex(index)}
            onDoubleClick={() => open(match)}
            data-selected={index === selected}
            className="tree-row flex cursor-pointer items-center gap-4 px-3 py-1"
          >
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre text-neutral-200">
              <MatchedText text={match.preview} ranges={match.ranges} />
            </span>
            <span className="flex max-w-[45%] min-w-0 shrink-0 text-neutral-500">
              {dir ? <span className="truncate">{dir}/</span> : null}
              <span className="shrink-0 text-neutral-400">{name}</span>
              <span className="ml-2 shrink-0 tabular-nums">{match.line}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
  return (
    <Modal label="Find in files" onClose={onClose} align="top" className="bg-(--surface-inspector)" style={style} resize={grips}>
      {/* `contents` keeps the rows in the dialog's own column layout; the keys bubble up through it. */}
      <div className="contents" onKeyDown={onKeyDown} onPointerUp={onPointerUp}>
        <div className="flex h-10 shrink-0 items-center gap-3 px-3 text-[13px]">
          <span className="shrink-0 font-semibold text-neutral-200">Find in Files</span>
          <span className="min-w-0 flex-1 truncate text-neutral-500">{status}</span>
          <label className="flex shrink-0 items-center gap-2 text-neutral-400">
            File mask
            <input
              value={query.fileMask}
              onChange={(event) => update({ fileMask: event.target.value })}
              placeholder="*.ts, !*.spec.ts"
              spellCheck={false}
              className="h-7 w-44 rounded-md border border-(--line) bg-transparent px-2 text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-blue-500/70"
            />
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-y border-(--line) px-3">
          <SearchIcon className="size-4 shrink-0 text-neutral-500" />
          <input
            ref={inputRef}
            value={query.text}
            onChange={(event) => update({ text: event.target.value })}
            placeholder="Find in files"
            autoFocus
            spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-500"
          />
          <OptionToggle label="Match Case (⌥C)" isOn={query.matchCase} onToggle={() => update({ matchCase: !query.matchCase })}>
            Aa
          </OptionToggle>
          <OptionToggle label="Words (⌥W)" isOn={query.wholeWords} onToggle={() => update({ wholeWords: !query.wholeWords })}>
            W
          </OptionToggle>
          <OptionToggle label="Regex (⌥X)" isOn={query.isRegex} onToggle={() => update({ isRegex: !query.isRegex })}>
            .*
          </OptionToggle>
        </div>
        {error ? <p className="shrink-0 px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
        {/* With a preview the list and the preview share the height at a draggable split; without one the list takes it all. */}
        {selectedMatch ? (
          <>
            <PersistentGroup id="find-in-files" orientation="vertical" className="flex min-h-0 flex-1 flex-col">
              <Panel id="list" defaultSize="40" minSize={MIN_LIST_HEIGHT} className="flex min-h-0 flex-col">
                {list}
              </Panel>
              <PaneSeparator orientation="vertical" />
              <Panel id="preview" defaultSize="60" minSize={MIN_PREVIEW_HEIGHT} className="flex min-h-0 flex-col">
                <FilePreview sessionId={sessionId} path={selectedMatch.path} line={selectedMatch.line} column={selectedMatch.column} endColumn={selectedMatch.endColumn} />
              </Panel>
            </PersistentGroup>
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
        ) : (
          list
        )}
      </div>
    </Modal>
  );
}

/** A search option button beside the query, like WebStorm's Aa / W / .* toggles. */
function OptionToggle({ label, isOn, onToggle, children }: { label: string; isOn: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={isOn}
      onClick={onToggle}
      className={`h-6 min-w-6 shrink-0 rounded-md px-1.5 font-mono text-[12px] transition-colors ${
        isOn ? "bg-blue-500/25 text-blue-200" : "text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

/** `text` with the `ranges` emphasized. */
function MatchedText({ text, ranges }: { text: string; ranges: TextRange[] }) {
  return (
    <>
      {splitByRanges(text, ranges).map((part, index) =>
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
