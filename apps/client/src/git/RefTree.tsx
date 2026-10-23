import { Fragment, useMemo, useState, type MouseEvent } from "react";
import type { GitRef, RefList } from "../ipc/types";
import { useFolderIconUrl } from "../diff/fileIcons";
import { ICON_BUTTON_XS } from "../ui/buttons";
import { BranchIcon, ChevronIcon, FetchIcon, TrashIcon } from "../ui/icons";
import { toggleInCollapsed } from "../ui/treeExpansion";
import type { TreeNavRow } from "../ui/treeNavigation";
import { useTreeNavigation } from "../ui/useTreeNavigation";
import type { PushRoute } from "./branchActions";
import { buildRefTree, groupPaths, type RefTreeNode } from "./refGroups";

/** Collapsed groups, kept across session switches for the window's lifetime; tags start collapsed. */
const collapsedGroups = new Set<string>(["tags"]);

type Row = { node: RefTreeNode; depth: number };

/** Row key of "All branches"; every other row is keyed by its node's path. */
const ALL_KEY = "";

/**
 * The branch tree beside the log: Local, Remote and Tags, nested by the slashes in their names. A click on a branch
 * or tag shows only its history, a second click shows every branch again; a right click on a branch opens its menu
 * (`onContextMenu`, the branch stays highlighted while `menuFor` names it); the arrow keys move the filter from branch to
 * branch and open or close the groups. The checked-out branch shows how far it is
 * ahead of or behind its upstream, and the session's branch where a push lands (`pushes`), since Hunt pushes it onto
 * the branch the session was created from, never under its own name. The toolbar fetches origin (`onFetch`) and deletes
 * the local branches origin lacks (`prunable`, `onPrune`); the header shows `busyLabel` while an action runs and
 * `notice` after it.
 */
