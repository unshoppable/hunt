/** How much a human should review a file, 4 being the most: its relevance (reuse, architecture, business logic) weighed with how drastic its change is. */
export type ReviewLevel = 1 | 2 | 3 | 4;

/**
 * The diagrams the Architecture tab offers. `dependencies` is the file-level component diagram in `.hunt/graph.json`;
 * every other type is a shape diagram the agent writes to `.hunt/diagram.<type>.json` (see src-tauri/src/graph/diagram.schema.json).
 */
export type DiagramType = "dependencies" | "c4-context" | "c4-container" | "states" | "erd" | "process";
export type ShapeDiagramType = Exclude<DiagramType, "dependencies">;
