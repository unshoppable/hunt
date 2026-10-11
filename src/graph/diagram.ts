import type { ArchitectureGraph, ChangeStat, ChangedFile, GraphEdge, ReviewLevel } from "../ipc/types";
import { FALLBACK_EDGE_LABEL } from "./schema";

/** Smallest and largest node box; a changed file grows with its share of the changed lines. */
export const MIN_NODE_WIDTH = 180;
export const MAX_NODE_WIDTH = 300;
export const MIN_NODE_HEIGHT = 56;
export const MAX_NODE_HEIGHT = 100;
/** A folder gets a group area once this many shown files sit directly in it. */
const MIN_GROUP_NODES = 2;
/** A path prefix gets a legend alias once this many shown files sit under it. */
const MIN_ALIAS_NODES = 2;
/** An alias must hide at least this many characters of its prefix: `apps/` is worth a legend entry, `src/` is not. */
const MIN_ALIAS_SAVING = 5;
/**
 * Directory names that never become an alias because they say nothing about the files below them; the legend
 * uses the next distinctive name instead, e.g. `backend` for `apps/backend/src`.
 */
const GENERIC_DIRECTORIES = new Set(["src", "lib", "libs", "app", "apps", "packages", "modules", "services", "internal", "pkg", "cmd", "test", "tests", "spec", "__tests__", "dist", "build", "out"]);

/**
 * One file in the diagram. Changed files come from the changelist and are sized by their changed lines; the other
 * files were added by the agent for context, sit at the smallest size and are drawn dimmed.
 */
export type DiagramNode = {
  path: string;
  name: string;
  /** Directory part of `path`, empty for root files. */
  directory: string;
  /** `directory` with its legend prefix replaced by the alias; null for a grouped file, whose group label names the folder. */
  shortDirectory: ShortPath | null;
  description?: string;
  /** The agent's rating of how much a human should review the file, and the criterion behind it. */
  review?: ReviewLevel;
  reviewReason?: string;
  isChanged: boolean;
  /** Single-letter git status of a changed file. */
  status?: string;
  added: number;
  removed: number;
  width: number;
  height: number;
  /** Group area of the file's folder; unset when the folder has too few shown files for one. */
  groupId?: string;
};

/** A translucent area around the shown files of one folder, so the module they belong to is visible. */
export type DiagramGroup = { id: string; directory: string; shortDirectory: ShortPath; nodePaths: string[] };

/** A legend term standing for a path prefix shared by several shown files, e.g. `backend` for `apps/backend/src`. */
export type PathAlias = { alias: string; prefix: string };
/** A directory with its legend prefix replaced: `alias` is the term (null when no entry applies), `rest` the path below the prefix. */
export type ShortPath = { alias: string | null; rest: string };

export type DiagramEdge = { id: string; source: string; target: string; label: string; description?: string };

export type Diagram = {
  nodes: DiagramNode[];
  groups: DiagramGroup[];
  edges: DiagramEdge[];
  /** Path prefixes the file labels abbreviate. */
  legend: PathAlias[];
  /** Changed files the filter leaves out. */
  hiddenCount: number;
};

/** Files and edges that light up while a file is hovered; the dependency card keeps clear of all of them. */
export type LitElements = { nodePaths: Set<string>; edgeIds: Set<string> };

/** What lights up for the hovered file: the file itself, the edges leaving it and the files they point at. */
export function litByHover(diagram: Diagram, hoveredPath: string | null): LitElements {
  if (!hoveredPath) return { nodePaths: new Set(), edgeIds: new Set() };
  const outgoing = diagram.edges.filter((edge) => edge.source === hoveredPath);
  return { nodePaths: new Set([hoveredPath, ...outgoing.map((edge) => edge.target)]), edgeIds: new Set(outgoing.map((edge) => edge.id)) };
}

