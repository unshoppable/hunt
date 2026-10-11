import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { folderIconUrl, useFileIconUrl } from "../diff/fileIcons";
import { ChevronIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { useEscapeToClose } from "../ui/useEscapeToClose";
import { expandedForInstructions, folderOf, instructionTreeRows, type Guardrail } from "./guardrails";

/** Indentation of a tree row per folder level, in pixels. */
const ROW_INDENT = 14;

/** How far the pointer has to travel with the button held before a CLAUDE.md row starts being dragged. */
const DRAG_THRESHOLD = 4;

type Drag = {
  /** The CLAUDE.md being dragged. */
  path: string;
  x: number;
  y: number;
  /** The folder under the pointer the file could be dropped into, if any. */
  over: string | null;
};

/**
 * The folders of the worktree as a tree with the CLAUDE.md files in them. Folders on the way to a CLAUDE.md start
 * out open, every other one closed; the chevron toggles. A folder without a CLAUDE.md shows "+" while hovered to
 * create one there and every folder but the root a trash button to delete it with everything in it; a CLAUDE.md
 * row opens the file, shows its trash button while hovered, and can be dragged onto another folder (one without a
 * CLAUDE.md of its own) to move it there.
 */
export function InstructionTree({
  projectName,
  folders,
  instructions,
  selectedPath,
  dirtyPaths,
  onSelect,
  onCreate,
  onMove,
  onDelete,
  onDeleteFolder,
}: {
  projectName: string;
  folders: string[];
  instructions: Guardrail[];
  selectedPath: string | null;
  dirtyPaths: string[];
  onSelect: (path: string) => void;
  /** Creates a CLAUDE.md in the folder (`""` is the root). */
  onCreate: (folder: string) => void;
  onMove: (path: string, folder: string) => void;
  onDelete: (entry: Guardrail) => void;
  /** Deletes the folder with everything in it. */
  onDeleteFolder: (folder: string) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => expandedForInstructions(instructions));
  const [drag, setDrag] = useState<Drag | null>(null);
  const knownPaths = useRef(new Set(instructions.map((entry) => entry.path)));

  // A CLAUDE.md that appeared (created or moved here) opens the folders on its way; folders the user closed stay closed otherwise.
  useEffect(() => {
    const added = instructions.filter((entry) => !knownPaths.current.has(entry.path));
    knownPaths.current = new Set(instructions.map((entry) => entry.path));
    if (!added.length) return;
    setExpanded((current) => new Set([...current, ...expandedForInstructions(added)]));
  }, [instructions]);

  // Escape drops a drag in progress.
  useEscapeToClose(() => setDrag(null), !!drag);

  const toggle = (folder: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  };

  const rows = instructionTreeRows(folders, instructions, expanded, projectName);
  const withInstruction = new Set(instructions.map((entry) => folderOf(entry.path)));

  /** The folder row under the pointer the dragged file may go into: not its own folder and not one holding a CLAUDE.md already. */
  const dropTargetAt = (x: number, y: number, path: string): string | null => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder]");
    if (!row) return null;
    const folder = row.dataset.folder ?? "";
    return folder !== folderOf(path) && !withInstruction.has(folder) ? folder : null;
  };

  const dragged = drag ? instructions.find((entry) => entry.path === drag.path) : null;

  return (
    <>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-[13px]" aria-label="Folders">
        {rows.map((row) =>
          row.type === "folder" ? (
            <FolderRow
              key={`folder:${row.path}`}
              path={row.path}
              name={row.name}
              depth={row.depth}
              isExpanded={expanded.has(row.path)}
              hasInstruction={row.hasInstruction}
              isDropTarget={drag?.over === row.path}
              onToggle={() => toggle(row.path)}
              onCreate={() => onCreate(row.path)}
              onDelete={row.path ? () => onDeleteFolder(row.path) : null}
            />
          ) : (
            <FileRow
              key={row.entry.path}
              entry={row.entry}
              depth={row.depth}
              isSelected={row.entry.path === selectedPath}
              isDirty={dirtyPaths.includes(row.entry.path)}
              isDragged={drag?.path === row.entry.path}
              onSelect={() => onSelect(row.entry.path)}
              onDelete={() => onDelete(row.entry)}
              onDragStart={(x, y) => setDrag({ path: row.entry.path, x, y, over: null })}
              onDragMove={(x, y) => setDrag((current) => (current ? { ...current, x, y, over: dropTargetAt(x, y, current.path) } : current))}
              onDragEnd={(x, y) => {
                const target = x === null || y === null ? null : dropTargetAt(x, y, row.entry.path);
                if (target !== null) {
                  onMove(row.entry.path, target);
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
          {dragged.path}
        </div>
      ) : null}
    </>
  );
}

/**
 * A folder of the tree; while hovered it shows the "+" when the folder has no CLAUDE.md yet and the trash when it
 * can be deleted.
 */
function FolderRow({
  path,
  name,
  depth,
  isExpanded,
  hasInstruction,
  isDropTarget,
  onToggle,
  onCreate,
  onDelete,
}: {
  path: string;
  name: string;
  depth: number;
  isExpanded: boolean;
  hasInstruction: boolean;
  isDropTarget: boolean;
  onToggle: () => void;
  onCreate: () => void;
  /** Null for the root, which cannot be deleted. */
  onDelete: (() => void) | null;
}) {
  const buttonCount = (hasInstruction ? 0 : 1) + (onDelete ? 1 : 0);
  return (
    <li className="group relative" data-folder={path}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        title={path || name}
        style={{ paddingLeft: 4 + depth * ROW_INDENT, paddingRight: 4 + buttonCount * 28 }}
        className={`flex w-full items-center gap-1 rounded-md py-1 text-left ${isDropTarget ? "bg-blue-500/25 text-white ring-1 ring-blue-400/60 ring-inset" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
      >
        <ChevronIcon expanded={isExpanded} className="size-3.5 shrink-0 text-neutral-500" />
        <img src={folderIconUrl(name)} alt="" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {buttonCount ? (
        <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center">
          {hasInstruction ? null : (
            <button
              type="button"
              onClick={onCreate}
              title={`Add a CLAUDE.md to ${path || name}`}
              aria-label={`Add a CLAUDE.md to ${path || name}`}
              className="inline-flex size-7 items-center justify-center rounded-md text-neutral-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-(--row-hover) hover:text-white focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400/60 outline-none"
            >
              <PlusIcon />
            </button>
          )}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              title={`Delete ${path} with everything in it`}
              aria-label={`Delete ${path} with everything in it`}
              className="inline-flex size-7 items-center justify-center rounded-md text-red-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-red-400/15 hover:text-red-300 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400/60 outline-none"
            >
              <TrashIcon />
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

/** A CLAUDE.md of the tree: a click opens it, holding the button and moving drags it; the trash shows up while hovered. */
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
  onDragStart: (x: number, y: number) => void;
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
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return;
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
    <li className="group relative">
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
        className={`flex w-full touch-none items-center gap-1.5 rounded-md py-1 pr-8 text-left ${isSelected ? "bg-(--row-active) text-white" : "text-neutral-200 hover:bg-(--row-hover) hover:text-white"} ${isDragged ? "opacity-40" : ""}`}
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
