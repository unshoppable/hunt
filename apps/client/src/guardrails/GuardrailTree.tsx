import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import { ChevronIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { toggleInExpanded } from "../ui/treeExpansion";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import { isInsideFolder } from "../ui/path";
import { expandedForTree, folderOf, guardrailTreeRows, KIND_LABELS, treeParentOf, type Guardrail, type GuardrailKind } from "./guardrails";

/** Indentation of a tree row per folder level, in pixels. */
const ROW_INDENT = 14;

/** How far the pointer has to travel with the button held before a CLAUDE.md row starts being dragged. */
const DRAG_THRESHOLD = 4;

type Drag = {
  /** The file being dragged. */
  path: string;
  x: number;
  y: number;
  /** The folder under the pointer the file could be dropped into, if any. */
  over: string | null;
};

/**
 * The folders of the worktree as a tree with the guardrails of `kind` in them: the CLAUDE.md of each folder, or the
 * rules (with their subfolders) and skills of each `.claude` directory (`kindDirs`). Folders on the way to an entry
 * start out open, every other one closed; the chevron toggles. While hovered, a folder shows "+" to create an entry
 * there (a CLAUDE.md only where there is none yet) and, when it may be deleted (any but the root for instructions,
 * the kind's directories and their subfolders otherwise), a trash button that deletes it with everything in it. An entry row opens the file, shows its trash button while hovered,
 * and, when `onMove` is set, can be dragged onto a folder `canDropInto` accepts to move it there. The arrow keys move
 * through the rows, open the entries and open or close the folders.
 */
export function GuardrailTree({
  kind,
  projectName,
  folders,
  kindDirs,
  entries,
  selectedPath,
  dirtyPaths,
  onSelect,
  onCreate,
  onMove,
  canDropInto,
  onDelete,
  onDeleteFolder,
}: {
  kind: GuardrailKind;
  projectName: string;
  folders: string[];
  /** The kind's directories (`.claude/rules` at the root and below folders); empty for instructions. */
  kindDirs: string[];
  entries: Guardrail[];
  selectedPath: string | null;
  dirtyPaths: string[];
  onSelect: (path: string) => void;
  /** Creates an entry in the folder (`""` is the root). */
  onCreate: (folder: string) => void;
  onMove?: (path: string, folder: string) => void;
  /** Whether the file at `path` may be dropped into `folder`. */
  canDropInto?: (path: string, folder: string) => boolean;
  onDelete: (entry: Guardrail) => void;
  /** Deletes the folder with everything in it. */
  onDeleteFolder: (folder: string) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => expandedForTree(entries, kindDirs));
  const [drag, setDrag] = useState<Drag | null>(null);
  const knownPaths = useRef(new Set(entries.map((entry) => entry.path)));
  const labels = KIND_LABELS[kind];

  // An entry that appeared (created or moved here) opens the folders on its way; folders the user closed stay closed otherwise.
  useEffect(() => {
    const added = entries.filter((entry) => !knownPaths.current.has(entry.path));
    knownPaths.current = new Set(entries.map((entry) => entry.path));
    if (!added.length) return;
    setExpanded((current) => new Set([...current, ...expandedForTree(added)]));
  }, [entries]);

  // Escape drops a drag in progress.
  useEscapeToClose(() => setDrag(null), !!drag);

  const toggle = (folder: string) => {
    setExpanded((current) => toggleInExpanded(current, folder));
  };

  const rows = guardrailTreeRows(folders, entries, expanded, projectName);
  /** A folder's key is its path with a trailing slash (`/` for the root), an entry's its path. */
  const nav = useTreeNavigation({
    rows: rows.map((row) => (row.type === "folder" ? { key: `${row.path}/`, depth: row.depth, isExpanded: expanded.has(row.path) } : { key: row.entry.path, depth: row.depth })),
    selectedKey: selectedPath,
    onSelect,
    isSelectable: (key) => !key.endsWith("/"),
    onToggle: (key) => toggle(key.slice(0, -1)),
  });
  /** Whether `folder` is one of the kind's directories or lies below one. */
  const isKindFolder = (folder: string) => kindDirs.some((dir) => folder === dir || isInsideFolder(folder, dir));

  /** The folder row under the pointer the dragged file may go into: not its own folder, and one the caller accepts. */
  const dropTargetAt = (x: number, y: number, path: string): string | null => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder]");
    if (!row) return null;
    const folder = row.dataset.folder ?? "";
    return folder !== folderOf(path) && (canDropInto?.(path, folder) ?? true) ? folder : null;
  };

  const dragged = drag ? entries.find((entry) => entry.path === drag.path) : null;

  /** The actions of a folder row: a new entry (a CLAUDE.md only where the folder has none) and deletion where allowed. */
  const actionsOf = (row: Extract<ReturnType<typeof guardrailTreeRows>[number], { type: "folder" }>): FolderActions => ({
    onCreate: kind === "instruction" && row.hasEntry ? null : () => onCreate(row.path),
    onDelete: (kind === "instruction" ? !!row.path : isKindFolder(row.path)) ? () => onDeleteFolder(row.path) : null,
  });

  return (
    <>
      <ul {...nav.listProps} className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-[13px] outline-none" aria-label="Folders">
        {rows.map((row) =>
          row.type === "folder" ? (
            <FolderRow
              key={`folder:${row.path}`}
              path={row.path}
              name={row.name}
              depth={row.depth}
              isExpanded={expanded.has(row.path)}
              isSelected={nav.cursor === `${row.path}/`}
              isKindDir={kindDirs.includes(row.path)}
              isEmpty={!row.holdsEntries}
              isDropTarget={drag?.over === row.path}
              entryLabel={labels.item}
              onToggle={() => {
                toggle(row.path);
                nav.select(`${row.path}/`);
              }}
              actions={actionsOf(row)}
            />
          ) : (
            <FileRow
              key={row.entry.path}
              entry={row.entry}
              depth={row.depth}
              isSelected={nav.cursor === row.entry.path}
              isDirty={dirtyPaths.includes(row.entry.path)}
              isDragged={drag?.path === row.entry.path}
              onSelect={() => nav.select(row.entry.path)}
              onDelete={() => onDelete(row.entry)}
              onDragStart={onMove ? (x, y) => setDrag({ path: row.entry.path, x, y, over: null }) : null}
              onDragMove={(x, y) => setDrag((current) => (current ? { ...current, x, y, over: dropTargetAt(x, y, current.path) } : current))}
              onDragEnd={(x, y) => {
                const target = x === null || y === null ? null : dropTargetAt(x, y, row.entry.path);
                if (target !== null) {
                  onMove?.(row.entry.path, target);
                }
                setDrag(null);
              }}
            />
          ),
        )}
      </ul>
      {drag && dragged ? (
        <div className="pointer-events-none fixed z-30 flex items-center gap-1.5 rounded-md border border-neutral-600 bg-(--surface-inspector) px-2 py-1 text-[13px] text-neutral-200 shadow-lg shadow-black/40" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          <img src={fileIconUrl(dragged.path)} alt="" className="size-4" />
          {dragged.kind === "skill" ? treeParentOf(dragged) : dragged.path}
        </div>
      ) : null}
    </>
  );
}