/** Box size for `lines` changed lines relative to the largest change `maxLines` in the diagram (square-root scale). */
export function nodeSize(lines: number, maxLines: number): { width: number; height: number } {
  const share = maxLines > 0 && lines > 0 ? Math.sqrt(lines) / Math.sqrt(maxLines) : 0;
  return {
    width: Math.round(MIN_NODE_WIDTH + share * (MAX_NODE_WIDTH - MIN_NODE_WIDTH)),
    height: Math.round(MIN_NODE_HEIGHT + share * (MAX_NODE_HEIGHT - MIN_NODE_HEIGHT)),
  };
}

/**
 * Agent edges plus the import edges of file pairs the agent did not describe; the agent's label is the better one,
 * unless it was repaired to the placeholder, where the import label says more.
 */
export function mergeEdges(agentEdges: GraphEdge[], importEdges: GraphEdge[]): GraphEdge[] {
  const importByPair = new Map(importEdges.map((edge) => [`${edge.source}->${edge.target}`, edge]));
  const merged = agentEdges.map((edge) => {
    const imported = importByPair.get(`${edge.source}->${edge.target}`);
    return edge.label === FALLBACK_EDGE_LABEL && imported ? { ...edge, label: imported.label } : edge;
  });
  const described = new Set(agentEdges.map((edge) => `${edge.source}->${edge.target}`));
  for (const edge of importEdges) {
    const pair = `${edge.source}->${edge.target}`;
    if (described.has(pair)) continue;
    described.add(pair);
    merged.push(edge);
  }
  return merged;
}

/**
 * Merges the changelist with the agent-written graph and the imports read from the files: every changed file not
 * in `excluded` is a node, agent nodes without changes are kept only while an edge path connects them to a shown
 * changed file, and edges need both endpoints shown. Changed files the agent left out still appear.
 */
export function buildDiagram(graph: ArchitectureGraph, importEdges: GraphEdge[], changedFiles: ChangedFile[], stats: ChangeStat[], excluded: Set<string>): Diagram {
  const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const statsByPath = new Map(stats.map((stat) => [stat.path, stat]));
  const agentNodes = new Map(graph.nodes.map((node) => [node.path, node]));
  const allEdges = mergeEdges(graph.edges, importEdges);

  const shownChanged = changedFiles.filter((file) => !excluded.has(file.path));
  const shown = new Set(shownChanged.map((file) => file.path));

  // Context files reachable from the shown changed files through other context files; hidden changed files block the way.
  const neighbours = new Map<string, string[]>();
  for (const edge of allEdges) {
    neighbours.set(edge.source, [...(neighbours.get(edge.source) ?? []), edge.target]);
    neighbours.set(edge.target, [...(neighbours.get(edge.target) ?? []), edge.source]);
  }
  const queue = [...shown];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of neighbours.get(current) ?? []) {
      if (shown.has(next) || changedByPath.has(next)) continue;
      shown.add(next);
      queue.push(next);
    }
  }

  const linesOf = (path: string) => {
    const stat = statsByPath.get(path);
    return stat ? stat.added + stat.removed : 0;
  };
  const maxLines = Math.max(0, ...shownChanged.map((file) => linesOf(file.path)));

  const toNode = (path: string): DiagramNode => {
    const changed = changedByPath.get(path);
    const stat = statsByPath.get(path);
    const lines = changed ? linesOf(path) : 0;
    const agentNode = agentNodes.get(path);
    const segments = path.split("/");
    const directory = segments.slice(0, -1).join("/");
    return {
      path,
      name: segments[segments.length - 1],
      directory,
      shortDirectory: shortenDirectory(directory, legend),
      description: agentNode?.description,
      review: agentNode?.review,
      reviewReason: agentNode?.reviewReason,
      isChanged: Boolean(changed),
      status: changed?.status,
      added: changed ? (stat?.added ?? 0) : 0,
      removed: changed ? (stat?.removed ?? 0) : 0,
      ...nodeSize(lines, maxLines),
    };
  };

  const contextPaths = graph.nodes.map((node) => node.path).filter((path) => shown.has(path) && !changedByPath.has(path));
  const shownPaths = [...shownChanged.map((file) => file.path), ...contextPaths];
  const legend = buildLegend(shownPaths.map((path) => path.split("/").slice(0, -1).join("/")));
  const nodes = shownPaths.map(toNode);
  const groups = groupByFolder(nodes, legend);
  const edges = allEdges
    .filter((edge) => shown.has(edge.source) && shown.has(edge.target))
    .map((edge) => ({ id: `${edge.source}->${edge.target}`, source: edge.source, target: edge.target, label: edge.label, description: edge.description }));

  return { nodes, groups, edges, legend, hiddenCount: changedFiles.length - shownChanged.length };
}

