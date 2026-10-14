import { matchesGlob } from "../diff/glob";
import type { ArchitectureGraph, ChangeStat, ChangedFile, GraphEdge, ReviewLevel } from "../ipc/types";
import { dirName } from "../ui/path";

/** Smallest and largest node box; a changed file grows with its share of the changed lines, any box beyond them to show its name in full. */
export const MIN_NODE_WIDTH = 180;
export const MAX_NODE_WIDTH = 300;
export const MIN_NODE_HEIGHT = 56;
export const MAX_NODE_HEIGHT = 100;
/** A folder gets a group area once this many shown files sit directly in it. */
const MIN_GROUP_NODES = 2;
/** The ellipsis in a directory label stands for at least this many folders; hiding a single one saves too little. */
const MIN_ELIDED_FOLDERS = 2;
/** Folders that hold several modules, e.g. `apps` in `apps/backend/src`; module names leave them out. */
const CONTAINER_FOLDERS = new Set(["apps", "packages", "libs", "modules", "services", "projects", "crates"]);
/** Folders that open a module's source tree, e.g. `src` and `app` in `apps/backend/src/app`; a module root ends before the first. */
const SOURCE_FOLDERS = new Set(["src", "lib", "app", "source", "sources", "main", "java", "kotlin", "internal", "pkg", "cmd"]);
/** Folders whose name says little without their parent; a label ending in one keeps the parent, e.g. `vivendi-pep/__tests__`. */
const GENERIC_FOLDERS = new Set([...SOURCE_FOLDERS, "test", "tests", "spec", "__tests__", "__mocks__", "dist", "build", "out"]);

/**
 * One file in the diagram. Changed files come from the changelist and are sized by their changed lines; the other
 * files were added by the agent for context, sit at the smallest size and are drawn dimmed.
 */
export type DiagramNode = {
  path: string;
  name: string;
  /** Directory part of `path`, empty for root files. */
  directory: string;
  /** `directory` as the label under the file name shows it. */
  shortDirectory: ShortPath;
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

/** A module in the legend: its name `alias` stands for its root folder `prefix`, e.g. `ppp-rl-backend` for `apps/ppp-rl/backend`. */
export type PathAlias = { alias: string; prefix: string };
/**
 * A directory as labels show it: `alias` names its module (null outside any), `full` the folders below the module's source
 * tree and `rest` the same with middle folders elided as `…` when there are many.
 */
export type ShortPath = { alias: string | null; rest: string; full: string };

export type DiagramEdge = { id: string; source: string; target: string; label?: string; description?: string };

export type Diagram = {
  nodes: DiagramNode[];
  groups: DiagramGroup[];
  edges: DiagramEdge[];
  /** Modules the directory labels name whose name differs from their root folder. */
  legend: PathAlias[];
  /** Changed files the filters leave out. */
  hiddenCount: number;
};

/** The relevance and glob filters: files the agent rated below `minReview` and files matching one of `hiddenGlobs` are hidden. */
export type DiagramFilter = { minReview: ReviewLevel; hiddenGlobs: string[] };

const NO_FILTER: DiagramFilter = { minReview: 1, hiddenGlobs: [] };

/** Whether `filter` hides the file at `path` the agent rated `review`; a file without a rating passes the minimum. */
export function isFilteredOut(path: string, review: ReviewLevel | undefined, filter: DiagramFilter): boolean {
  if (review && review < filter.minReview) return true;
  return filter.hiddenGlobs.some((glob) => matchesGlob(glob, path));
}

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

/** Agent edges plus the unlabeled import edges of file pairs the agent did not describe. */
export function mergeEdges(agentEdges: GraphEdge[], importEdges: GraphEdge[]): GraphEdge[] {
  const merged = [...agentEdges];
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
 * Merges the changelist with the agent-written graph and the imports read from the files: every changed file neither
 * in `excluded` nor hidden by `filter` is a node, agent nodes without changes are kept only while an edge path through
 * files `filter` keeps connects them to a shown changed file, and edges need both endpoints shown. Changed files the
 * agent left out still appear. A box is at least `minWidth` of its node wide, the width its content needs.
 */
export function buildDiagram(
  graph: ArchitectureGraph,
  importEdges: GraphEdge[],
  changedFiles: ChangedFile[],
  stats: ChangeStat[],
  excluded: Set<string>,
  filter: DiagramFilter = NO_FILTER,
  minWidth: (node: DiagramNode) => number = () => 0,
): Diagram {
  const changedByPath = new Map(changedFiles.map((file) => [file.path, file]));
  const statsByPath = new Map(stats.map((stat) => [stat.path, stat]));
  const agentNodes = new Map(graph.nodes.map((node) => [node.path, node]));
  const allEdges = mergeEdges(graph.edges, importEdges);

  const isHidden = (path: string) => isFilteredOut(path, agentNodes.get(path)?.review, filter);
  const shownChanged = changedFiles.filter((file) => !excluded.has(file.path) && !isHidden(file.path));
  const shown = new Set(shownChanged.map((file) => file.path));

  // Context files reachable from the shown changed files through other context files; hidden files block the way.
  const neighbours = new Map<string, string[]>();
  for (const edge of allEdges) {
    neighbours.set(edge.source, [...(neighbours.get(edge.source) ?? []), edge.target]);
    neighbours.set(edge.target, [...(neighbours.get(edge.target) ?? []), edge.source]);
  }
  const queue = [...shown];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of neighbours.get(current) ?? []) {
      if (shown.has(next) || changedByPath.has(next) || isHidden(next)) continue;
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
    const node: DiagramNode = {
      path,
      name: segments[segments.length - 1],
      directory,
      shortDirectory: labelOf(directory),
      review: agentNode?.review,
      reviewReason: agentNode?.reviewReason,
      isChanged: Boolean(changed),
      status: changed?.status,
      added: changed ? (stat?.added ?? 0) : 0,
      removed: changed ? (stat?.removed ?? 0) : 0,
      ...nodeSize(lines, maxLines),
    };
    return { ...node, width: Math.max(node.width, Math.ceil(minWidth(node))) };
  };

  const contextPaths = graph.nodes.map((node) => node.path).filter((path) => shown.has(path) && !changedByPath.has(path));
  const shownPaths = [...shownChanged.map((file) => file.path), ...contextPaths];
  const { legend, labelOf } = labelDirectories(shownPaths.map(dirName));
  const nodes = shownPaths.map(toNode);
  const groups = groupByFolder(nodes, labelOf);
  const edges = allEdges
    .filter((edge) => shown.has(edge.source) && shown.has(edge.target))
    .map((edge) => ({ id: `${edge.source}->${edge.target}`, source: edge.source, target: edge.target, label: edge.label, description: edge.description }));

  return { nodes, groups, edges, legend, hiddenCount: changedFiles.length - shownChanged.length };
}

/**
 * One group per folder with at least `MIN_GROUP_NODES` of `nodes`, in order of first appearance, labeled by `labelOf`;
 * sets `groupId` on the members.
 */
export function groupByFolder(nodes: DiagramNode[], labelOf: (directory: string) => ShortPath): DiagramGroup[] {
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
    }
    groups.push({ id, directory: directory || ".", shortDirectory: labelOf(directory), nodePaths: members.map((member) => member.path) });
  }
  return groups;
}

