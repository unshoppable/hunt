import type { ShapeDiagramType } from "../../common/diagram/diagram.types";

/** Element kinds of the shape diagrams; which ones a diagram type allows is listed in `KINDS_BY_TYPE` (graph/diagram-types.constants.ts). */
export type ShapeKind = "person" | "system" | "externalSystem" | "container" | "database" | "queue" | "start" | "end" | "state" | "action" | "decision" | "table";

/** One row of an ERD table. */
export type TableColumn = { name: string; type: string; isPrimaryKey?: boolean; isForeignKey?: boolean };

/** What the session did to an element: Hunt highlights added and changed elements, everything else is the unchanged context. */
export type ShapeChange = "added" | "changed";

/** Top-left corner of an element on the canvas, in absolute diagram coordinates. */
export type ShapePosition = { x: number; y: number };

/**
 * One element of a shape diagram. `id` is a stable kebab-case id derived from the name, so the same element has the same
 * id on every branch; `description` is the second line under the label (a container's technology, a system's purpose);
 * `parent` names the group the element sits in; `actor` is who performs an action; `columns` are the rows of a table;
 * `position` is where the user placed it, absent while ELK lays the element out.
 */
export type ShapeNode = {
  id: string;
  kind: ShapeKind;
  label: string;
  description?: string;
  parent?: string;
  actor?: string;
  columns?: TableColumn[];
  position?: ShapePosition;
  change?: ShapeChange;
};

/** A boundary that encloses the nodes naming it as `parent`, e.g. the system under review in a C4 container diagram. */
export type ShapeGroup = { id: string; label: string; change?: ShapeChange };

export type Cardinality = "one" | "many";

/**
 * A connection between two nodes. `label` is the event (states), the yes/no answer of a decision (process) or the
 * relationship (C4); ERD edges join `sourceColumn` of `source` with `targetColumn` of `target` and carry the
 * `cardinality` of both ends. `bends` are the corners of its orthogonal course from source to target, in absolute
 * diagram coordinates, once the user moved a segment of it; absent while Hunt routes it.
 */
export type ShapeEdge = {
  source: string;
  target: string;
  label?: string;
  description?: string;
  sourceColumn?: string;
  targetColumn?: string;
  cardinality?: { source: Cardinality; target: Cardinality };
  bends?: ShapePosition[];
  change?: ShapeChange;
};

/** The validated content of a shape diagram file (`.hunt/diagrams/<type>.react-flow.json` or one saved into the repository). */
export type ShapeDiagram = { type: ShapeDiagramType; title?: string; nodes: ShapeNode[]; groups?: ShapeGroup[]; edges: ShapeEdge[] };
