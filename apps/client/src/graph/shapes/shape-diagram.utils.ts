import type { Edge, Node, XYPosition } from "@xyflow/react";
import type { Cardinality, ShapeChange, ShapeDiagram, ShapeGroup, ShapeKind, ShapeNode } from "./shape-diagram.types";
import type { LayoutInput, LayoutNode, LayoutPort, LayoutSpacing } from "../layout.utils";
import { edgeMarker, layoutGraph } from "../layout.utils";

/**
 * The style contract of the shape diagrams: Hunt sizes every element from its content with these constants, so a
 * diagram looks the same on every branch. A box (system, container, state, action) grows with its label between
 * `MIN_BOX_WIDTH` and `MAX_BOX_WIDTH` and gets a second line for a description or actor; the other kinds are fixed.
 */
const BOX_CHAR_WIDTH = 7.4;
const BOX_PADDING = 32;
const MIN_BOX_WIDTH = 180;
const MAX_BOX_WIDTH = 260;
const BOX_HEIGHT = 64;
const BOX_HEIGHT_WITH_DETAIL = 80;
const PERSON_SIZE = { width: 120, height: 110 };
const DATABASE_SIZE = { width: 160, height: 84 };
const QUEUE_SIZE = { width: 180, height: 64 };
const TERMINAL_SIZE = { width: 28, height: 28 };
const DECISION_SIZE = { width: 170, height: 90 };
/**
 * A table lists its columns as rows under a header that holds the name and, when there is one, the description on
 * a second line. The width follows the widest row (name in 13px sans, type in 12px mono) or the header.
 */
export const TABLE_HEADER_HEIGHT = 40;
export const TABLE_HEADER_HEIGHT_WITH_DESCRIPTION = 58;
export const TABLE_ROW_HEIGHT = 28;
const TABLE_LABEL_CHAR_WIDTH = 7.8;
const TABLE_NAME_CHAR_WIDTH = 7;
const TABLE_TYPE_CHAR_WIDTH = 7.2;
/** The key icon column, the gaps around name and type and the horizontal padding of a row. */
const TABLE_ROW_OVERHEAD = 68;
const TABLE_BOTTOM_PADDING = 6;
const MIN_TABLE_WIDTH = 220;
const MAX_TABLE_WIDTH = 360;
/** ERD tables sit further apart than boxes: the relationships leave at their rows and need room to bend. */
const ERD_SPACING: LayoutSpacing = { nodeNode: 48, betweenLayers: 120 };
/** At most this many tables stack in one layer of an ERD, so a cluster of referencing tables spreads sideways. */
const ERD_MAX_TABLES_PER_LAYER = 3;
/** Room the change tag takes in a table header beside the name. */
const TABLE_TAG_WIDTH = 72;

/**
 * React Flow node data of a shape: the element plus the size Hunt gave it and the interaction flags the panel sets.
 * `litColumns` names the columns of a table that take part in the hovered relationship or table.
 */
export type ShapeNodeData = ShapeNode & {
  width: number;
  height: number;
  isSelected?: boolean;
  isHovered?: boolean;
  isMuted?: boolean;
  litColumns?: string[];
  [key: string]: unknown;
};
export type ShapeFlowNode = Node<ShapeNodeData, ShapeKind>;
export type BoundaryNodeData = ShapeGroup & { [key: string]: unknown };
export type BoundaryFlowNode = Node<BoundaryNodeData, "boundary">;
export type ShapeDiagramFlowNode = ShapeFlowNode | BoundaryFlowNode;
/**
 * `points` is ELK's orthogonal route from source to target, `labelCenter` the middle of the label box ELK reserved
 * on that route (null when the edge was laid out without one); `cardinality` and the columns are set on ERD
 * relationships only.
 */
