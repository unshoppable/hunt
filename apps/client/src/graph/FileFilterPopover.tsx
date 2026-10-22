import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { buildChangeTree, folderPaths, type FolderNode, type TreeNode } from "../diff/changeTree";
import { Checkbox, type CheckState } from "../diff/Checkbox";
import { useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import type { ChangedFile } from "../ipc/types";
import { ResizeGrips } from "../ui/ResizeGrips";
import { toggleInCollapsed } from "../ui/treeExpansion";
import type { TreeNavRow } from "../ui/treeNavigation";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import { useDismiss } from "../ui/useDismiss";
import { usePopupSize } from "../ui/usePopupSize";
import { useViewportSize } from "../ui/useViewportSize";

/** One visible row of the tree; `depth` is the indentation level. */
type Row = { node: TreeNode; depth: number };

const MIN_SIZE = { width: 220, height: 120 };
/** The largest share of the window's width and height the popover may take. */
const MAX_SHARE = 0.8;

/**
 * Popover below the "Files" button: the changelist as a folder tree with a checkbox per file and folder. Every file
 * starts checked; unchecking hides the file from the diagram, a folder checkbox toggles everything below it. The
 * relevance and glob filters play no part here: the count and the checkboxes reflect only the checked files.
 * The list takes the focus: the arrow keys move through the rows and open or close the folders, Space (Enter on a file)
 * toggles the row's checkbox. Closes on Escape or a click outside; a press on the button that opened it (`anchorRef`)
 * closes without reopening.
 * It is as tall as its rows up to the remembered height; dragging its right or bottom edge resizes it.
 */
export function FileFilterPopover({
  files,
  excluded,
  onChange,
  onClose,
  anchorRef,
}: {
  files: ChangedFile[];
  /** Paths of the unchecked files. */
  excluded: Set<string>;
  onChange: (excluded: Set<string>) => void;
  onClose: () => void;
  /** The "Files" button the popover hangs below. */
  anchorRef: RefObject<HTMLButtonElement | null>;
}) {
  const fileIconUrl = useFileIconUrl();
  const folderIconUrl = useFolderIconUrl();
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildChangeTree(files), [files]);
  const viewport = useViewportSize();
  const { size, isHeightSet, grips } = usePopupSize("fileFilter", { min: MIN_SIZE, max: { width: viewport.width * MAX_SHARE, height: viewport.height * MAX_SHARE } });

  useDismiss(rootRef, onClose, { anchorRefs: [anchorRef] });

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visit = (folder: FolderNode, depth: number) => {
      for (const child of folder.children) {
        result.push({ node: child, depth });
        if (child.kind === "folder" && !collapsed.has(child.path)) {
          visit(child, depth + 1);
        }
      }
    };
    visit(tree, 0);
    return result;
  }, [tree, collapsed]);

  const stateOf = (targets: ChangedFile[]): CheckState => {
    const checkedCount = targets.filter((file) => !excluded.has(file.path)).length;
    if (checkedCount === 0) return "unchecked";
    return checkedCount === targets.length ? "checked" : "mixed";
  };

  const setChecked = (targets: ChangedFile[], isChecked: boolean) => {
    const next = new Set(excluded);
    for (const file of targets) {
      if (isChecked) {
        next.delete(file.path);
      } else {
        next.add(file.path);
      }
    }
    onChange(next);
  };

  const toggleGroup = (targets: ChangedFile[]) => setChecked(targets, stateOf(targets) !== "checked");

  const toggleCollapsed = (path: string) => {
    setCollapsed((current) => toggleInCollapsed(current, path, folderPaths(tree)));
  };

  /** A folder's key is its path with a trailing slash, a file's its path. */
  const navRows = useMemo<TreeNavRow[]>(
    () => rows.map(({ node, depth }) => (node.kind === "folder" ? { key: `${node.path}/`, depth, isExpanded: !collapsed.has(node.path) } : { key: node.file.path, depth })),
    [rows, collapsed],
  );

  /** Toggles the checkbox of the row with `key`. */
  const toggleRow = (key: string) => {
    const node = rows.find((row) => (row.node.kind === "folder" ? `${row.node.path}/` : row.node.file.path) === key)?.node;
    if (!node) return;
    if (node.kind === "folder") {
      toggleGroup(node.files);
    } else {
      setChecked([node.file], excluded.has(node.file.path));
    }
  };

  const nav = useTreeNavigation({ rows: navRows, onToggle: (key) => toggleCollapsed(key.slice(0, -1)), onActivate: toggleRow, onCheck: toggleRow });
  const { listRef } = nav;

  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [listRef]);

  const checkedCount = files.filter((file) => !excluded.has(file.path)).length;
  const indent = (depth: number) => ({ paddingLeft: `calc(8px + ${depth} * 14px)` });

  return (
    <div
      ref={rootRef}
      className="absolute top-full left-0 z-20 mt-1 flex flex-col rounded-md border border-neutral-600 bg-(--surface-inset) text-[13px] shadow-lg"
      style={{ width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
    >
      <div className="flex items-center gap-2 border-b border-(--line) px-2 py-2 text-neutral-400">
        <Checkbox state={files.length ? stateOf(files) : "unchecked"} onChange={() => toggleGroup(files)} title="Show all files" />
        <span>
          {checkedCount} of {files.length} shown
        </span>
      </div>
      <ul {...nav.listProps} className="min-h-0 flex-1 overflow-y-auto p-1 leading-6 outline-none">
        {rows.map(({ node, depth }) =>
          node.kind === "folder" ? (
            <li
              key={`dir:${node.path}`}
              data-tree-key={`${node.path}/`}
              className={`flex items-center gap-1.5 rounded pr-2 ${nav.cursor === `${node.path}/` ? "bg-(--row-selected)" : "hover:bg-(--row-hover)"}`}
              style={indent(depth)}
            >
              <Checkbox state={stateOf(node.files)} onChange={() => toggleGroup(node.files)} />
              <button
                type="button"
                onClick={() => {
                  toggleCollapsed(node.path);
                  nav.select(`${node.path}/`);
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                title={node.path}
              >
                <ChevronIcon expanded={!collapsed.has(node.path)} />
                <img src={folderIconUrl(node.path)} alt="" className="size-4 shrink-0" />
                <span className="truncate text-neutral-300">{node.name}</span>
                <span className="pl-1 text-[12px] text-neutral-600">{node.files.length}</span>
              </button>
            </li>
          ) : (
            <li
              key={node.file.path}
              data-tree-key={node.file.path}
              className={`flex items-center gap-1.5 rounded pr-2 ${nav.cursor === node.file.path ? "bg-(--row-selected)" : "hover:bg-(--row-hover)"}`}
              style={indent(depth)}
            >
              <Checkbox state={excluded.has(node.file.path) ? "unchecked" : "checked"} onChange={() => setChecked([node.file], excluded.has(node.file.path))} />
              <label
                className="flex min-w-0 flex-1 items-center gap-1.5"
                title={`${node.file.path} (${node.file.status})`}
                onClick={() => {
                  setChecked([node.file], excluded.has(node.file.path));
                  nav.select(node.file.path);
                }}
              >
                <img src={fileIconUrl(node.file.path)} alt="" className="size-4 shrink-0" />
                <span className={`truncate ${STATUS_NAME_CLASS[node.file.status] ?? "text-neutral-200"}`}>{node.name}</span>
              </label>
            </li>
          ),
        )}
        {!files.length ? <li className="px-3 py-2 text-neutral-500">No uncommitted changes.</li> : null}
      </ul>
      <ResizeGrips edges={{ right: true, bottom: true }} {...grips} />
    </div>
  );
}

/** Disclosure arrow of a folder row: points right when collapsed and down when expanded. */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 text-neutral-500 transition-transform ${expanded ? "rotate-90" : ""}`}
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
