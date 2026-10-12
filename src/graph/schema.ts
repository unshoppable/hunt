import type { ArchitectureGraph, GraphEdge, GraphNode, ReviewLevel } from "../ipc/types";
import { baseName } from "../ui/path";

export type ParsedGraph = {
  graph: ArchitectureGraph;
  /** Deviations from the schema, one sentence each. Invalid nodes and edges are dropped, invalid fields repaired. */
  problems: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The review rating when `value` is an integer from 1 to 4 (a numeric string such as `"3"` counts), else undefined. */
export function parseReviewLevel(value: unknown): ReviewLevel | undefined {
  const level = typeof value === "string" ? Number(value.trim()) : value;
  return level === 1 || level === 2 || level === 3 || level === 4 ? level : undefined;
}

/** True for a worktree-relative path: no leading slash, no `.` or `..` segments. */
export function isWorktreePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.startsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** True for a path inside an installed package (`node_modules`); the diagram shows project files only. */
export function isThirdPartyPath(path: string): boolean {
  return path.split("/").includes("node_modules");
}

/**
 * Validates the raw content of `.hunt/graph.json` against the schema and keeps whatever is usable, so a sloppy
 * agent output still renders while the panel lists what was wrong. A label that names a symbol or file instead of a
 * purpose is dropped, so the edge shows no label. A node whose review rating is missing or not an integer from 1 to 4
 * keeps no rating and no reason. Edges to nodes the agent did not list are kept
 * as nodes without a rating, since the diagram can show any worktree file. Nodes and edges inside
 * `node_modules` are dropped: the diagram shows project files, not installed packages.
 */
export function parseGraph(value: unknown): ParsedGraph {
  const problems: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return { graph: { nodes: [], edges: [] }, problems: ["graph.json must be an object with `nodes` and `edges` arrays."] };
  }

  const nodes = new Map<string, GraphNode>();
  value.nodes.forEach((raw, index) => {
    if (!isRecord(raw)) {
      problems.push(`Node ${index + 1} is not an object.`);
      return;
    }
    if (!isWorktreePath(raw.path)) {
      problems.push(`Node ${index + 1} has no valid worktree-relative path (${JSON.stringify(raw.path)}).`);
      return;
    }
    if (isThirdPartyPath(raw.path)) {
      problems.push(`Node "${raw.path}" is a third-party package; dropped.`);
      return;
    }
    if (nodes.has(raw.path)) {
      problems.push(`Node "${raw.path}" appears more than once; later copies are dropped.`);
      return;
    }
    const review = parseReviewLevel(raw.review);
    if (!review) {
      problems.push(`Node "${raw.path}" has no review rating from 1 to 4 (${JSON.stringify(raw.review)}).`);
    }
    nodes.set(raw.path, { path: raw.path, review, reviewReason: review ? optionalString(raw.reviewReason) : undefined });
  });

  const edges: GraphEdge[] = [];
  const seenPairs = new Set<string>();
  value.edges.forEach((raw, index) => {
    if (!isRecord(raw) || !isWorktreePath(raw.source) || !isWorktreePath(raw.target)) {
      problems.push(`Edge ${index + 1} lacks a valid source or target path.`);
      return;
    }
    if (raw.source === raw.target) {
      problems.push(`Edge on "${raw.source}" points at itself.`);
      return;
    }
    if (isThirdPartyPath(raw.source) || isThirdPartyPath(raw.target)) {
      problems.push(`Edge ${raw.source} → ${raw.target} involves a third-party package; dropped.`);
      return;
    }
    for (const endpoint of [raw.source, raw.target]) {
      if (!nodes.has(endpoint)) {
        problems.push(`Edge ${raw.source} → ${raw.target} references the unlisted file "${endpoint}"; added as a node.`);
        nodes.set(endpoint, { path: endpoint });
      }
    }
    const pair = `${raw.source}->${raw.target}`;
    if (seenPairs.has(pair)) {
      problems.push(`Edge ${raw.source} → ${raw.target} appears more than once; later copies are dropped.`);
      return;
    }
    seenPairs.add(pair);
    let label = optionalString(raw.label);
    if (!label) {
      problems.push(`Edge ${raw.source} → ${raw.target} has no label.`);
    } else if (isSymbolLikeLabel(label, raw.source, raw.target)) {
      problems.push(`Edge ${raw.source} → ${raw.target} is labeled with the name "${label}" instead of a purpose.`);
      label = undefined;
    }
    edges.push({ source: raw.source, target: raw.target, label, description: optionalString(raw.description) });
  });

  return { graph: { nodes: [...nodes.values()], edges }, problems };
}

/**
 * True when `label` is an identifier or a file name instead of a purpose: camelCase or PascalCase of several words,
 * UPPER_SNAKE, a dotted name such as `user.service.ts`, or the stem or name of one of `paths`.
 */
export function isSymbolLikeLabel(label: string, ...paths: string[]): boolean {
  const trimmed = label.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^[a-z$_][\w$]*[A-Z]/.test(trimmed)) return true;
  if (/^[A-Z][a-z0-9]+[A-Z][a-z]/.test(trimmed)) return true;
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(trimmed)) return true;
  if (/^[a-z][\w$-]*(\.[a-z][\w$-]*)+$/i.test(trimmed)) return true;
  const normalized = normalize(trimmed);
  return paths.some((path) => {
    const file = baseName(path);
    const stem = file.replace(/\.[^.]+$/, "");
    return normalize(file) === normalized || normalize(stem) === normalized;
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}
