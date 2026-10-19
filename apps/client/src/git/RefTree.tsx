import { useMemo, useState, type MouseEvent } from "react";
import type { GitRef, RefList } from "../ipc/types";
import { useFolderIconUrl } from "../diff/fileIcons";
import { ICON_BUTTON_XS } from "../ui/buttons";
import { BranchIcon, ChevronIcon, TrashIcon } from "../ui/icons";
import type { PushRoute } from "./branchActions";
import { buildRefTree, type RefTreeNode } from "./refGroups";

/** Collapsed groups, kept across session switches for the window's lifetime; tags start collapsed. */
const collapsedGroups = new Set<string>(["tags"]);

type Row = { node: RefTreeNode; depth: number };

/**
 * The branch tree beside the log: Local, Remote and Tags, nested by the slashes in their names. A click on a branch
 * or tag shows only its history, a second click shows every branch again; a right click on a branch opens its menu
 * (`onContextMenu`, the branch stays highlighted while `menuFor` names it). The checked-out branch shows how far it is
 * ahead of or behind its upstream, and the session's branch where a push lands (`pushes`), since Hunt pushes it onto
 * the branch the session was created from, never under its own name. The header shows `busyLabel` while an action runs
 * and a button that deletes the local branches origin lacks (`prunable`, `onPrune`).
 */
export function RefTree({
  refs,
  pushes,
  filter,
  menuFor,
  busyLabel,
  prunable,
  onFilter,
  onContextMenu,
  onPrune,
}: {
  refs: RefList | null;
  pushes: PushRoute | null;
  filter: string;
  menuFor: string | null;
  busyLabel: string | null;
  /** The local branches that have no branch on origin and are not checked out anywhere, which `onPrune` deletes. */
  prunable: string[];
  onFilter: (reference: string) => void;
  onContextMenu: (ref: GitRef, x: number, y: number) => void;
  onPrune: () => void;
}) {
  const folderIconUrl = useFolderIconUrl();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(collapsedGroups));
  const tree = useMemo(() => (refs ? buildRefTree(refs.refs, refs.head) : []), [refs]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visit = (nodes: RefTreeNode[], depth: number) => {
      for (const node of nodes) {
        result.push({ node, depth });
        if (node.kind === "group" && !collapsed.has(node.path)) {
          visit(node.children, depth + 1);
        }
      }
    };
    visit(tree, 0);
    return result;
  }, [tree, collapsed]);

  const openMenu = (event: MouseEvent, ref: GitRef) => {
    event.preventDefault();
    onContextMenu(ref, event.clientX, event.clientY);
  };

  const toggle = (path: string) => {
    if (collapsedGroups.has(path)) {
      collapsedGroups.delete(path);
    } else {
      collapsedGroups.add(path);
    }
    setCollapsed(new Set(collapsedGroups));
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex items-center gap-1 border-b border-(--line) py-2.5 pr-2 pl-3 text-[13px] text-neutral-400">
        <span className="shrink-0">Branches</span>
        {busyLabel ? (
          <span className="min-w-0 flex-1 truncate text-right text-neutral-300">{busyLabel}</span>
        ) : refs ? (
          <span className="min-w-0 flex-1 truncate text-right text-neutral-500" title={refs.head === "HEAD" ? "No branch is checked out" : `Checked out: ${refs.head}`}>
            {refs.head === "HEAD" ? "detached HEAD" : refs.head}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onPrune}
          disabled={!prunable.length || !!busyLabel}
          className={`${ICON_BUTTON_XS} -my-1.5`}
          title={prunable.length ? `Delete the ${prunable.length} local ${prunable.length === 1 ? "branch" : "branches"} without a branch on origin…` : "Every local branch has a branch on origin"}
        >
          <TrashIcon className="size-4" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto py-1 font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
        <li
          onClick={() => onFilter("")}
          className={`flex cursor-default items-center gap-[5px] pr-2 pl-[26px] select-none ${filter === "" ? "bg-(--tree-selection)" : "hover:bg-(--row-hover)"}`}
          title="Show every branch and tag"
        >
          <span className="truncate text-neutral-200">All branches</span>
        </li>
        {rows.map(({ node, depth }) =>
          node.kind === "group" ? (
            <li
              key={node.path}
              onClick={() => toggle(node.path)}
              className="flex cursor-default items-center gap-[5px] pr-2 select-none hover:bg-(--row-hover)"
              style={{ paddingLeft: `calc(6px + ${depth} * var(--changelist-indent))` }}
              title={node.path}
            >
              <ChevronIcon expanded={!collapsed.has(node.path)} className="size-4 shrink-0 text-neutral-500" />
              {depth ? <img src={folderIconUrl(node.name, !collapsed.has(node.path))} alt="" className="size-[17px] shrink-0" /> : null}
              <span className={`truncate ${depth ? "text-neutral-300" : "text-neutral-200"}`}>{node.name}</span>
              <span className="pl-1 text-[0.85em] text-neutral-600">{node.count}</span>
            </li>
          ) : (
            <li
              key={node.path}
              onClick={() => onFilter(filter === node.ref.name ? "" : node.ref.name)}
              onContextMenu={node.ref.kind === "tag" ? undefined : (event: MouseEvent) => openMenu(event, node.ref)}
              className={`flex cursor-default items-start gap-[5px] pr-2 select-none ${filter === node.ref.name ? "bg-(--tree-selection)" : menuFor === node.ref.name ? "bg-(--row-active)" : "hover:bg-(--row-hover)"}`}
              style={{ paddingLeft: `calc(26px + ${depth} * var(--changelist-indent))` }}
              title={node.ref.upstream ? `${node.ref.name} → ${node.ref.upstream}` : node.ref.name}
            >
              {/* The icon sits on the first line, centred in it like the single-line rows. */}
              <span className="flex h-[calc(var(--changelist-line-height)*1em)] shrink-0 items-center">
                <BranchIcon className={`size-3.5 ${node.ref.name === refs?.head ? "text-blue-300" : "text-neutral-500"}`} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1">
                  <span className={`truncate ${node.ref.name === refs?.head ? "font-medium text-blue-100" : "text-neutral-200"}`}>{node.name}</span>
                  {node.ref.ahead ? <span className="text-[0.85em] text-amber-300 tabular-nums" title={`${node.ref.ahead} ahead of ${node.ref.upstream}`}>↑{node.ref.ahead}</span> : null}
                  {node.ref.behind ? <span className="text-[0.85em] text-sky-300 tabular-nums" title={`${node.ref.behind} behind ${node.ref.upstream}`}>↓{node.ref.behind}</span> : null}
                </span>
                {/* The session's branch shows where its push lands on a second line, since Hunt pushes it onto the branch it was created from. */}
                {pushes && node.ref.kind === "local" && node.ref.name === pushes.branch ? (
                  <span className="-mt-[0.3em] truncate pb-[0.2em] leading-[1.2] text-neutral-500" title={`A push lands on origin/${pushes.target}`}>
                    → {pushes.target === pushes.branch ? "origin" : pushes.target}
                  </span>
                ) : null}
              </span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
