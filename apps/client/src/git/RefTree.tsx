import { useMemo, useState } from "react";
import type { RefList } from "../ipc/types";
import { useFolderIconUrl } from "../diff/fileIcons";
import { BranchIcon, ChevronIcon } from "../ui/icons";
import { buildRefTree, type RefTreeNode } from "./refGroups";

/** Collapsed groups, kept across session switches for the window's lifetime; tags start collapsed. */
const collapsedGroups = new Set<string>(["tags"]);

type Row = { node: RefTreeNode; depth: number };

/** The session's own local branch and the branch on `origin` a push of it lands on. */
export type PushRoute = { branch: string; target: string };

/**
 * The branch tree beside the log: Local, Remote and Tags, nested by the slashes in their names. A click on a branch
 * or tag shows only its history, a second click shows every branch again; the checked-out branch shows how far it is
 * ahead of or behind its upstream, and the session's branch where a push lands (`pushes`), since Hunt pushes it onto
 * the branch the session was created from, never under its own name.
 */
export function RefTree({ refs, pushes, filter, onFilter }: { refs: RefList | null; pushes: PushRoute | null; filter: string; onFilter: (reference: string) => void }) {
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
      <div className="flex items-center gap-1 border-b border-(--line) px-3 py-2.5 text-[13px] text-neutral-400">
        <span className="flex-1">Branches</span>
        {refs ? <span className="text-neutral-500">{refs.head === "HEAD" ? "detached HEAD" : refs.head}</span> : null}
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
              className={`flex cursor-default items-center gap-[5px] pr-2 select-none ${filter === node.ref.name ? "bg-(--tree-selection)" : "hover:bg-(--row-hover)"}`}
              style={{ paddingLeft: `calc(26px + ${depth} * var(--changelist-indent))` }}
              title={node.ref.upstream ? `${node.ref.name} → ${node.ref.upstream}` : node.ref.name}
            >
              <BranchIcon className={`size-3.5 shrink-0 ${node.ref.name === refs?.head ? "text-blue-300" : "text-neutral-500"}`} />
              <span className={`truncate ${node.ref.name === refs?.head ? "font-medium text-blue-100" : "text-neutral-200"}`}>{node.name}</span>
              {pushes && node.ref.kind === "local" && node.ref.name === pushes.branch ? (
                <span className="truncate pl-1 text-[0.85em] text-neutral-500" title={`A push lands on origin/${pushes.target}`}>
                  → {pushes.target === pushes.branch ? "origin" : pushes.target}
                </span>
              ) : null}
              {node.ref.ahead ? <span className="pl-1 text-[0.85em] text-amber-300 tabular-nums" title={`${node.ref.ahead} ahead of ${node.ref.upstream}`}>↑{node.ref.ahead}</span> : null}
              {node.ref.behind ? <span className="pl-1 text-[0.85em] text-sky-300 tabular-nums" title={`${node.ref.behind} behind ${node.ref.upstream}`}>↓{node.ref.behind}</span> : null}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
