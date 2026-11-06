import type { ShapeDiagram } from "./shape-diagram.types";

/**
 * The part of an ERD the canvas shows: every table except the `hidden` ones, the relationships between the shown
 * tables and the groups that still enclose one of them. Edits keep working on the whole diagram, so hiding a table
 * never changes the file.
 */
export function withoutTables(diagram: ShapeDiagram, hidden: ReadonlySet<string>): ShapeDiagram {
  if (!diagram.nodes.some((node) => hidden.has(node.id))) return diagram;
  const nodes = diagram.nodes.filter((node) => !hidden.has(node.id));
  const groups = diagram.groups?.filter((group) => nodes.some((node) => node.parent === group.id));
  const edges = diagram.edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
  return { ...diagram, nodes, edges, ...(groups ? { groups } : {}) };
}
