import type { ShapeChange, ShapeDiagram } from "../graph/shapes/shape-diagram.types";

/** A table of an ERD as `hunt-client graph` reports it: its id and, when the session added or changed it, that mark. */
export type ErdTable = { id: string; change?: ShapeChange };

/** The tables of the ERD `diagram`, in its order. */
export function erdTables(diagram: ShapeDiagram): ErdTable[] {
  return diagram.nodes.map(({ id, change }) => (change ? { id, change } : { id }));
}

/** The ids of the tables of the ERD `diagram` the session neither added nor changed. */
export function unchangedTableIds(diagram: ShapeDiagram): string[] {
  return diagram.nodes.filter((node) => !node.change).map((node) => node.id);
}

/** The `ids` the ERD `diagram` has no table for, in their order. */
export function unknownTableIds(diagram: ShapeDiagram, ids: readonly string[]): string[] {
  const known = new Set(diagram.nodes.map((node) => node.id));
  return ids.filter((id) => !known.has(id));
}