/**
 * Labels for `directories` and the legend of the modules they name. A module root is the folder before a directory's
 * first source folder, named by its folders without the container ones, e.g. `ppp-rl-backend` for
 * `apps/ppp-rl/backend/src`. A directory at or below a root reads as the module plus its folders below the source
 * tree, any other directory as its folders after the leading source ones. Long folder paths keep the first folder and
 * the fewest trailing ones that still tell the directories apart, e.g. `ppp-rl-backend` + `api/…/import` for
 * `apps/ppp-rl/backend/src/app/api/workforce/employee/import`. `labelOf` reads a directory outside `directories` as is.
 */
export function labelDirectories(directories: string[]): { legend: PathAlias[]; labelOf: (directory: string) => ShortPath } {
  const distinct = [...new Set(directories)];
  const roots = [...new Set(distinct.map(moduleRoot).filter((root): root is string => Boolean(root)))];
  const modules = nameModules(roots);
  const longestFirst = [...modules].sort((first, second) => second.prefix.length - first.prefix.length);
  const entries = distinct.map((directory) => {
    const segments = directory ? directory.split("/") : [];
    const owner = longestFirst.find((candidate) => directory === candidate.prefix || directory.startsWith(`${candidate.prefix}/`));
    const below = withoutSourceFolders(segments.slice(owner ? owner.prefix.split("/").length : 0));
    const folders = owner || below.length ? below : segments;
    let tail = 1;
    while (tail < folders.length && GENERIC_FOLDERS.has(folders[folders.length - tail])) {
      tail++;
    }
    return { directory, alias: owner?.alias ?? null, folders, tail };
  });
  // Labels two directories share take one more trailing folder until they differ or show every folder.
  for (;;) {
    const byLabel = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = `${entry.alias ?? ""}\n${elide(entry.folders, entry.tail)}`;
      byLabel.set(key, [...(byLabel.get(key) ?? []), entry]);
    }
    const ambiguous = [...byLabel.values()].filter((shared) => shared.length > 1).flat().filter((entry) => entry.tail < entry.folders.length);
    if (!ambiguous.length) break;
    for (const entry of ambiguous) {
      entry.tail++;
    }
  }
  const labels = new Map(entries.map((entry) => [entry.directory, { alias: entry.alias, rest: elide(entry.folders, entry.tail), full: entry.folders.join("/") }]));
  return {
    legend: modules.filter((entry) => entry.alias !== entry.prefix),
    labelOf: (directory) => labels.get(directory) ?? { alias: null, rest: directory, full: directory },
  };
}

/** The folders of `directory` before its first source folder, unless they are all container folders; null then. */
function moduleRoot(directory: string): string | null {
  const segments = directory.split("/");
  const before = segments.slice(0, Math.max(0, segments.findIndex((segment) => SOURCE_FOLDERS.has(segment))));
  return before.some((segment) => !CONTAINER_FOLDERS.has(segment)) ? before.join("/") : null;
}

/** Names module `roots` by their folders without the container ones; roots that would share a name keep all their folders. */
function nameModules(roots: string[]): PathAlias[] {
  const nameOf = (root: string) => root.split("/").filter((segment) => !CONTAINER_FOLDERS.has(segment)).join("-");
  const counts = new Map<string, number>();
  for (const root of roots) {
    counts.set(nameOf(root), (counts.get(nameOf(root)) ?? 0) + 1);
  }
  return roots.map((root) => ({ alias: (counts.get(nameOf(root)) ?? 0) > 1 ? root.split("/").join("-") : nameOf(root), prefix: root }));
}

/** `segments` from the first one that is not a source folder on. */
function withoutSourceFolders(segments: string[]): string[] {
  const start = segments.findIndex((segment) => !SOURCE_FOLDERS.has(segment));
  return start < 0 ? [] : segments.slice(start);
}

/** `folders` joined with `/`; when that hides at least `MIN_ELIDED_FOLDERS`, only the first and the last `tail` around `…`. */
function elide(folders: string[], tail: number): string {
  if (folders.length - 1 - tail < MIN_ELIDED_FOLDERS) return folders.join("/");
  return [folders[0], "…", ...folders.slice(-tail)].join("/");
}
