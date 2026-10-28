import type { DiagramType, ShapeDiagramType } from "../common/diagram/diagram.types";
import type { ShapeKind } from "./shapes/shape-diagram.types";

/** One entry of the diagram picker: a diagram type, its name and what a reviewer sees in it. */
export type DiagramTypeOption = { id: DiagramType; name: string; description: string };

/**
 * The diagram types the Architecture tab offers, in the order the picker lists them. A new type also needs its id in
 * `DiagramType` (common/diagram/diagram.types.ts), entries in `KINDS_BY_TYPE` and `DIAGRAM_FILES`, the `type` enum and
 * an `allOf` branch in `src-tauri/src/graph/diagram.schema.json`, a `DiagramType` variant in `graph/graph.rs` (in
 * `SHAPE_TYPES`, with its `prompts/diagram/diagram-<type>.user-prompt.md`), and node views in `ShapeNodes.tsx` for
 * element kinds it adds.
 */
export const DIAGRAM_TYPES: DiagramTypeOption[] = [
  { id: "dependencies", name: "Dependencies", description: "Files of the change and how they depend on each other" },
  { id: "c4-context", name: "C4 Context", description: "The system under review, the people who use it and the external systems it talks to" },
  { id: "c4-container", name: "C4 Container", description: "Apps, services, databases and queues inside the system and how they connect" },
  { id: "states", name: "States", description: "States an entity passes through and the events that move it from one to the next" },
  { id: "erd", name: "ERD", description: "Database tables with their columns and the relationships between them" },
  { id: "process", name: "Process", description: "Steps and decisions of a workflow in the order they run" },
];

/** True for every type the agent writes to `.hunt/diagram.<type>.json`; only the dependency diagram comes from `graph.json`. */
export function isShapeDiagramType(type: DiagramType): type is ShapeDiagramType {
  return type !== "dependencies";
}

/** The element kinds each shape diagram allows; mirrors the `allOf` branches of `diagram.schema.json`. */
export const KINDS_BY_TYPE: Record<ShapeDiagramType, ShapeKind[]> = {
  "c4-context": ["person", "system", "externalSystem"],
  "c4-container": ["person", "container", "database", "queue", "externalSystem"],
  states: ["start", "end", "state"],
  erd: ["table"],
  process: ["start", "end", "action", "decision"],
};

/** The worktree-relative file each diagram type is read from. */
export const DIAGRAM_FILES: Record<DiagramType, string> = {
  dependencies: ".hunt/graph.json",
  "c4-context": ".hunt/diagram.c4-context.json",
  "c4-container": ".hunt/diagram.c4-container.json",
  states: ".hunt/diagram.states.json",
  erd: ".hunt/diagram.erd.json",
  process: ".hunt/diagram.process.json",
};
