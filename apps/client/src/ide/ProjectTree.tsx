import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { isWorktreeLocked, WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";
import { commands } from "../ipc/commands";
import type { DirEntry } from "../ipc/types";
import { rootFolderIconUrl, useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import { useHuntStore } from "../state/store";
import { AgentButton } from "../ui/AgentButton";
import { confirmDestructive } from "../ui/confirm";
import { dirName, outermostPaths } from "../ui/path";
import { shortcutCommand, useShortcutLabel } from "../ui/shortcuts";
import { UnsavedDot } from "../ui/UnsavedDot";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";
import { toggleInExpanded } from "../ui/treeExpansion";
import type { TreeNavRow } from "../ui/treeNavigation";
import { extendSelection, singleSelection, toggleInSelection, visibleSelection, type TreeSelection } from "../ui/treeSelection";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import type { Workspace } from "./documents";
import { EMPTY_MARKS, FOLDER_COLORS, FOLDER_COLOR_NAMES, markedColor, useFolderColorStore, type FolderColor } from "./folderColors";
import { useIdeStore } from "./ideStore";
import { selectionChatsFor, useBusyChatIds } from "./selectionChats";

type Row = { path: string; name: string; isDir: boolean; depth: number };

/** The file or folder row whose agent button was clicked. */
export type ProjectTreeTarget = { path: string; isFolder: boolean };

/**
 * The row a right click opened the context menu for (`""` is the project row), and where; `paths` are the rows copy
 * and delete act on: the selection when the row is part of it, otherwise the row alone.
 */
type ContextMenuState = { x: number; y: number; path: string; name: string; isDir: boolean; paths: readonly string[] };

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

/** The confirmation for deleting `entries`; a long list names the first ten. */
function deleteQuestion(entries: readonly Pick<Row, "path" | "isDir">[]): string {
  if (entries.length === 1) return entries[0].isDir ? `Delete the folder ${entries[0].path} with everything in it?` : `Delete ${entries[0].path}?`;
  const names = entries.slice(0, 10).map((entry) => entry.path);
  if (entries.length > names.length) {
    names.push(`… and ${entries.length - names.length} more`);
  }
  const folderNote = entries.some((entry) => entry.isDir) ? ", folders with everything in them" : "";
  return `Delete ${entries.length} items${folderNote}?\n\n${names.join("\n")}`;
}

/**
 * The project view: a lazily listed tree of the worktree with WebStorm's file icons, changelist colors and
 * file colors (a folder marked through its context menu tints itself and everything below it; the marks are
 * kept per repository, see folderColors.ts). A click selects a row, ⇧-click every row from the last clicked one to it,
 * ⌘-click adds or removes a row. The context menu also copies the absolute paths of the selected rows (⌃⇧C) and
 * deletes them (⌘⌫), closing their tabs. The selection changes on click, with the arrow keys and on `revealRequest`
 * (⇧⌘2), never when the editor's active tab changes; Enter opens the selected file. `refreshVersion` relists every
 * open directory. Every file and folder row has an agent button that opens a sub chat about the whole file or folder; it
 * shows on hover, or always once such a chat exists, also one opened from the changelist.
 */
export function ProjectTree({
  sessionId,
  repoPath,
  projectName,
  revealRequest,
  refreshVersion,
  unsavedPaths,
  workspace,
  onOpen,
  onAskAgent,
}: {
  sessionId: string;
  repoPath: string;
  projectName: string;
  revealRequest: { path: string; nonce: number; isFolder?: boolean } | null;
  refreshVersion: number;
  /** Files with unsaved edits; they get a blue dot. */
  unsavedPaths: readonly string[];
  workspace: Workspace;
  onOpen: (path: string) => void;
  /** Opens the sub chat about the whole file or folder next to its agent button. */
  onAskAgent: (target: ProjectTreeTarget, button: HTMLElement) => void;
}) {
  const [listings, setListings] = useState<Listings>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [statusByPath, setStatusByPath] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const marks = useFolderColorStore((state) => state.marksByRepo[repoPath] ?? EMPTY_MARKS);
  const setFolderColor = useFolderColorStore((state) => state.setFolderColor);
  const isLocked = useHuntStore((state) => isWorktreeLocked(state.sessions, state.remoteLinks, sessionId));
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const sessions = useHuntStore((state) => state.sessions);
  const busyChatIds = useBusyChatIds();
  const closeTabsOf = useIdeStore((state) => state.closeTabsOf);
  const copyPathShortcut = useShortcutLabel("changes.copyPath");
  const deleteShortcut = useShortcutLabel("editor.deleteInTree");

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

  /**
   * Paths with a sub chat about the whole file or folder (a selection with a task), whose agent button stays visible,
   * mapped to whether that chat's agent is running a turn, which makes the button pulse.
   */
  const agentChats = useMemo(() => {
    const result = new Map<string, boolean>();
    const paths = new Set(sessions.flatMap((session) => (session.selection?.task ? [session.selection.path] : [])));
    for (const path of paths) {
      const chats = selectionChatsFor(sessions, sessionId, path).filter((chat) => !!chat.selection.task);
      if (!chats.length) continue;
      result.set(path, chats.some((chat) => busyChatIds.has(chat.sessionId)));
    }
    return result;
  }, [sessions, sessionId, busyChatIds]);

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
    setExpanded((current) => toggleInExpanded(current, path));
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

  const rowKeys = useMemo(() => navRows.map((row) => row.key), [navRows]);
  const selectedPaths = useMemo(() => visibleSelection(selection, rowKeys), [selection, rowKeys]);
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const selectOnly = (path: string) => setSelection(singleSelection(path));

  const nav = useTreeNavigation({ rows: navRows, selectedKey: selection?.lead ?? null, onSelect: selectOnly, onToggle: toggle, onActivate: onOpen });
  const { listRef } = nav;

  // ⇧⌘2: list and expand every ancestor, then scroll the file into view; a revealed folder is expanded as well. The
  // focus stays where it is, so the editor keeps the caret.
  const revealPath = revealRequest?.path ?? "";
  useLoad(
    async () => {
      const folders = revealRequest?.isFolder ? [...parentPaths(revealPath), revealPath] : parentPaths(revealPath);
      for (const folder of folders) {
        await list(folder);
      }
      return folders;
    },
    {
      onValue: (folders) => {
        setExpanded((current) => new Set([...current, ...folders]));
        selectOnly(revealPath);
        setScrollTarget(revealPath);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [revealRequest, list],
    { isEnabled: !!revealRequest },
  );

  /** A click selects the row and opens it (a folder toggles), ⇧-click selects the range up to it, ⌘-click adds or removes it. */
  const clickRow = (event: MouseEvent, row: Pick<Row, "path" | "isDir">) => {
    if (event.shiftKey) {
      setSelection(extendSelection(selection, rowKeys, row.path));
    } else if (event.metaKey) {
      setSelection(toggleInSelection(selection, row.path));
    } else {
      selectOnly(row.path);
      if (row.isDir) {
        toggle(row.path);
      } else {
        onOpen(row.path);
      }
    }
  };

  const openContextMenu = (event: MouseEvent, row: Pick<Row, "path" | "name" | "isDir">) => {
    event.preventDefault();
    const paths = selectedPathSet.has(row.path) ? selectedPaths : [row.path];
    if (paths.length === 1) {
      selectOnly(row.path);
    }
    setContextMenu({ x: event.clientX, y: event.clientY, path: row.path, name: row.name, isDir: row.isDir, paths });
  };

  const markFolder = (color: FolderColor | null) => {
    if (!contextMenu) return;
    setFolderColor(repoPath, contextMenu.path, color);
    setContextMenu(null);
  };

  /** Puts the absolute paths of the worktree-relative `paths` on the clipboard, one per line; `""` is the worktree itself. */
  const copyPaths = (paths: readonly string[]) => {
    const absolutePaths = paths.map((path) => (path ? `${workspace.worktreePath}/${path}` : workspace.worktreePath));
    void navigator.clipboard.writeText(absolutePaths.join("\n")).catch((reason) => setError(`failed to copy the path: ${errorText(reason)}`));
  };

  /**
   * Deletes files, and folders with everything in them, after asking once; their tabs close and their unsaved edits
   * are dropped. The project row cannot be deleted, so a selection holding it deletes nothing.
   */
  const deletePaths = async (paths: readonly string[]) => {
    setContextMenu(null);
    if (!paths.length || paths.includes("")) return;
    if (isLocked) {
      setError(WORKTREE_LOCKED_MESSAGE);
      return;
    }
    const entries = outermostPaths(paths).map((path) => ({ path, isDir: rows.find((row) => row.path === path)?.isDir ?? false }));
    if (!(await confirmDestructive(deleteQuestion(entries)))) return;
    const deleted: string[] = [];
    let failure: string | null = null;
    for (const entry of entries) {
      try {
        await commands.deletePath(sessionId, entry.path);
      } catch (reason) {
        failure = errorText(reason);
        break;
      }
      deleted.push(entry.path);
      closeTabsOf(sessionId, entry.path);
      workspace.discardDeleted(entry.path);
    }
    setError(failure);
    if (!deleted.length) return;
    selectOnly(dirName(deleted[0]));
    noteWorktreeChanged(sessionId);
  };

  useEffect(() => {
    if (!scrollTarget) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(scrollTarget)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    setScrollTarget(null);
  }, [scrollTarget, rows, listRef]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-(--line) px-2 text-[13px] text-neutral-400">Project</div>
      {error ? <p className="border-b border-(--line) px-2 py-2 text-[13px] text-red-400">{error}</p> : null}
      <ul
        {...nav.listProps}
        onKeyDown={(event) => {
          const command = selectedPaths.length ? shortcutCommand(event, ["changes.copyPath", "editor.deleteInTree"]) : null;
          if (!command) {
            nav.listProps.onKeyDown(event);
            return;
          }
          event.preventDefault();
          if (command === "changes.copyPath") {
            copyPaths(selectedPaths);
          } else {
            void deletePaths(selectedPaths);
          }
        }}
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
          isSelected={selectedPathSet.has("")}
          status={undefined}
          color={null}
          onClick={(event) => clickRow(event, { path: "", isDir: true })}
          onContextMenu={(event) => openContextMenu(event, { path: "", name: projectName, isDir: true })}
        />
        {rows.map((row) => (
          <TreeRow
            key={row.path}
            {...row}
            isExpanded={expanded.has(row.path)}
            isSelected={selectedPathSet.has(row.path)}
            status={statusByPath[row.path]}
            isUnsaved={!row.isDir && unsavedPaths.includes(row.path)}
            color={markedColor(marks, row.path)}
            hasAgentChat={agentChats.has(row.path)}
            isAgentBusy={agentChats.get(row.path) ?? false}
            onClick={(event) => clickRow(event, row)}
            onContextMenu={(event) => openContextMenu(event, row)}
            onAskAgent={(button) => onAskAgent({ path: row.path, isFolder: row.isDir }, button)}
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
          <div className="mb-1 truncate border-b border-(--line) px-2 pb-1 font-mono text-[12px] text-neutral-500" title={contextMenu.paths.join("\n") || contextMenu.name}>
            {contextMenu.paths.length > 1 ? `${contextMenu.paths.length} items` : contextMenu.name}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              copyPaths(contextMenu.paths);
            }}
            className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left text-neutral-200 hover:bg-(--row-hover)"
          >
            {contextMenu.paths.length > 1 ? "Copy paths" : "Copy path"}
            {copyPathShortcut ? <span className="text-neutral-500">{copyPathShortcut}</span> : null}
          </button>
          {contextMenu.isDir && contextMenu.path && contextMenu.paths.length === 1 ? (
            <>
              <div role="separator" className="my-1 border-t border-(--line)" />
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
            </>
          ) : null}
          {!contextMenu.paths.includes("") ? (
            <>
              <div role="separator" className="my-1 border-t border-(--line)" />
              <button
                type="button"
                role="menuitem"
                onClick={() => (isLocked ? undefined : void deletePaths(contextMenu.paths))}
                aria-disabled={isLocked}
                title={isLocked ? WORKTREE_LOCKED_MESSAGE : undefined}
                className={`flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left text-red-300 hover:bg-(--row-hover) ${isLocked ? "opacity-40" : ""}`}
              >
                {contextMenu.paths.length > 1 ? `Delete ${contextMenu.paths.length} items` : contextMenu.isDir ? "Delete folder" : "Delete file"}
                {deleteShortcut ? <span className="text-neutral-500">{deleteShortcut}</span> : null}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row: the folder color is its background, hover is a translucent layer over it and the selection replaces
 * both (WebStorm's blue), so a selected row reads the same in every folder. With `onAskAgent` the row ends in the agent
 * button, which shows on hover or, with `hasAgentChat`, always.
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
  hasAgentChat = false,
  isAgentBusy = false,
  onClick,
  onContextMenu,
  onAskAgent,
}: Row & {
  isExpanded: boolean;
  isSelected: boolean;
  status: string | undefined;
  isUnsaved?: boolean;
  color: FolderColor | null;
  hasAgentChat?: boolean;
  isAgentBusy?: boolean;
  onClick: (event: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
  onAskAgent?: (button: HTMLElement) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const folderIconUrl = useFolderIconUrl();
  const agentLabel = hasAgentChat ? `Show the agent's chat about this ${isDir ? "folder" : "file"}` : `Ask the agent about this ${isDir ? "folder" : "file"}`;
  return (
    <li
      data-tree-key={path}
      tabIndex={-1}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={path || name}
      data-selected={isSelected}
      className="tree-row group flex cursor-pointer items-center gap-[5px] pr-2.5 outline-none select-none"
      style={{ paddingLeft: `calc(10px + ${depth} * var(--changelist-indent))`, backgroundColor: color ? FOLDER_COLORS[color].background : undefined }}
    >
      {isDir ? <ChevronIcon expanded={isExpanded} /> : <span className="size-4 shrink-0" />}
      <img src={!isDir ? fileIconUrl(path) : path ? folderIconUrl(path, isExpanded) : rootFolderIconUrl(isExpanded)} alt="" className="size-[17px] shrink-0" />
      <span className={`truncate ${isDir ? "text-neutral-300" : (STATUS_NAME_CLASS[status ?? ""] ?? "text-neutral-200")}`}>{name}</span>
      {isUnsaved ? <UnsavedDot /> : null}
      {onAskAgent ? (
        <AgentButton
          onClick={(event) => {
            event.stopPropagation();
            onAskAgent(event.currentTarget);
          }}
          isBusy={isAgentBusy}
          size={24}
          sparkleSize={20}
          className={`-my-1 ml-auto transition-opacity focus-visible:opacity-100 ${hasAgentChat ? "" : "opacity-0 group-hover:opacity-100"}`}
          title={agentLabel}
          aria-label={agentLabel}
        />
      ) : null}
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
