import type { GitRef } from "../ipc/types";
import { baseName } from "../ui/path";

export type RefGroupNode = {
  kind: "group";
  /** Unique key: the group's own name below its parents, e.g. `remote/origin/feature`. */
  path: string;
  name: string;
  children: RefTreeNode[];
  /** Branches or tags below the group. */
  count: number;
};

export type RefLeafNode = { kind: "ref"; path: string; name: string; ref: GitRef };

export type RefTreeNode = RefGroupNode | RefLeafNode;

type MutableGroup = { name: string; groups: Map<string, MutableGroup>; refs: GitRef[] };

/**
 * The branch tree of the Git tab: the top-level groups Local, Remote and Tags, each nesting its refs by the slashes in
 * their names (`feat/general/x` is `feat` › `general` › `x`; a remote branch's first segment is the remote). Groups come
 * before refs, both alphabetically, except that the checked-out branch `head` leads the local branches. Empty groups
 * are left out.
 */
export function buildRefTree(refs: readonly GitRef[], head: string): RefGroupNode[] {
  const roots: { kind: GitRef["kind"]; path: string; name: string }[] = [
    { kind: "local", path: "local", name: "Local" },
    { kind: "remote", path: "remote", name: "Remote" },
    { kind: "tag", path: "tags", name: "Tags" },
  ];
  const result: RefGroupNode[] = [];
  for (const root of roots) {
    const group: MutableGroup = { name: root.name, groups: new Map(), refs: [] };
    for (const ref of refs) {
      if (ref.kind !== root.kind) continue;
      const segments = ref.name.split("/");
      let parent = group;
      for (const segment of segments.slice(0, -1)) {
        let child = parent.groups.get(segment);
        if (!child) {
          child = { name: segment, groups: new Map(), refs: [] };
          parent.groups.set(segment, child);
        }
        parent = child;
      }
      parent.refs.push(ref);
    }
    const node = finalize(group, root.path, root.kind === "local" ? head : null);
    if (node.count) {
      result.push(node);
    }
  }
  return result;
}

/** The paths of every group in `nodes`, at any depth. */
export function groupPaths(nodes: readonly RefTreeNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "group" ? [node.path, ...groupPaths(node.children)] : []));
}

function finalize(group: MutableGroup, path: string, head: string | null): RefGroupNode {
  const groups = [...group.groups.values()].sort((left, right) => left.name.localeCompare(right.name)).map((child) => finalize(child, `${path}/${child.name}`, head));
  const leaves: RefLeafNode[] = [...group.refs]
    .sort((left, right) => Number(right.name === head) - Number(left.name === head) || left.name.localeCompare(right.name))
    .map((ref) => {
      const name = baseName(ref.name);
      return { kind: "ref", path: `${path}/${name}`, name, ref };
    });
  const children: RefTreeNode[] = [...groups, ...leaves];
  const count = groups.reduce((sum, child) => sum + child.count, leaves.length);
  return { kind: "group", path, name: group.name, children, count };
}