type FolderActions = { onCreate: (() => void) | null; onDelete: (() => void) | null };

const ROW_ACTION = "inline-flex size-7 items-center justify-center rounded-md opacity-0 transition-colors group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400/60 outline-none";

/** A folder of the tree; while hovered it shows the actions it has. One of the kind's directories is set off in colour, an empty branch dimmed. */
function FolderRow({
  path,
  name,
  depth,
  isExpanded,
  isSelected,
  isKindDir,
  isEmpty,
  isDropTarget,
  entryLabel,
  onToggle,
  actions,
}: {
  path: string;
  name: string;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isKindDir: boolean;
  /** No entry lies anywhere below the folder; it is dimmed so that the branches worth opening stand out. */
  isEmpty: boolean;
  isDropTarget: boolean;
  /** The entry a "+" creates, with its article (`a rule`). */
  entryLabel: string;
  onToggle: () => void;
  actions: FolderActions;
}) {
  const folderIconUrl = useFolderIconUrl();
  const buttonCount = [actions.onCreate, actions.onDelete].filter(Boolean).length;
  const place = path || name;
  return (
    <li className="group relative" data-folder={path} data-tree-key={`${path}/`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        title={place}
        style={{ paddingLeft: 4 + depth * ROW_INDENT, paddingRight: 4 + buttonCount * 28 }}
        className={`flex w-full items-center gap-1 rounded py-1 text-left ${isDropTarget ? "bg-blue-500/25 text-white ring-1 ring-blue-400/60 ring-inset" : isSelected ? "bg-(--row-selected) text-white" : `${isKindDir ? "text-blue-200" : isEmpty ? "text-neutral-500" : "text-neutral-300"} hover:bg-(--row-hover) hover:text-white`}`}
      >
        <ChevronIcon expanded={isExpanded} className="size-3.5 shrink-0 text-neutral-500" />
        <img src={folderIconUrl(place)} alt="" className={`size-4 shrink-0 ${isEmpty ? "opacity-50" : ""}`} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {buttonCount ? (
        <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center">
          {actions.onCreate ? (
            <button type="button" onClick={actions.onCreate} title={`Add ${entryLabel} to ${place}`} aria-label={`Add ${entryLabel} to ${place}`} className={`${ROW_ACTION} text-neutral-400 hover:bg-(--row-hover) hover:text-white`}>
              <PlusIcon />
            </button>
          ) : null}
          {actions.onDelete ? (
            <button type="button" onClick={actions.onDelete} title={`Delete ${place} with everything in it`} aria-label={`Delete ${place} with everything in it`} className={`${ROW_ACTION} text-red-400 hover:bg-red-400/15 hover:text-red-300`}>
              <TrashIcon />
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** An entry of the tree: a click opens it, holding the button and moving drags it (when `onDragStart` is set); the trash shows up while hovered. */
function FileRow({
  entry,
  depth,
  isSelected,
  isDirty,
  isDragged,
  onSelect,
  onDelete,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  entry: Guardrail;
  depth: number;
  isSelected: boolean;
  isDirty: boolean;
  isDragged: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDragStart: ((x: number, y: number) => void) | null;
  onDragMove: (x: number, y: number) => void;
  /** Ends a drag at the pointer position, or without one when the drag was cancelled. */
  onDragEnd: (x: number | null, y: number | null) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const press = useRef<{ x: number; y: number; isDragging: boolean } | null>(null);

  // A drag the tree dropped (Escape) ends here too, so releasing the button neither drops nor selects.
  useEffect(() => {
    if (isDragged || !press.current?.isDragging) return;
    press.current = null;
  }, [isDragged]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    press.current = { x: event.clientX, y: event.clientY, isDragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current) return;
    if (!current.isDragging) {
      if (!onDragStart || Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return;
      current.isDragging = true;
      onDragStart(event.clientX, event.clientY);
    }
    onDragMove(event.clientX, event.clientY);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    press.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (current?.isDragging) {
      onDragEnd(event.clientX, event.clientY);
    } else if (current) {
      onSelect();
    }
  };

  const onPointerCancel = () => {
    const wasDragging = press.current?.isDragging ?? false;
    press.current = null;
    if (wasDragging) {
      onDragEnd(null, null);
    }
  };

  return (
    <li className="group relative" data-tree-key={entry.path}>
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        title={entry.path}
        style={{ paddingLeft: 8 + depth * ROW_INDENT }}
        className={`flex w-full touch-none items-center gap-1.5 rounded py-1 pr-8 text-left ${isSelected ? "bg-(--row-selected) text-white" : "text-neutral-200 hover:bg-(--row-hover) hover:text-white"} ${isDragged ? "opacity-40" : ""}`}
      >
        <img src={fileIconUrl(entry.path)} alt="" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {isDirty ? <span className="size-2 shrink-0 rounded-full bg-amber-300" title="Unsaved changes" /> : null}
      </button>
      <button
        type="button"
        onClick={onDelete}
        title={`Delete ${entry.path}`}
        aria-label={`Delete ${entry.path}`}
        className="absolute top-1/2 right-0.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-red-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-red-400/15 hover:text-red-300 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400/60 outline-none"
      >
        <TrashIcon />
      </button>
    </li>
  );
}