export type ShapeEdgeData = {
  label?: string;
  description?: string;
  points: XYPosition[];
  labelCenter: XYPosition | null;
  sourceColumn?: string;
  targetColumn?: string;
  cardinality?: { source: Cardinality; target: Cardinality };
  change?: ShapeChange;
  /** The mouse is on the edge's path; the view then shows its hover card. */
  isHovered?: boolean;
  /** The edge is hovered or belongs to the hovered node; the view then draws it brighter. */
  isLit?: boolean;
  /** Another edge or node is hovered and this edge is not part of it; the view then fades it. */
  isMuted?: boolean;
  [key: string]: unknown;
};
export type ShapeFlowEdge = Edge<ShapeEdgeData, "shape">;

/** The fixed size of an element, from its kind and content. */
export function shapeNodeSize(node: ShapeNode): { width: number; height: number } {
  switch (node.kind) {
    case "person":
      return PERSON_SIZE;
    case "database":
      return DATABASE_SIZE;
    case "queue":
      return QUEUE_SIZE;
    case "start":
    case "end":
      return TERMINAL_SIZE;
    case "decision":
      return DECISION_SIZE;
    case "table": {
      const columns = node.columns ?? [];
      const widestRow = Math.max(0, ...columns.map((column) => column.name.length * TABLE_NAME_CHAR_WIDTH + column.type.length * TABLE_TYPE_CHAR_WIDTH));
      const content = Math.max(widestRow, node.label.length * TABLE_LABEL_CHAR_WIDTH + (node.change ? TABLE_TAG_WIDTH : 0));
      const width = Math.min(MAX_TABLE_WIDTH, Math.max(MIN_TABLE_WIDTH, Math.round(content + TABLE_ROW_OVERHEAD)));
      return { width, height: tableHeaderHeight(node) + columns.length * TABLE_ROW_HEIGHT + TABLE_BOTTOM_PADDING };
    }
    default: {
      const width = Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, node.label.length * BOX_CHAR_WIDTH + BOX_PADDING));
      return { width, height: node.description || node.actor ? BOX_HEIGHT_WITH_DETAIL : BOX_HEIGHT };
    }
  }
}

/** Id of the port (and React Flow handle) where relationships of `column` leave (`out`, east border) or enter (`in`, west border) the table. */
export function columnPortId(nodeId: string, column: string, side: "in" | "out"): string {
  return `${nodeId}:${column}:${side}`;
}

/** Height of a table's header: one line for the name, a second one when the table has a description. */
export function tableHeaderHeight(table: Pick<ShapeNode, "description">): number {
  return table.description ? TABLE_HEADER_HEIGHT_WITH_DESCRIPTION : TABLE_HEADER_HEIGHT;
}

/** Vertical center of the row at `index` of `table`, relative to the table's top. */
export function tableRowCenterY(table: Pick<ShapeNode, "description">, index: number): number {
  return tableHeaderHeight(table) + index * TABLE_ROW_HEIGHT + TABLE_ROW_HEIGHT / 2;
}

/** Color of an ERD relationship's crow's feet: at rest, lit while hovered, or the change color it carries. */
export type CrowTone = "rest" | "lit" | ShapeChange;

/**
 * Id of the crow's-foot marker for `cardinality` in `tone`; `CrowFootDefs` defines one marker per combination. React
 * Flow wraps a string `markerStart`/`markerEnd` in `url('#…')` itself, so this returns the bare id.
 */
export function crowMarker(cardinality: Cardinality, tone: CrowTone): string {
  return `crow-${cardinality}-${tone}`;
}

/** Marker ids of both ends of an ERD relationship, lit while the edge is highlighted unless it carries a change color. */
export function erdMarkers(edge: Pick<ShapeEdgeData, "cardinality" | "change">, isHighlighted: boolean): { markerStart: string; markerEnd: string } {
  const tone: CrowTone = edge.change ?? (isHighlighted ? "lit" : "rest");
  return { markerStart: crowMarker(edge.cardinality?.source ?? "one", tone), markerEnd: crowMarker(edge.cardinality?.target ?? "one", tone) };
}

