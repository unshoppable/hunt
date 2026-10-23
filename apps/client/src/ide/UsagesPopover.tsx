import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as monaco from "monaco-editor";
import { tokenizeCode, type HighlightedLine } from "../code/highlight";
import { tokenStyleDeclarations } from "../code/tokenStyle";
import { useFileIconUrl } from "../diff/fileIcons";
import { PREVIEW_EDITOR_OPTIONS, monacoLanguage } from "../diff/monaco";
import { commands } from "../ipc/commands";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { CODE_FONT_FAMILY } from "../state/settings";
import { STATUS_BAR } from "../ui/bars";
import { ChevronIcon, CopyIcon, ExternalIcon, EyeIcon } from "../ui/icons";
import { baseName } from "../ui/path";
import { trackDrag } from "../ui/pointerDrag";
import { ResizeGrips } from "../ui/ResizeGrips";
import { useDismiss } from "../ui/useDismiss";
import { usePopupSize } from "../ui/usePopupSize";
import type { Workspace } from "./documents";
import { KindIcon } from "./KindIcon";
import type { Declaration } from "./languageService";
import { kindLabel, sliceRuns, stepSelection, usageCountLabel, type Usage } from "./usages";

/** Space the popup keeps from the overlay's edges. */
const EDGE_GAP = 4;
const MIN_SIZE = { width: 520, height: 280 };
const ROW_HEIGHT = 28;

/** The symbol whose usages are listed; `usages` is null while the search runs. */
export type UsagesQuery = {
  declaration: Declaration;
  /** File the declaration lives in. */
  path: string;
  /** The ⌘clicked position; the popup opens below its line. */
  anchor: monaco.IPosition;
  usages: Usage[] | null;
};

type UsagesPopoverProps = {
  editor: monaco.editor.IStandaloneCodeEditor;
  workspace: Workspace;
  query: UsagesQuery;
  /** Called with the usage to show in the pane (Enter or double click). */
  onOpen: (usage: Usage) => void;
  onClose: () => void;
};

/** Where the popup sits relative to the anchor; dragging the title bar or its left or top edge changes it. */
type Offset = { x: number; y: number };

/** The anchor in overlay coordinates and the overlay's size, recomputed when the editor relayouts. */
type Placement = { anchor: { top: number; left: number }; viewport: { width: number; height: number } };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * WebStorm's "Show Usages" popup for a ⌘clicked declaration: a title naming the symbol with its parameter types, a
 * toolbar, one row per usage (file, enclosing declaration, line, the highlighted line with the name in bold), a
 * read-only preview of the selected usage and the selected file's project-relative path in the footer. ↑ / ↓ move
 * the selection, Enter or a double click opens the usage in the pane, Esc or a click outside closes the popup.
 * The popup is moved by dragging its title bar, resized by dragging any edge or corner (the size is remembered
 * across sessions) and the split between list and preview by dragging the separator. It is rendered into the closest
 * `data-ide-root` element (the overlay: the IDE panel, the diff view), so it can be moved over the project tree and the
 * other panes, not only the editor.
 */