/**
 * One group per folder with at least `MIN_GROUP_NODES` of `nodes`, in order of first appearance; sets `groupId` on the
 * members and clears their `shortDirectory`, since the group label names the folder.
 */
export function groupByFolder(nodes: DiagramNode[], legend: PathAlias[] = []): DiagramGroup[] {
  const byDirectory = new Map<string, DiagramNode[]>();
  for (const node of nodes) {
    byDirectory.set(node.directory, [...(byDirectory.get(node.directory) ?? []), node]);
  }
  const groups: DiagramGroup[] = [];
  for (const [directory, members] of byDirectory) {
    if (members.length < MIN_GROUP_NODES) continue;
    const id = `folder:${directory}`;
    for (const member of members) {
      member.groupId = id;
      member.shortDirectory = null;
    }
    groups.push({ id, directory: directory || ".", shortDirectory: shortenDirectory(directory, legend), nodePaths: members.map((member) => member.path) });
  }
  return groups;
}

/**
 * Legend of the path prefixes worth abbreviating in `directories` (one entry per file, so a directory counts as often
 * as it has files). Walking down from the root, the first directory name that is not generic becomes the alias of
 * the longest prefix all files below it share, e.g. `backend` for `apps/backend/src`; an alias needs
 * `MIN_ALIAS_NODES` files and must save `MIN_ALIAS_SAVING` characters, and a name is used only once.
 */
export function buildLegend(directories: string[]): PathAlias[] {
  const legend: PathAlias[] = [];
  const usedAliases = new Set<string>();
  const visit = (parent: string[], members: string[][]) => {
    const byChild = new Map<string, string[][]>();
    for (const segments of members) {
      const child = segments[parent.length];
      if (!child) continue;
      byChild.set(child, [...(byChild.get(child) ?? []), segments]);
    }
    for (const [child, group] of byChild) {
      if (group.length < MIN_ALIAS_NODES) continue;
      const path = [...parent, child];
      if (GENERIC_DIRECTORIES.has(child)) {
        visit(path, group);
        continue;
      }
      if (usedAliases.has(child)) continue;
      const prefix = commonPrefix(group).join("/");
      if (prefix.length - child.length < MIN_ALIAS_SAVING) continue;
      usedAliases.add(child);
      legend.push({ alias: child, prefix });
    }
  };
  visit([], directories.filter(Boolean).map((directory) => directory.split("/")));
  return legend;
}

/** The leading segments every path in `paths` shares. */
function commonPrefix(paths: string[][]): string[] {
  const [first, ...rest] = paths;
  let length = first.length;
  for (const other of rest) {
    let shared = 0;
    while (shared < length && shared < other.length && other[shared] === first[shared]) {
      shared++;
    }
    length = shared;
  }
  return first.slice(0, length);
}

/** `directory` with its legend prefix replaced by the alias; unchanged (alias null) when no entry applies. */
export function shortenDirectory(directory: string, legend: PathAlias[]): ShortPath {
  const entry = legend.find((candidate) => directory === candidate.prefix || directory.startsWith(`${candidate.prefix}/`));
  if (!entry) return { alias: null, rest: directory };
  return { alias: entry.alias, rest: directory.slice(entry.prefix.length + 1) };
}
