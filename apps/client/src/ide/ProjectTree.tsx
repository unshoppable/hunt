import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { DirEntry } from "../ipc/types";
import { rootFolderIconUrl, useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import { UnsavedDot } from "../ui/UnsavedDot";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";
import type { TreeNavRow } from "../ui/treeNavigation";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import { EMPTY_MARKS, FOLDER_COLORS, FOLDER_COLOR_NAMES, markedColor, useFolderColorStore, type FolderColor } from "./folderColors";

type Row = { path: string; name: string; isDir: boolean; depth: number };

/** The folder a right click opened the context menu for, and where. */
type ContextMenuState = { x: number; y: number; path: string; name: string };

/** Directories listed so far, keyed by worktree-relative path ("" is the root). */
type Listings = Record<string, DirEntry[]>;

function parentPaths(path: string): string[] {
  const segments = path.split("/");
  const result: string[] = [""];
  for (let index = 1; index < segments.length; index++) {
    result.push(segments.slice(0, index).join("/"));
  }
  return result;
}

/**
 * The project view: a lazily listed tree of the worktree with WebStorm's file icons, changelist colors and
 * file colors (a folder marked through its context menu tints itself and everything below it; the marks are
 * kept per repository, see folderColors.ts). The selection changes on click, with the arrow keys and on `revealRequest`
 * (⇧⌘2), never when the editor's active tab changes; Enter opens the selected file. `refreshVersion` relists every
 * open directory.
 */
export function ProjectTree({
  sessionId,
  repoPath,
  projectName,
  revealRequest,
  refreshVersion,
  unsavedPaths,
  onOpen,
}: {
  sessionId: string;
  repoPath: string;
  projectName: string;
  revealRequest: { path: string; nonce: number } | null;
  refreshVersion: number;
  /** Files with unsaved edits; they get a blue dot. */
  unsavedPaths: readonly string[];
  onOpen: (path: string) => void;
}) {
  const [listings, setListings] = useState<Listings>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [statusByPath, setStatusByPath] = useState<Record<string, string>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const marks = useFolderColorStore((state) => state.marksByRepo[repoPath] ?? EMPTY_MARKS);
  const setFolderColor = useFolderColorStore((state) => state.setFolderColor);

  useDismiss(contextMenuRef, () => setContextMenu(null), { closeOnWindowBlur: true, isEnabled: !!contextMenu });

  const list = useCallback(
    async (path: string) => {
      const entries = await commands.listDir(sessionId, path);
      setListings((current) => ({ ...current, [path]: entries }));
    },
    [sessionId],
  );

  useEffect(() => {
    list("").catch((reason) => setError(String(reason)));
  }, [list]);

  // Agent edits, saves and reverts change listings and statuses; relist what is open instead of resetting the tree.
  useEffect(() => {
    const paths = Object.keys(listings);
    Promise.allSettled(paths.map(list)).catch(() => {});
    commands
      .listChangedFiles(sessionId)
      .then((files) => setStatusByPath(Object.fromEntries(files.map((file) => [file.path, file.status]))))
      .catch(() => {});
    // `listings` is intentionally not a dependency: it is relisted, never a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshVersion, sessionId, list]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visit = (path: string, depth: number) => {
      for (const entry of listings[path] ?? []) {
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        result.push({ path: entryPath, name: entry.name, isDir: entry.isDir, depth });
        if (entry.isDir && expanded.has(entryPath)) {
          visit(entryPath, depth + 1);
        }
      }
    };
    if (expanded.has("")) {
      visit("", 1);
    }
    return result;
  }, [listings, expanded]);

  const toggle = (path: string) => {
    const willExpand = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (willExpand) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
    if (willExpand && !listings[path]) {
      list(path).catch((reason) => setError(String(reason)));
    }
  };

  /** The project row (`""`) and every visible row, as keyboard navigation sees them. */
  const navRows = useMemo<TreeNavRow[]>(
    () => [
      { key: "", depth: 0, isExpanded: expanded.has("") },
      ...rows.map((row) => ({ key: row.path, depth: row.depth, isExpanded: row.isDir ? expanded.has(row.path) : undefined })),
    ],
    [rows, expanded],
  );

  const nav = useTreeNavigation({ rows: navRows, selectedKey: selectedPath, onSelect: setSelectedPath, onToggle: toggle, onActivate: onOpen });
  const { listRef } = nav;

  // ⇧⌘2: list and expand every ancestor, then scroll the file into view.
  const revealPath = revealRequest?.path ?? "";
  useLoad(
    async () => {
      const ancestors = parentPaths(revealPath);
      for (const ancestor of ancestors) {
        await list(ancestor);
      }
      return ancestors;
    },
    {
      onValue: (ancestors) => {
        setExpanded((current) => new Set([...current, ...ancestors]));
        setSelectedPath(revealPath);
        setScrollTarget(revealPath);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [revealRequest, list],
    { isEnabled: !!revealRequest },
  );

  const openContextMenu = (event: MouseEvent, row: Row) => {
    event.preventDefault();
    setSelectedPath(row.path);
    setContextMenu({ x: event.clientX, y: event.clientY, path: row.path, name: row.name });
  };

  const markFolder = (color: FolderColor | null) => {
    if (!contextMenu) return;
    setFolderColor(repoPath, contextMenu.path, color);
    setContextMenu(null);
  };

  useEffect(() => {
    if (!scrollTarget) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(scrollTarget)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.focus();
    setScrollTarget(null);
  }, [scrollTarget, rows, listRef]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-(--line) px-2 text-[13px] text-neutral-400">Project</div>
      {error ? <p className="border-b border-(--line) px-2 py-2 text-[13px] text-red-400">{error}</p> : null}
      <ul
        {...nav.listProps}
        className="min-h-0 flex-1 overflow-auto py-1 outline-none font-(family-name:--changelist-font-family) text-(length:--changelist-font-size)"
        // The changelist's line height is a unitless factor of the font size.
        style={{ lineHeight: "calc(var(--changelist-line-height) * 1em)" }}
      >
        <TreeRow
          path=""
          name={projectName}
          isDir
          depth={0}
          isExpanded={expanded.has("")}
          isSelected={nav.cursor === ""}
          status={undefined}
          color={null}
          onClick={() => {
            nav.select("");
            toggle("");
          }}
        />
        {rows.map((row) => (
          <TreeRow
            key={row.path}
            {...row}
            isExpanded={expanded.has(row.path)}
            isSelected={nav.cursor === row.path}
            status={statusByPath[row.path]}
            isUnsaved={!row.isDir && unsavedPaths.includes(row.path)}
            color={markedColor(marks, row.path)}
            onClick={() => {
              nav.select(row.path);
              if (row.isDir) {
                toggle(row.path);
              } else {
                onOpen(row.path);
              }
            }}
            onContextMenu={row.isDir ? (event) => openContextMenu(event, row) : undefined}
          />
        ))}
      </ul>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="fixed z-50 min-w-36 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] shadow-lg"
        >
          <div className="mb-1 truncate border-b border-(--line) px-2 pb-1 font-mono text-[12px] text-neutral-500" title={contextMenu.path}>
            {contextMenu.name}
          </div>
          {FOLDER_COLOR_NAMES.map((color) => (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={marks[contextMenu.path] === color}
              onClick={() => markFolder(color)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-neutral-200 hover:bg-(--row-hover) aria-checked:bg-(--row-selected)"
            >
              <span className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: FOLDER_COLORS[color].swatch }} />
              {FOLDER_COLORS[color].label}
            </button>
          ))}
          {marks[contextMenu.path] ? (
            <button type="button" role="menuitem" onClick={() => markFolder(null)} className="mt-1 block w-full rounded border-t border-(--line) px-2 pt-2 pb-1 text-left text-neutral-400 hover:bg-(--row-hover)">
              Remove color
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row: the folder color is its background, hover is a translucent layer over it and the selection replaces
 * both (WebStorm's blue), so a selected row reads the same in every folder.
 */
function TreeRow({
  path,
  name,
  isDir,
  depth,
  isExpanded,
  isSelected,
  status,
  isUnsaved = false,
  color,
  onClick,
  onContextMenu,
}: Row & {
  isExpanded: boolean;
  isSelected: boolean;
  status: string | undefined;
  isUnsaved?: boolean;
  color: FolderColor | null;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const folderIconUrl = useFolderIconUrl();
  return (
    <li
      data-tree-key={path}
      tabIndex={-1}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={path || name}
      data-selected={isSelected}
      className="tree-row flex cursor-pointer items-center gap-[5px] pr-2.5 outline-none select-none"
      style={{ paddingLeft: `calc(10px + ${depth} * var(--changelist-indent))`, backgroundColor: color ? FOLDER_COLORS[color].background : undefined }}
    >
      {isDir ? <ChevronIcon expanded={isExpanded} /> : <span className="size-4 shrink-0" />}
      <img src={!isDir ? fileIconUrl(path) : path ? folderIconUrl(path, isExpanded) : rootFolderIconUrl(isExpanded)} alt="" className="size-[17px] shrink-0" />
      <span className={`truncate ${isDir ? "text-neutral-300" : (STATUS_NAME_CLASS[status ?? ""] ?? "text-neutral-200")}`}>{name}</span>
      {isUnsaved ? <UnsavedDot /> : null}
    </li>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 text-neutral-500 transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