export function UsagesPopover({ editor, workspace, query, onOpen, onClose }: UsagesPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const overlay = useMemo(() => overlayOf(editor), [editor]);
  const [{ anchor, viewport }, setPlacement] = useState(() => placementOf(editor, overlay, query.anchor));
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [selected, setSelected] = useState(0);
  const [showPreview, setShowPreview] = useState(true);
  const usages = query.usages;
  const selectedUsage = usages?.[selected] ?? null;
  const fileIconUrl = useFileIconUrl();
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const maxSize = { width: viewport.width - EDGE_GAP * 2, height: viewport.height - EDGE_GAP * 2 };
  // A dragged edge stops at the overlay's edge, so the opposite edge stays put.
  const { size, shift, grips } = usePopupSize("usages", {
    min: MIN_SIZE,
    max: maxSize,
    room: (rendered) => ({ left: position.left - EDGE_GAP, top: position.top - EDGE_GAP, right: EDGE_GAP + maxSize.width - position.left - rendered.width, bottom: EDGE_GAP + maxSize.height - position.top - rendered.height }),
  });
  // The whole popup stays inside the overlay, whatever the anchor line, the drag offset and the resize shift.
  const position = {
    left: clamp(anchor.left + offset.x + shift.x, EDGE_GAP, Math.max(EDGE_GAP, EDGE_GAP + maxSize.width - size.width)),
    top: clamp(anchor.top + offset.y + shift.y, EDGE_GAP, Math.max(EDGE_GAP, EDGE_GAP + maxSize.height - size.height)),
  };

  const latest = useRef({ position, anchor, shift });
  latest.current = { position, anchor, shift };

  useEffect(() => {
    const subscription = editor.onDidLayoutChange(() => setPlacement(placementOf(editor, overlay, query.anchor)));
    return () => subscription.dispose();
  }, [editor, overlay, query.anchor]);

  // The popup takes the keyboard so the editor's caret stays put; the editor gets the focus back on close.
  useEffect(() => {
    rootRef.current?.focus();
    return () => editor.focus();
  }, [editor]);

  useDismiss(rootRef, onClose);

  /** ↑ / ↓ and Enter act on the list while the focus is anywhere in the popup; the preview keeps the keys it handled. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !usages?.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      setSelected(stepSelection(selected, event.key === "ArrowDown" ? 1 : -1, usages?.length ?? 0));
    } else if (event.key === "Enter" && usages?.[selected]) {
      onOpen(usages[selected]);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const host = previewRef.current;
    const model = selectedUsage ? workspace.get(selectedUsage.path)?.model : null;
    if (!host || !model || !selectedUsage || !showPreview) return;
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const preview = monaco.editor.create(host, { ...PREVIEW_EDITOR_OPTIONS, model, fontSize: fontInfo.fontSize, fontFamily: fontInfo.fontFamily, lineHeight });
    const { line, column, endColumn } = selectedUsage;
    preview.createDecorationsCollection([{ range: new monaco.Range(line, column, line, endColumn), options: { inlineClassName: "hunt-usage-match" } }]);
    const reveal = () => preview.revealPositionInCenter({ lineNumber: line, column: endColumn });
    preview.setPosition({ lineNumber: line, column });
    reveal();
    // The host gets its size from the pane group after mounting, so the match is centered again once that is known.
    const layoutSubscription = preview.onDidLayoutChange((layout) => {
      if (!layout.height) return;
      reveal();
      layoutSubscription.dispose();
    });
    return () => {
      layoutSubscription.dispose();
      preview.dispose();
    };
  }, [editor, workspace, selectedUsage, lineHeight, showPreview]);

  /** Drags the popup by its title bar; the offset is kept relative to the anchor so the popup follows a relayout. */
  const beginMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const start = { ...offset };
    trackDrag(
      event,
      (dx, dy) => setOffset({ x: start.x + dx, y: start.y + dy }),
      () => {
        // Snaps the offset to where the popup ended up, so a drag past the overlay's edge does not leave slack.
        const { position: end, anchor: origin, shift: moved } = latest.current;
        setOffset({ x: end.left - origin.left - moved.x, y: end.top - origin.top - moved.y });
      },
    );
  };

  const copyUsages = () => {
    if (!usages?.length) return;
    navigator.clipboard?.writeText(usages.map((usage) => `${usage.path}:${usage.line}  ${usage.text}`).join("\n")).catch(() => {});
  };

  const openInWebstorm = () => {
    commands.openFileInWebstorm(workspace.sessionId, query.path, query.anchor.lineNumber, query.anchor.column).catch(() => {});
  };

  const { declaration } = query;
  // A top-level export's container is its module (`"file:///…/user-list.query"`), which the path already names.
  const container = declaration.containerName.startsWith('"') ? "" : declaration.containerName;
  const scope = container ? `${container}, ${query.path}` : query.path;
  const hasPreview = !!selectedUsage && showPreview;

  const list = (
    <div ref={listRef} role="listbox" aria-label={`Usages of ${declaration.name}`} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden text-[14px]">
      {!usages ? (
        <p className="flex items-center px-3 text-neutral-500" style={{ height: ROW_HEIGHT }}>
          Searching the worktree for usages of {declaration.name}…
        </p>
      ) : null}
      {usages && !usages.length ? (
        <p className="flex items-center px-3 text-neutral-500" style={{ height: ROW_HEIGHT }}>
          No usages of {declaration.name} found.
        </p>
      ) : null}
      {usages?.map((usage, index) => (
        <UsageRow
          key={`${usage.path}:${usage.line}:${usage.column}`}
          usage={usage}
          language={workspace.get(usage.path)?.model.getLanguageId() ?? monacoLanguage(usage.path)}
          isSelected={index === selected}
          onSelect={() => setSelected(index)}
          onOpen={() => onOpen(usage)}
        />
      ))}
    </div>
  );

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Usages"
      tabIndex={-1}
      className="hunt-usages-popover absolute z-20 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-(--surface-inspector) text-[13px] shadow-xl shadow-black/50 outline-none"
      style={{ top: position.top, left: position.left, width: size.width, height: size.height }}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 cursor-grab items-center gap-2 border-b border-(--line) px-3 py-2 text-[13px] whitespace-nowrap select-none active:cursor-grabbing" onPointerDown={beginMove}>
        <span className="truncate">
          <span className="font-semibold text-neutral-100">
            {kindLabel(declaration.kind)} {declaration.name}
            {declaration.signature ?? ""}
          </span>
          <span className="ml-1.5 text-neutral-500" title={scope}>
            ({scope})
          </span>
        </span>
        <span className="ml-auto shrink-0 text-neutral-400">{usages ? usageCountLabel(usages.length) : "Searching…"}</span>
        <ToolbarButton title="Open declaration in WebStorm" onClick={openInWebstorm}>
          <ExternalIcon className="size-4" />
        </ToolbarButton>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-b border-(--line) px-2 py-2 whitespace-nowrap text-neutral-300">
        <ToolbarButton title="Copy usages" disabled={!usages?.length} onClick={copyUsages}>
          <CopyIcon className="size-4" />
        </ToolbarButton>
        <ToolbarButton title={showPreview ? "Hide preview" : "Show preview"} isActive={showPreview} onClick={() => setShowPreview((shown) => !shown)}>
          <EyeIcon className="size-4" />
        </ToolbarButton>
        <span className="mx-1.5 h-4 w-px bg-(--line)" />
        <span className="flex h-7 cursor-default items-center gap-1 rounded-md px-2 text-neutral-200" title="Usages are searched in the project files of the worktree">
          <ScopeIcon />
          Project Files
          <ChevronIcon expanded className="size-3 text-neutral-400" />
        </span>
        <span className="ml-auto pr-1 text-neutral-400">Usages</span>
      </div>
      {hasPreview ? (
        <PersistentGroup id="usages-popover" orientation="vertical" className="flex min-h-0 flex-1 flex-col">
          <Panel id="list" defaultSize="40" minSize={ROW_HEIGHT * 2} className="flex min-h-0 flex-col">
            {list}
          </Panel>
          <PaneSeparator orientation="vertical" />
          <Panel id="preview" defaultSize="60" minSize={lineHeight * 3} className="flex min-h-0 flex-col">
            <div ref={previewRef} className="min-h-0 flex-1" />
          </Panel>
        </PersistentGroup>
      ) : (
        list
      )}
      <div className={`${STATUS_BAR} gap-1.5 text-neutral-400`} title={selectedUsage?.path ?? query.path}>
        <img src={fileIconUrl(selectedUsage?.path ?? query.path)} alt="" className="size-4 shrink-0" />
        <span className="truncate">{selectedUsage?.path ?? query.path}</span>
      </div>
      <ResizeGrips edges={{ left: true, top: true, right: true, bottom: true }} {...grips} />
    </div>,
    overlay,
  );
}

