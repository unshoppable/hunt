import type { Cardinality, ShapeChange, ShapeDiagram, ShapeDiagramType, ShapeEdge, ShapeGroup, ShapeNode, TableColumn } from "../ipc/types";
import { KINDS_BY_TYPE } from "./diagramTypes";

export type ParsedShapeDiagram = {
  diagram: ShapeDiagram;
  /** Deviations from the schema, one sentence each. Invalid nodes and edges are dropped, invalid fields repaired. */
  problems: string[];
};

/** Stable kebab-case id of a node or group, as `diagram.schema.json` requires it. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function parseChange(value: unknown): ShapeChange | undefined {
  return value === "added" || value === "changed" ? value : undefined;
}

function isCardinality(value: unknown): value is Cardinality {
  return value === "one" || value === "many";
}

/** The column when `name` and `type` are strings, the flags coerced to booleans; undefined otherwise. */
function parseColumn(value: unknown): TableColumn | undefined {
  if (!isRecord(value) || !optionalString(value.name) || typeof value.type !== "string") return undefined;
  const column: TableColumn = { name: value.name as string, type: value.type };
  if (value.isPrimaryKey) {
    column.isPrimaryKey = true;
  }
  if (value.isForeignKey) {
    column.isForeignKey = true;
  }
  return column;
}

/**
 * Validates the raw content of `.hunt/diagram.<type>.json` against the schema and keeps whatever is usable, so a
 * sloppy agent output still renders while the panel lists what was wrong. A file of another type, or no object at
 * all, yields an empty diagram. Nodes without a valid id, label or kind, duplicate ids, tables without a usable
 * column and edges whose endpoints or columns do not exist are dropped; an unknown `parent` or `change` is cleared.
 * A missing label on a transition or on an edge leaving a decision is reported but the edge stays.
 */