/** Unique layout and React Flow id of an edge; ERD relationships add their columns, since two tables may share several. */
function edgeId(diagram: ShapeDiagram, edge: ShapeDiagram["edges"][number]): string {
  return diagram.type === "erd" ? `${edge.source}.${edge.sourceColumn}->${edge.target}.${edge.targetColumn}` : `${edge.source}->${edge.target}`;
}

/**
 * The ELK input of a diagram: an ERD reads left to right with each relationship pinned to its columns' rows, no
 * merged trunks and no label boxes (the view shows a relationship's label when it is hovered), every other type
 * top-down with merged edges and inline labels like the dependency diagram.
 */
export function toLayoutInput(diagram: ShapeDiagram): LayoutInput {
  const isErd = diagram.type === "erd";
  const nodes: LayoutNode[] = diagram.nodes.map((node) => {
    const size = shapeNodeSize(node);
    const layoutNode: LayoutNode = { id: node.id, ...size, groupId: node.parent };
    if (isErd && node.columns) {
      layoutNode.ports = node.columns.flatMap((column, index): LayoutPort[] => [
        { id: columnPortId(node.id, column.name, "out"), x: size.width, y: tableRowCenterY(node, index) },
        { id: columnPortId(node.id, column.name, "in"), x: 0, y: tableRowCenterY(node, index) },
      ]);
    }
    return layoutNode;
  });
  return {
    nodes,
    groups: (diagram.groups ?? []).map((group) => ({ id: group.id })),
    edges: diagram.edges.map((edge) => ({
      id: edgeId(diagram, edge),
      source: isErd ? columnPortId(edge.source, edge.sourceColumn ?? "", "out") : edge.source,
      target: isErd ? columnPortId(edge.target, edge.targetColumn ?? "", "in") : edge.target,
      label: isErd ? undefined : edge.label,
    })),
    direction: isErd ? "RIGHT" : "DOWN",
    mergeEdges: !isErd,
    spacing: isErd ? ERD_SPACING : undefined,
    maxNodesPerLayer: isErd ? ERD_MAX_TABLES_PER_LAYER : undefined,
  };
}

/**
 * Lays the diagram out and returns React Flow nodes (boundaries before the shapes inside them) and edges. Shape
 * positions are relative to their boundary; edge routes are absolute. Waits and aborts like `layoutGraph`.
 */
export async function layoutShapeDiagram(diagram: ShapeDiagram, signal?: AbortSignal): Promise<{ nodes: ShapeDiagramFlowNode[]; edges: ShapeFlowEdge[] }> {
  const isErd = diagram.type === "erd";
  const { positions, groupSizes, routes } = await layoutGraph(toLayoutInput(diagram), signal);

  const boundaryNodes: BoundaryFlowNode[] = (diagram.groups ?? []).map((group) => {
    const size = groupSizes.get(group.id) ?? { width: 0, height: 0 };
    return {
      id: group.id,
      type: "boundary",
      position: positions.get(group.id) ?? { x: 0, y: 0 },
      data: group,
      width: size.width,
      height: size.height,
      // The area must not catch the mouse, or the edges and labels inside it could not be hovered.
      style: { width: size.width, height: size.height, pointerEvents: "none" },
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
    };
  });
  const shapeNodes: ShapeFlowNode[] = diagram.nodes.map((node) => {
    const size = shapeNodeSize(node);
    return {
      id: node.id,
      type: node.kind,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      parentId: node.parent,
      data: { ...node, ...size },
      width: size.width,
      height: size.height,
      selectable: true,
      draggable: false,
    };
  });

  const edges: ShapeFlowEdge[] = diagram.edges.map((edge) => {
    const id = edgeId(diagram, edge);
    const route = routes.get(id);
    const data: ShapeEdgeData = {
      label: edge.label,
      description: edge.description,
      points: route?.points ?? [],
      labelCenter: route?.labelCenter ?? null,
      sourceColumn: edge.sourceColumn,
      targetColumn: edge.targetColumn,
      cardinality: edge.cardinality,
      change: edge.change,
    };
    const flowEdge: ShapeFlowEdge = {
      id,
      type: "shape",
      source: edge.source,
      target: edge.target,
      data,
      // React Flow lets the mouse through an unselectable edge; the panel needs its hover for the description.
      selectable: true,
      // Behind the boundaries (-1) and the shapes (0); the panel keeps these levels fixed, also while hovered.
      zIndex: -2,
    };
    if (isErd) {
      flowEdge.sourceHandle = columnPortId(edge.source, edge.sourceColumn ?? "", "out");
      flowEdge.targetHandle = columnPortId(edge.target, edge.targetColumn ?? "", "in");
      // Crow's-foot ends; the panel defines one SVG marker per cardinality and tone.
      // React Flow wraps a string marker into `url('#…')` itself, so the edge names the marker id only.
      Object.assign(flowEdge, erdMarkers(data, false));
    } else {
      flowEdge.markerEnd = edgeMarker(false);
    }
    return flowEdge;
  });

  return { nodes: [...boundaryNodes, ...shapeNodes], edges };
}

