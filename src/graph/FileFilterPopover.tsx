import { useMemo, useRef, useState, type RefObject } from "react";
import { buildChangeTree, type FolderNode, type TreeNode } from "../diff/changeTree";
import { Checkbox, type CheckState } from "../diff/Checkbox";
import { folderIconUrl, useFileIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import type { ChangedFile } from "../ipc/types";
import { baseName } from "../ui/path";
import { ResizeGrips } from "../ui/ResizeGrips";
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
 * starts checked; unchecking hides the file from the diagram, a folder checkbox toggles everything below it.
 * Closes on Escape or a click outside; a press on the button that opened it (`anchorRef`) closes without reopening.
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
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const shownCount = files.length - files.filter((file) => excluded.has(file.path)).length;
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
          {shownCount} of {files.length} shown
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1 leading-6">
        {rows.map(({ node, depth }) =>
          node.kind === "folder" ? (
            <li key={`dir:${node.path}`} className="flex items-center gap-1.5 pr-2 hover:bg-(--row-hover)" style={indent(depth)}>
              <Checkbox state={stateOf(node.files)} onChange={() => toggleGroup(node.files)} />
              <button type="button" onClick={() => toggleCollapsed(node.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={node.path}>
                <ChevronIcon expanded={!collapsed.has(node.path)} />
                <img src={folderIconUrl(baseName(node.name))} alt="" className="size-4 shrink-0" />
                <span className="truncate text-neutral-300">{node.name}</span>
                <span className="pl-1 text-[12px] text-neutral-600">{node.files.length}</span>
              </button>
            </li>
          ) : (
            <li key={node.file.path} className="flex items-center gap-1.5 pr-2 hover:bg-(--row-hover)" style={indent(depth)}>
              <Checkbox state={excluded.has(node.file.path) ? "unchecked" : "checked"} onChange={() => setChecked([node.file], excluded.has(node.file.path))} />
              <label className="flex min-w-0 flex-1 items-center gap-1.5" title={`${node.file.path} (${node.file.status})`} onClick={() => setChecked([node.file], excluded.has(node.file.path))}>
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