export function parseShapeDiagram(value: unknown, expected: ShapeDiagramType): ParsedShapeDiagram {
  const file = `diagram.${expected}.json`;
  const empty: ShapeDiagram = { type: expected, nodes: [], edges: [] };
  if (!isRecord(value)) return { diagram: empty, problems: [`${file} must be an object with \`type\`, \`nodes\` and \`edges\`.`] };
  if (value.type !== expected) return { diagram: empty, problems: [`${file} has the type ${JSON.stringify(value.type)} instead of "${expected}".`] };

  const problems: string[] = [];
  const kinds = KINDS_BY_TYPE[expected];
  const isErd = expected === "erd";

  const groups = new Map<string, ShapeGroup>();
  if (value.groups !== undefined && !Array.isArray(value.groups)) {
    problems.push("`groups` is not an array; ignored.");
  }
  (Array.isArray(value.groups) ? value.groups : []).forEach((raw, index) => {
    if (!isRecord(raw) || !isId(raw.id) || !optionalString(raw.label)) {
      problems.push(`Group ${index + 1} lacks a valid kebab-case id or a label; dropped.`);
      return;
    }
    if (groups.has(raw.id)) {
      problems.push(`Group "${raw.id}" appears more than once; later copies are dropped.`);
      return;
    }
    const group: ShapeGroup = { id: raw.id, label: raw.label as string };
    if (raw.change !== undefined) {
      const change = parseChange(raw.change);
      if (change) {
        group.change = change;
      } else {
        problems.push(`Group "${raw.id}" has the change ${JSON.stringify(raw.change)} instead of "added" or "changed"; cleared.`);
      }
    }
    groups.set(raw.id, group);
  });

  const nodes = new Map<string, ShapeNode>();
  if (!Array.isArray(value.nodes)) {
    problems.push("`nodes` is not an array; the diagram has no elements.");
  }
  (Array.isArray(value.nodes) ? value.nodes : []).forEach((raw, index) => {
    if (!isRecord(raw)) {
      problems.push(`Node ${index + 1} is not an object; dropped.`);
      return;
    }
    if (!isId(raw.id)) {
      problems.push(`Node ${index + 1} has no valid kebab-case id (${JSON.stringify(raw.id)}); dropped.`);
      return;
    }
    const label = optionalString(raw.label);
    if (!label) {
      problems.push(`Node "${raw.id}" has no label; dropped.`);
      return;
    }
    if (typeof raw.kind !== "string" || !(kinds as string[]).includes(raw.kind)) {
      problems.push(`Node "${raw.id}" has the kind ${JSON.stringify(raw.kind)}, which a ${expected} diagram does not allow; dropped.`);
      return;
    }
    if (nodes.has(raw.id)) {
      problems.push(`Node "${raw.id}" appears more than once; later copies are dropped.`);
      return;
    }
    const node: ShapeNode = { id: raw.id, kind: raw.kind as ShapeNode["kind"], label };
    if (node.kind === "table") {
      const rawColumns = Array.isArray(raw.columns) ? raw.columns : [];
      const columns = rawColumns.map(parseColumn).filter((column): column is TableColumn => !!column);
      if (columns.length < rawColumns.length) {
        problems.push(`Table "${raw.id}" has ${rawColumns.length - columns.length} column(s) without a string name and type; dropped those.`);
      }
      if (!columns.length) {
        problems.push(`Table "${raw.id}" has no valid column; dropped.`);
        return;
      }
      node.columns = columns;
    }
    const description = optionalString(raw.description);
    if (description) {
      node.description = description;
    }
    const actor = optionalString(raw.actor);
    if (actor) {
      node.actor = actor;
    }
    if (raw.parent !== undefined) {
      if (typeof raw.parent === "string" && groups.has(raw.parent)) {
        node.parent = raw.parent;
      } else {
        problems.push(`Node "${raw.id}" names the parent ${JSON.stringify(raw.parent)}, which is not a group; cleared.`);
      }
    }
    if (raw.change !== undefined) {
      const change = parseChange(raw.change);
      if (change) {
        node.change = change;
      } else {
        problems.push(`Node "${raw.id}" has the change ${JSON.stringify(raw.change)} instead of "added" or "changed"; cleared.`);
      }
    }
    nodes.set(raw.id, node);
  });

  const edges: ShapeEdge[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value.edges)) {
    problems.push("`edges` is not an array; the diagram has no connections.");
  }
  (Array.isArray(value.edges) ? value.edges : []).forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.source !== "string" || typeof raw.target !== "string") {
      problems.push(`Edge ${index + 1} lacks a source or target id; dropped.`);
      return;
    }
    const source = nodes.get(raw.source);
    const target = nodes.get(raw.target);
    if (!source || !target) {
      problems.push(`Edge ${raw.source} → ${raw.target} references the unknown node "${source ? raw.target : raw.source}"; dropped.`);
      return;
    }
    const edge: ShapeEdge = { source: raw.source, target: raw.target };
    const label = optionalString(raw.label);
    if (label) {
      edge.label = label;
    }
    const description = optionalString(raw.description);
    if (description) {
      edge.description = description;
    }
    if (isErd) {
      const hasColumn = (node: ShapeNode, column: unknown) => typeof column === "string" && !!node.columns?.some((candidate) => candidate.name === column);
      if (!hasColumn(source, raw.sourceColumn) || !hasColumn(target, raw.targetColumn)) {
        problems.push(`Edge ${raw.source} → ${raw.target} names a sourceColumn or targetColumn its table does not have; dropped.`);
        return;
      }
      if (!isRecord(raw.cardinality) || !isCardinality(raw.cardinality.source) || !isCardinality(raw.cardinality.target)) {
        problems.push(`Edge ${raw.source} → ${raw.target} has no cardinality with a "one" or "many" source and target; dropped.`);
        return;
      }
      edge.sourceColumn = raw.sourceColumn as string;
      edge.targetColumn = raw.targetColumn as string;
      edge.cardinality = { source: raw.cardinality.source, target: raw.cardinality.target };
    }
    const key = isErd ? `${edge.source}.${edge.sourceColumn}->${edge.target}.${edge.targetColumn}` : `${edge.source}->${edge.target}`;
    if (seen.has(key)) {
      problems.push(`Edge ${raw.source} → ${raw.target} appears more than once; later copies are dropped.`);
      return;
    }
    seen.add(key);
    if (!label && expected === "states") {
      problems.push(`Transition ${raw.source} → ${raw.target} has no event label.`);
    } else if (!label && expected === "process" && source.kind === "decision") {
      problems.push(`Edge ${raw.source} → ${raw.target} leaves a decision without an answer label.`);
    }
    if (raw.change !== undefined) {
      const change = parseChange(raw.change);
      if (change) {
        edge.change = change;
      } else {
        problems.push(`Edge ${raw.source} → ${raw.target} has the change ${JSON.stringify(raw.change)} instead of "added" or "changed"; cleared.`);
      }
    }
    edges.push(edge);
  });

  const diagram: ShapeDiagram = { type: expected, nodes: [...nodes.values()], edges };
  const title = optionalString(value.title);
  if (title) {
    diagram.title = title;
  }
  if (groups.size) {
    diagram.groups = [...groups.values()];
  }
  return { diagram, problems };
}