/** What the mouse is on and which table the editor shows; every id null when nothing is. */
export type ShapeFocus = { hoveredEdgeId: string | null; hoveredNodeId: string | null; selectedNodeId: string | null };

/**
 * The flow nodes and edges with the interaction flags of `focus`: the hovered edge and the edges of the hovered
 * node are lit and get their bright markers, every other edge is muted while something is hovered; a hovered node
 * also mutes the nodes it is not connected to. ERD tables learn which of their columns the lit relationships are on.
 * Boundaries are left alone.
 */
export function decorateShapeFlow(nodes: ShapeDiagramFlowNode[], edges: ShapeFlowEdge[], focus: ShapeFocus, isErd: boolean): { nodes: ShapeDiagramFlowNode[]; edges: ShapeFlowEdge[] } {
  const isFocusing = Boolean(focus.hoveredEdgeId) || Boolean(focus.hoveredNodeId);
  const isLit = (edge: ShapeFlowEdge) => edge.id === focus.hoveredEdgeId || edge.source === focus.hoveredNodeId || edge.target === focus.hoveredNodeId;
  const litEdges = edges.filter(isLit);
  const litNodeIds = new Set(litEdges.flatMap((edge) => [edge.source, edge.target]));
  if (focus.hoveredNodeId) {
    litNodeIds.add(focus.hoveredNodeId);
  }
  const litColumns = new Map<string, string[]>();
  for (const edge of litEdges) {
    for (const [nodeId, column] of [[edge.source, edge.data?.sourceColumn], [edge.target, edge.data?.targetColumn]] as const) {
      if (!column) continue;
      litColumns.set(nodeId, [...(litColumns.get(nodeId) ?? []), column]);
    }
  }
  return {
    nodes: nodes.map((node) => {
      if (node.type === "boundary") return node;
      const flags = {
        isSelected: node.id === focus.selectedNodeId,
        isHovered: node.id === focus.hoveredNodeId,
        isMuted: Boolean(focus.hoveredNodeId) && !litNodeIds.has(node.id),
        litColumns: litColumns.get(node.id),
      };
      return { ...node, data: { ...node.data, ...flags } };
    }),
    edges: edges.map((edge) => {
      const lit = isLit(edge);
      const data = edge.data ? { ...edge.data, isHovered: edge.id === focus.hoveredEdgeId, isLit: lit, isMuted: isFocusing && !lit } : edge.data;
      const markers = isErd ? erdMarkers(data ?? {}, lit) : { markerEnd: edgeMarker(lit) };
      return { ...edge, ...markers, selected: lit, data };
    }),
  };
}