type UsageRowProps = { usage: Usage; language: string; isSelected: boolean; onSelect: () => void; onOpen: () => void };

/** One usage: file, enclosing declaration, line number and the line colored like the editor with the name in bold. */
function UsageRow({ usage, language, isSelected, onSelect, onOpen }: UsageRowProps) {
  const fileIconUrl = useFileIconUrl();
  const fileName = baseName(usage.path);
  const runs = useMemo<HighlightedLine>(() => tokenizeCode(usage.text, language)?.[0] ?? [{ text: usage.text, style: { foreground: "#d6d6d6", fontStyle: 0 } }], [usage.text, language]);
  return (
    <div
      role="option"
      aria-selected={isSelected}
      title={`${usage.path}:${usage.line}`}
      onMouseDown={onSelect}
      onDoubleClick={onOpen}
      className={`grid cursor-default grid-cols-[minmax(0,22fr)_minmax(0,24fr)_2.5rem_minmax(0,54fr)] items-center gap-x-3 px-3 whitespace-nowrap ${isSelected ? "bg-[#2e436e] text-white" : "text-neutral-300 hover:bg-(--row-hover)"}`}
      style={{ height: ROW_HEIGHT }}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <img src={fileIconUrl(usage.path)} alt="" className="size-4 shrink-0" />
        <span className="truncate">{fileName}</span>
      </span>
      <span className={`flex min-w-0 items-center gap-1.5 ${isSelected ? "text-neutral-200" : "text-neutral-400"}`}>
        {usage.container ? <KindIcon kind={usage.containerKind} /> : null}
        <span className="truncate">{usage.container}</span>
      </span>
      <span className={`text-right tabular-nums ${isSelected ? "text-neutral-300" : "text-neutral-500"}`}>{usage.line}</span>
      <span className="min-w-0 truncate" style={{ fontFamily: CODE_FONT_FAMILY }}>
        <Runs runs={sliceRuns(runs, 0, usage.matchStart)} />
        <span className="font-bold">
          <Runs runs={sliceRuns(runs, usage.matchStart, usage.matchEnd)} />
        </span>
        <Runs runs={sliceRuns(runs, usage.matchEnd, Infinity)} />
      </span>
    </div>
  );
}

