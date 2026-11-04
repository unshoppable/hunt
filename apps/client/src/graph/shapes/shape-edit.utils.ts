import type { Cardinality, ShapeChange, ShapeDiagram, ShapeEdge, ShapeGroup, ShapeKind, ShapeNode, ShapePosition } from "./shape-diagram.types";
import { tableIdFor } from "./erd-edit.utils";
import { shapeEdgeId } from "./shape-diagram.utils";

/**
 * Edits of the elements, connections and boundaries of any shape diagram as pure functions, like the ERD edits in
 * `erd-edit.utils.ts`: every one returns a new diagram and leaves the given one alone. Elements and boundaries share
 * one id space, since both are React Flow nodes; connections are addressed by `shapeEdgeId`.
 */

/** The fields of an element the editor changes; an empty text and a null drop the field. */
export type NodePatch = { label?: string; description?: string; kind?: ShapeKind; parent?: string | null; actor?: string; change?: ShapeChange | null };
export type EdgePatch = { label?: string; description?: string; change?: ShapeChange | null; cardinality?: { source: Cardinality; target: Cardinality } };
export type GroupPatch = { label?: string; change?: ShapeChange | null };

/** An empty diagram of `type`, the starting point when an element is added before the agent generated one. */
export function emptyDiagram(type: ShapeDiagram["type"]): ShapeDiagram {
  return { type, nodes: [], edges: [] };
}

/** Adds an element of `kind` named `label`, marked as added, at `position` when given; returns the diagram and its id. */
export function addNode(diagram: ShapeDiagram, kind: ShapeKind, label: string, position?: ShapePosition): { diagram: ShapeDiagram; id: string } {
  const id = tableIdFor(label, takenIds(diagram));
  const node: ShapeNode = { id, kind, label, change: "added" };
  if (kind === "table") {
    node.columns = [{ name: "id", type: "uuid", isPrimaryKey: true }];
  }
  if (position) {
    node.position = roundPosition(position);
  }
  return { diagram: { ...diagram, nodes: [...diagram.nodes, node] }, id };
}

/** Changes the element `id`; an empty label is ignored, a parent that names no boundary is ignored too. */
export function updateNode(diagram: ShapeDiagram, id: string, patch: NodePatch): ShapeDiagram {
  const groupIds = new Set((diagram.groups ?? []).map((group) => group.id));
  return {
    ...diagram,
    nodes: diagram.nodes.map((node) => {
      if (node.id !== id) return node;
      const next: ShapeNode = { ...node };
      if (patch.label?.trim()) {
        next.label = patch.label.trim();
      }
      if (patch.kind) {
        next.kind = patch.kind;
      }
      setText(next, "description", patch.description);
      setText(next, "actor", patch.actor);
      if (patch.parent === null) {
        delete next.parent;
      } else if (patch.parent !== undefined && groupIds.has(patch.parent)) {
        next.parent = patch.parent;
      }
      setChange(next, patch.change);
      return next;
    }),
  };
}

/** Removes the element `id` and every connection it takes part in. */
export function removeNode(diagram: ShapeDiagram, id: string): ShapeDiagram {
  return { ...diagram, nodes: diagram.nodes.filter((node) => node.id !== id), edges: diagram.edges.filter((edge) => edge.source !== id && edge.target !== id) };
}

/**
 * Connects `source` to `target`, marked as added; returns the unchanged diagram and a null id when either element is
 * missing or the two are connected in that direction already.
 */
export function addEdge(diagram: ShapeDiagram, source: string, target: string): { diagram: ShapeDiagram; id: string | null } {
  const ids = new Set(diagram.nodes.map((node) => node.id));
  const edge: ShapeEdge = { source, target, change: "added" };
  const id = shapeEdgeId(diagram, edge);
  if (!ids.has(source) || !ids.has(target) || diagram.edges.some((existing) => shapeEdgeId(diagram, existing) === id)) return { diagram, id: null };
  return { diagram: { ...diagram, edges: [...diagram.edges, edge] }, id };
}

/** Changes the connection whose `shapeEdgeId` is `id`; an empty label or description drops the field. */
export function updateEdge(diagram: ShapeDiagram, id: string, patch: EdgePatch): ShapeDiagram {
  return {
    ...diagram,
    edges: diagram.edges.map((edge) => {
      if (shapeEdgeId(diagram, edge) !== id) return edge;
      const next: ShapeEdge = { ...edge };
      setText(next, "label", patch.label);
      setText(next, "description", patch.description);
      if (patch.cardinality) {
        next.cardinality = patch.cardinality;
      }
      setChange(next, patch.change);
      return next;
    }),
  };
}

/** Removes the connection whose `shapeEdgeId` is `id`. */
export function removeEdge(diagram: ShapeDiagram, id: string): ShapeDiagram {
  return { ...diagram, edges: diagram.edges.filter((edge) => shapeEdgeId(diagram, edge) !== id) };
}

/** Adds an empty boundary named `label`, marked as added; returns the diagram and its id. */
export function addGroup(diagram: ShapeDiagram, label: string): { diagram: ShapeDiagram; id: string } {
  const id = tableIdFor(label, takenIds(diagram));
  return { diagram: { ...diagram, groups: [...(diagram.groups ?? []), { id, label, change: "added" }] }, id };
}

/** Renames the boundary `id` or changes its change mark; an empty label is ignored. */
export function updateGroup(diagram: ShapeDiagram, id: string, patch: GroupPatch): ShapeDiagram {
  return {
    ...diagram,
    groups: (diagram.groups ?? []).map((group) => {
      if (group.id !== id) return group;
      const next: ShapeGroup = { ...group };
      if (patch.label?.trim()) {
        next.label = patch.label.trim();
      }
      setChange(next, patch.change);
      return next;
    }),
  };
}

/** Removes the boundary `id`; its elements stay and leave the boundary. */
export function removeGroup(diagram: ShapeDiagram, id: string): ShapeDiagram {
  const groups = (diagram.groups ?? []).filter((group) => group.id !== id);
  const nodes = diagram.nodes.map((node) => {
    if (node.parent !== id) return node;
    const { parent: _parent, ...rest } = node;
    return rest;
  });
  return { ...diagram, nodes, groups: groups.length ? groups : undefined };
}

/** Places every element named in `positions` there, rounded to whole pixels; the others keep theirs. */
export function setPositions(diagram: ShapeDiagram, positions: ReadonlyMap<string, ShapePosition>): ShapeDiagram {
  return {
    ...diagram,
    nodes: diagram.nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, position: roundPosition(position) } : node;
    }),
  };
}

/** Drops every element's position, so ELK lays the diagram out again. */
export function clearPositions(diagram: ShapeDiagram): ShapeDiagram {
  return {
    ...diagram,
    nodes: diagram.nodes.map((node) => {
      if (!node.position) return node;
      const { position: _position, ...rest } = node;
      return rest;
    }),
  };
}

function takenIds(diagram: ShapeDiagram): string[] {
  return [...diagram.nodes.map((node) => node.id), ...(diagram.groups ?? []).map((group) => group.id)];
}

function roundPosition(position: ShapePosition): ShapePosition {
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

function setText<T extends Record<string, unknown>>(target: T, field: keyof T & string, value: string | undefined) {
  if (value === undefined) return;
  if (value.trim()) {
    (target as Record<string, unknown>)[field] = value.trim();
  } else {
    delete target[field];
  }
}

function setChange(target: { change?: ShapeChange }, change: ShapeChange | null | undefined) {
  if (change === null) {
    delete target.change;
  } else if (change) {
    target.change = change;
  }
}
