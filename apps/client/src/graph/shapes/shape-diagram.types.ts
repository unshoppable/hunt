import type { ShapeDiagramType } from "../../common/diagram/diagram.types";

/** Element kinds of the shape diagrams; which ones a diagram type allows is listed in `KINDS_BY_TYPE` (graph/diagram-types.constants.ts). */
export type ShapeKind = "person" | "system" | "externalSystem" | "container" | "database" | "queue" | "start" | "end" | "state" | "action" | "decision" | "table";

/** One row of an ERD table. */
export type TableColumn = { name: string; type: string; isPrimaryKey?: boolean; isForeignKey?: boolean };

/** What the session did to an element: Hunt highlights added and changed elements, everything else is the unchanged context. */
export type ShapeChange = "added" | "changed";

/**
 * One element of a shape diagram. `id` is a stable kebab-case id derived from the name, so the same element has the same
 * id on every branch; `description` is the second line under the label (a container's technology, a system's purpose);
 * `parent` names the group the element sits in; `actor` is who performs an action; `columns` are the rows of a table.
 */
export type ShapeNode = {
  id: string;
  kind: ShapeKind;
  label: string;
  description?: string;
  parent?: string;
  actor?: string;
  columns?: TableColumn[];
  change?: ShapeChange;
};

/** A boundary that encloses the nodes naming it as `parent`, e.g. the system under review in a C4 container diagram. */
export type ShapeGroup = { id: string; label: string; change?: ShapeChange };

export type Cardinality = "one" | "many";

/**
 * A connection between two nodes. `label` is the event (states), the yes/no answer of a decision (process) or the
 * relationship (C4); ERD edges join `sourceColumn` of `source` with `targetColumn` of `target` and carry the
 * `cardinality` of both ends.
 */
export type ShapeEdge = {
  source: string;
  target: string;
  label?: string;
  description?: string;
  sourceColumn?: string;
  targetColumn?: string;
  cardinality?: { source: Cardinality; target: Cardinality };
  change?: ShapeChange;
};

/** The validated content of `.hunt/diagram.<type>.json`. */
export type ShapeDiagram = { type: ShapeDiagramType; title?: string; nodes: ShapeNode[]; groups?: ShapeGroup[]; edges: ShapeEdge[] };