export function RefTree({
  refs,
  pushes,
  filter,
  menuFor,
  busyLabel,
  notice,
  prunable,
  onFilter,
  onContextMenu,
  onFetch,
  onPrune,
}: {
  refs: RefList | null;
  pushes: PushRoute | null;
  filter: string;
  menuFor: string | null;
  busyLabel: string | null;
  /** What the last action did, shown in the header in place of the checked-out branch until the next one starts. */
  notice: string | null;
  /** The local branches that have no branch on origin and are not checked out anywhere, which `onPrune` deletes. */
  prunable: string[];
  onFilter: (reference: string) => void;
  onContextMenu: (ref: GitRef, x: number, y: number) => void;
  onFetch: () => void;
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

  /** Every branch and tag by its node's path, including those in closed groups. */
  const refsByPath = useMemo(() => {
    const result = new Map<string, GitRef>();
    const visit = (nodes: RefTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "group") {
          visit(node.children);
        } else {
          result.set(node.path, node.ref);
        }
      }
    };
    visit(tree);
    return result;
  }, [tree]);

  const openMenu = (event: MouseEvent, ref: GitRef) => {
    event.preventDefault();
    onContextMenu(ref, event.clientX, event.clientY);
  };

  const toggle = (path: string) => {
    const next = toggleInCollapsed(collapsedGroups, path, groupPaths(tree));
    collapsedGroups.clear();
    for (const group of next) {
      collapsedGroups.add(group);
    }
    setCollapsed(next);
  };

  const navRows = useMemo<TreeNavRow[]>(
    () => [
      { key: ALL_KEY, depth: 0 },
      ...rows.map(({ node, depth }) => (node.kind === "group" ? { key: node.path, depth, isExpanded: !collapsed.has(node.path) } : { key: node.path, depth })),
    ],
    [rows, collapsed],
  );
  const filteredKey = filter ? ([...refsByPath].find(([, ref]) => ref.name === filter)?.[0] ?? null) : ALL_KEY;

  const nav = useTreeNavigation({
    rows: navRows,
    selectedKey: filteredKey,
    onSelect: (key) => onFilter(refsByPath.get(key)?.name ?? ""),
    isSelectable: (key) => key === ALL_KEY || refsByPath.has(key),
    onToggle: toggle,
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--git-bg)">
      <div className="flex items-center gap-1 border-b border-(--line) px-2 py-2.5">
        <button type="button" onClick={onFetch} disabled={!!busyLabel} className={ICON_BUTTON_XS} title="Fetch every branch of origin" aria-label="Fetch origin">
          <FetchIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={onPrune}
          disabled={!prunable.length || !!busyLabel}
          className={ICON_BUTTON_XS}
          title={prunable.length ? `Delete the ${prunable.length} local ${prunable.length === 1 ? "branch" : "branches"} without a branch on origin…` : "Every local branch has a branch on origin"}
          aria-label="Delete local branches without a branch on origin"
        >
          <TrashIcon className="size-4" />
        </button>
      </div>
      <div className="flex items-center gap-1 border-b border-(--line) px-3 py-2.5 text-[13px] text-neutral-400">
        <span className="shrink-0">Branches</span>
        {busyLabel || notice ? (
          <span className="min-w-0 flex-1 truncate text-right text-neutral-300" title={busyLabel ?? notice ?? undefined}>
            {busyLabel ?? notice}
          </span>
        ) : refs ? (
          <span className="min-w-0 flex-1 truncate text-right text-neutral-500" title={refs.head === "HEAD" ? "No branch is checked out" : `Checked out: ${refs.head}`}>
            {refs.head === "HEAD" ? "detached HEAD" : refs.head}
          </span>
        ) : null}
      </div>
      <ul {...nav.listProps} className="min-h-0 flex-1 overflow-auto py-1 outline-none font-(family-name:--git-font-family) text-(length:--git-font-size) leading-(--git-line-height)">
        <li
          onClick={() => nav.select(ALL_KEY)}
          data-tree-key={ALL_KEY}
          data-selected={nav.cursor === ALL_KEY}
          className="tree-row flex cursor-default items-center gap-[5px] pr-2.5 pl-[30px] select-none"
          title="Show every branch and tag"
        >
          <span className="truncate text-neutral-200">All branches</span>
        </li>
        {rows.map(({ node, depth }) =>
          node.kind === "group" ? (
            <Fragment key={node.path}>
              {node.path === "remote" ? <li aria-hidden="true" className="mx-2.5 my-1 border-t border-(--line)" /> : null}
              <li
                onClick={() => {
                  toggle(node.path);
                  nav.select(node.path);
                }}
                data-tree-key={node.path}
                data-selected={nav.cursor === node.path}
                className="tree-row flex cursor-default items-center gap-[5px] pr-2.5 select-none"
                style={{ paddingLeft: `calc(10px + ${depth} * var(--git-indent))` }}
                title={node.path}
              >
                <ChevronIcon expanded={!collapsed.has(node.path)} className="size-4 shrink-0 text-neutral-500" />
                {depth ? <img src={folderIconUrl(node.name, !collapsed.has(node.path))} alt="" className="size-[17px] shrink-0" /> : null}
                <span className={`truncate ${depth ? "text-neutral-300" : "text-neutral-200"}`}>{node.name}</span>
                <span className="pl-1 text-[0.85em] text-neutral-600">{node.count}</span>
              </li>
            </Fragment>
          ) : (
            <li
              key={node.path}
              onClick={() => (nav.cursor === node.path ? onFilter("") : nav.select(node.path))}
              onContextMenu={node.ref.kind === "tag" ? undefined : (event: MouseEvent) => openMenu(event, node.ref)}
              data-tree-key={node.path}
              data-selected={nav.cursor === node.path}
              data-menu-open={menuFor === node.ref.name}
              className="tree-row flex cursor-default items-start gap-[5px] pr-2.5 select-none"
              style={{ paddingLeft: `calc(30px + ${depth} * var(--git-indent))` }}
              title={node.ref.upstream ? `${node.ref.name} → ${node.ref.upstream}` : node.ref.name}
            >
              {/* The icon sits on the first line, centred in it like the single-line rows. */}
              <span className="flex h-[calc(var(--git-line-height)*1em)] shrink-0 items-center">
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
