/** How much a human should review a file, 4 being the most: its relevance (reuse, architecture, business logic) weighed with how drastic its change is. */
export type ReviewLevel = 1 | 2 | 3 | 4;

/**
 * The diagrams the Architecture tab offers. `dependencies` is the file-level component diagram in `.hunt/diagrams/dependencies.react-flow.json`;
 * every other type is a shape diagram the agent writes to `.hunt/diagrams/<type>.react-flow.json` (see src-tauri/src/graph/diagram.schema.json).
 */
export type DiagramType = "dependencies" | "c4-context" | "c4-container" | "states" | "erd" | "process" | "freeform";
export type ShapeDiagramType = Exclude<DiagramType, "dependencies">;

/** A diagram file of a session's worktree to show in the Architecture tab of the main window (see sessions/diagram-file-requests.hook.ts). */
export type DiagramFileRequest = { sessionId: string; path: string };