function Runs({ runs }: { runs: HighlightedLine }) {
  return (
    <>
      {runs.map((run, index) => (
        <span key={index} style={tokenStyleDeclarations(run.style)}>
          {run.text}
        </span>
      ))}
    </>
  );
}

function ToolbarButton({ title, disabled, isActive, onClick, children }: { title: string; disabled?: boolean; isActive?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent ${
        isActive ? "bg-white/10 text-white" : "text-neutral-300"
      }`}
    >
      {children}
    </button>
  );
}

/** Stacked panes, WebStorm's icon for the search scope. */
function ScopeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 text-[#3574f0]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6.5h11M6.5 6.5v7" />
    </svg>
  );
}

/** The positioned element the popup floats in: the IDE panel's root (see IdePanel.tsx), else the editor's own host. */
function overlayOf(editor: monaco.editor.ICodeEditor): HTMLElement {
  const host = editor.getContainerDomNode();
  return host.closest<HTMLElement>("[data-ide-root]") ?? host.parentElement ?? host;
}

/**
 * The popup's anchor, below the ⌘clicked line at the left edge of the code, translated into the overlay's coordinates,
 * and the overlay's size. The line is in the viewport since it was just clicked.
 */
function placementOf(editor: monaco.editor.ICodeEditor, overlay: HTMLElement, position: monaco.IPosition): Placement {
  const line = editor.getScrolledVisiblePosition(position);
  const editorRect = editor.getContainerDomNode().getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  return {
    anchor: {
      top: editorRect.top - overlayRect.top + (line ? line.top + line.height : 0),
      left: editorRect.left - overlayRect.left + editor.getLayoutInfo().contentLeft,
    },
    viewport: { width: overlay.clientWidth, height: overlay.clientHeight },
  };
}
