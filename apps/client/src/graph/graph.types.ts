import type { ReviewLevel } from "../common/diagram/diagram.types";

/**
 * One file of the component diagram; the worktree-relative `path` identifies the node. `review` is the agent's rating of
 * the file's review relevance and `reviewReason` the one-sentence criterion behind it.
 */
export type GraphNode = { path: string; review?: ReviewLevel; reviewReason?: string };

/**
 * `source` depends on `target` (both node paths). `label` states how `source` uses `target` in one or two verbs and a
 * noun (`calls business logic`, `uses types`), `description` says in a few sentences how and what for. Both come
 * from the agent; an edge read from an import statement has neither.
 */
export type GraphEdge = { source: string; target: string; label?: string; description?: string };

/** The validated content of `.hunt/graph.json` (see src-tauri/src/graph/graph.schema.json). */
export type ArchitectureGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Age of a diagram: when its file was last written, and whether session files changed since. */
export type GraphStatus = { generatedAt: string | null; isOutdated: boolean };

export type GraphChangedEvent = { huntSessionId: string };
