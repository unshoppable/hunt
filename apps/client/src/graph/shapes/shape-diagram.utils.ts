import type { Edge, Node, XYPosition } from "@xyflow/react";
import { Position } from "@xyflow/react";
import type { Cardinality, ShapeChange, ShapeDiagram, ShapeEdge, ShapeGroup, ShapeKind, ShapeNode } from "./shape-diagram.types";
import type { LayoutInput, LayoutNode, LayoutPort, LayoutResult, LayoutSpacing } from "../layout.utils";
import { GROUP_PADDING as BOUNDARY_PADDING, edgeMarker, layoutGraph } from "../layout.utils";
import { placeWithoutOverlaps } from "./element-overlap.utils";
import { countCrossings, routeConnections, STUB, type Connection, type Obstacle, type RouteEnd } from "./edge-route.utils";

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
 * a second line. The width follows the widest row (name in 13px sans, type in 12px mono) or the header (name in 13px
 * semibold capitals).
 */
export const TABLE_HEADER_HEIGHT = 40;
export const TABLE_HEADER_HEIGHT_WITH_DESCRIPTION = 58;
export const TABLE_ROW_HEIGHT = 28;
const TABLE_LABEL_CHAR_WIDTH = 9;
const TABLE_NAME_CHAR_WIDTH = 7;
const TABLE_TYPE_CHAR_WIDTH = 7.2;
/** The key icon column, the gaps around name and type and the horizontal padding of a row. */
const TABLE_ROW_OVERHEAD = 68;
const TABLE_BOTTOM_PADDING = 6;
const MIN_TABLE_WIDTH = 220;
const MAX_TABLE_WIDTH = 360;
/** ERD tables sit further apart than boxes: the relationships leave at their rows and need room to bend. */
const ERD_SPACING: LayoutSpacing = { nodeNode: 48, betweenLayers: 120 };
/**
 * At most this many tables stack in one layer of an ERD, so a cluster of referencing tables spreads sideways; ELK
 * tries each bound, since how often the relationships cross depends on it in no simple way.
 */
const ERD_TABLES_PER_LAYER_BOUNDS = [2, 3, 4];
/** How often at most ELK lays an ERD out per bound, each pass with the sides the last placement gave the relationships. */
const ERD_LAYOUT_PASSES = 2;
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
 * `points` is the orthogonal route from source to target (ELK's, or Hunt's own in a manual layout; empty when
 * neither found a way), `labelCenter` the middle of the label box ELK reserved on that route (null when the edge
 * was laid out without one); `hasInlineLabel` puts the label on the middle of the drawn route instead (a manual
 * layout); `cardinality` and the columns are set on ERD relationships only.
 */
export type ShapeEdgeData = {
  label?: string;
  description?: string;
  points: XYPosition[];
  labelCenter: XYPosition | null;
  hasInlineLabel?: boolean;
  sourceColumn?: string;
  targetColumn?: string;
  cardinality?: { source: Cardinality; target: Cardinality };
  /** The corners the user fixed by moving a segment; the view draws the edge through them instead of routing it. */
  bends?: XYPosition[];
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

/** The side of a table a relationship's handle sits on. */
export type HandleSide = "left" | "right";
/** The sides a relationship leaves its source table and enters its target table on. */
export type RelationshipSides = { source: HandleSide; target: HandleSide };

/** Id of the port (and React Flow handle) of `column` where a relationship leaves (`out`) or enters (`in`) the table on `side`. */
export function columnPortId(nodeId: string, column: string, end: "in" | "out", side: HandleSide): string {
  return `${nodeId}:${column}:${end}:${side}`;
}

/** A relationship runs between the facing sides of two tables only when they leave room for both its stubs. */
const FACING_GAP = 2 * STUB;

/**
 * The sides a relationship takes between two placed tables: the facing sides when one table lies beside the other
 * with room for the stubs between them, else, with the tables above each other, the same side on both, whichever
 * keeps the loop between them shorter.
 */
export function relationshipSides(source: Obstacle, target: Obstacle): RelationshipSides {
  if (source.x + source.width + FACING_GAP <= target.x) return { source: "right", target: "left" };
  if (target.x + target.width + FACING_GAP <= source.x) return { source: "left", target: "right" };
  const isRightShorter = Math.abs(source.x + source.width - (target.x + target.width)) <= Math.abs(source.x - target.x);
  return isRightShorter ? { source: "right", target: "right" } : { source: "left", target: "left" };
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
export function shapeEdgeId(diagram: Pick<ShapeDiagram, "type">, edge: ShapeDiagram["edges"][number]): string {
  return diagram.type === "erd" ? `${edge.source}.${edge.sourceColumn}->${edge.target}.${edge.targetColumn}` : `${edge.source}->${edge.target}`;
}

/**
 * The ELK input of a diagram: an ERD reads left to right, no merged trunks and no label boxes (the view shows a
 * relationship's label when it is hovered), with each relationship pinned to its columns' rows on the `sides` it
 * takes, or between the tables themselves while the sides are not known yet; every other type top-down with merged
 * edges and inline labels like the dependency diagram.
 */
export function toLayoutInput(diagram: ShapeDiagram, sides?: Map<string, RelationshipSides>, maxTablesPerLayer = ERD_TABLES_PER_LAYER_BOUNDS[1]): LayoutInput {
  const isErd = diagram.type === "erd";
  const portsByNode = new Map<string, LayoutPort[]>();
  const edges = diagram.edges.map((edge) => {
    const id = shapeEdgeId(diagram, edge);
    const edgeSides = isErd ? sides?.get(id) : undefined;
    if (!edgeSides) return { id, source: edge.source, target: edge.target, label: isErd ? undefined : edge.label };
    const sourcePort = columnPortId(edge.source, edge.sourceColumn ?? "", "out", edgeSides.source);
    const targetPort = columnPortId(edge.target, edge.targetColumn ?? "", "in", edgeSides.target);
    for (const [nodeId, column, portId, side] of [
      [edge.source, edge.sourceColumn, sourcePort, edgeSides.source],
      [edge.target, edge.targetColumn, targetPort, edgeSides.target],
    ] as const) {
      const node = diagram.nodes.find((candidate) => candidate.id === nodeId);
      const index = node?.columns?.findIndex((candidate) => candidate.name === column) ?? -1;
      if (!node || index < 0) continue;
      const ports = portsByNode.get(nodeId) ?? [];
      if (!ports.some((port) => port.id === portId)) {
        ports.push({ id: portId, x: side === "right" ? shapeNodeSize(node).width : 0, y: tableRowCenterY(node, index) });
      }
      portsByNode.set(nodeId, ports);
    }
    return { id, source: sourcePort, target: targetPort, label: undefined };
  });
  const nodes: LayoutNode[] = diagram.nodes.map((node) => {
    const layoutNode: LayoutNode = { id: node.id, ...shapeNodeSize(node), groupId: node.parent };
    const ports = portsByNode.get(node.id);
    if (ports) {
      layoutNode.ports = ports;
    }
    return layoutNode;
  });
  return {
    nodes,
    groups: (diagram.groups ?? []).map((group) => ({ id: group.id })),
    edges,
    direction: isErd ? "RIGHT" : "DOWN",
    mergeEdges: !isErd,
    spacing: isErd ? ERD_SPACING : undefined,
    maxNodesPerLayer: isErd ? maxTablesPerLayer : undefined,
  };
}

/** True once the user placed an element by hand: the diagram then keeps its positions instead of ELK's layout. */
export function hasManualLayout(diagram: ShapeDiagram): boolean {
  return diagram.nodes.some((node) => node.position);
}

/** True once the user placed an element or moved a connection by hand, which *Auto-layout* undoes. */
export function hasManualChanges(diagram: ShapeDiagram): boolean {
  return hasManualLayout(diagram) || diagram.edges.some((edge) => edge.bends);
}

/**
 * Where every element and boundary goes. ELK lays out the whole diagram; in a manual layout each placed element moves
 * to its `position`, the others keep ELK's place, an element that overlaps another moves aside (`placeWithoutOverlaps`)
 * and every boundary is fitted around its elements again. Shape
 * positions are relative to their boundary, like React Flow expects for a `parentId`.
 */
function placeElements(
  diagram: ShapeDiagram,
  positions: Map<string, XYPosition>,
  groupSizes: Map<string, { width: number; height: number }>,
): { shapes: Map<string, XYPosition>; boundaries: Map<string, { position: XYPosition; width: number; height: number }> } {
  const groupOrigin = (id: string | undefined) => (id ? (positions.get(id) ?? { x: 0, y: 0 }) : { x: 0, y: 0 });
  const boundaries = new Map((diagram.groups ?? []).map((group) => [group.id, { position: groupOrigin(group.id), ...(groupSizes.get(group.id) ?? { width: 0, height: 0 }) }]));
  if (!hasManualLayout(diagram)) {
    return { shapes: new Map(diagram.nodes.map((node) => [node.id, positions.get(node.id) ?? { x: 0, y: 0 }])), boundaries };
  }

  const wanted = new Map(
    diagram.nodes.map((node) => {
      if (node.position) return [node.id, node.position];
      const relative = positions.get(node.id) ?? { x: 0, y: 0 };
      const origin = node.parent && boundaries.has(node.parent) ? groupOrigin(node.parent) : { x: 0, y: 0 };
      return [node.id, { x: origin.x + relative.x, y: origin.y + relative.y }];
    }),
  );
  // ELK's places ignore the placed elements, and a table grows with its columns: whatever overlaps moves aside, the
  // elements without a place of their own first.
  const ordered = [...diagram.nodes.filter((node) => node.position), ...diagram.nodes.filter((node) => !node.position)];
  const absolute = placeWithoutOverlaps(ordered.map((node) => ({ id: node.id, ...(wanted.get(node.id) ?? { x: 0, y: 0 }), ...shapeNodeSize(node) })));
  for (const [groupId, boundary] of boundaries) {
    const members = diagram.nodes.filter((node) => node.parent === groupId);
    if (!members.length) continue;
    const boxes = members.map((node) => ({ ...(absolute.get(node.id) ?? { x: 0, y: 0 }), ...shapeNodeSize(node) }));
    const left = Math.min(...boxes.map((box) => box.x)) - BOUNDARY_PADDING.left;
    const top = Math.min(...boxes.map((box) => box.y)) - BOUNDARY_PADDING.top;
    const right = Math.max(...boxes.map((box) => box.x + box.width)) + BOUNDARY_PADDING.right;
    const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + BOUNDARY_PADDING.bottom;
    Object.assign(boundary, { position: { x: left, y: top }, width: right - left, height: bottom - top });
  }
  const shapes = new Map(
    diagram.nodes.map((node) => {
      const position = absolute.get(node.id) ?? { x: 0, y: 0 };
      const boundary = node.parent ? boundaries.get(node.parent) : undefined;
      return [node.id, boundary ? { x: position.x - boundary.position.x, y: position.y - boundary.position.y } : position];
    }),
  );
  return { shapes, boundaries };
}

/** The box of every shape in absolute diagram coordinates, from the places `placeElements` gave them. */
function absoluteBoxes(diagram: ShapeDiagram, placed: ReturnType<typeof placeElements>): Map<string, Obstacle> {
  return new Map(
    diagram.nodes.map((node) => {
      const position = placed.shapes.get(node.id) ?? { x: 0, y: 0 };
      const boundary = node.parent ? placed.boundaries.get(node.parent) : undefined;
      const origin = boundary ? boundary.position : { x: 0, y: 0 };
      return [node.id, { x: origin.x + position.x, y: origin.y + position.y, ...shapeNodeSize(node) }];
    }),
  );
}

/** The sides every relationship of an ERD takes between its placed tables, by edge id. */
function relationshipSidesOf(diagram: ShapeDiagram, boxes: Map<string, Obstacle>): Map<string, RelationshipSides> {
  return new Map(
    diagram.edges.flatMap((edge) => {
      const source = boxes.get(edge.source);
      const target = boxes.get(edge.target);
      return source && target ? [[shapeEdgeId(diagram, edge), relationshipSides(source, target)]] : [];
    }),
  );
}

/**
 * Where a connection leaves its source and enters its target on the placed elements: an ERD relationship at its
 * columns' rows on the sides it takes, every other connection at the bottom middle of its source and the top middle
 * of its target. Null when an end is missing.
 */
function connectionEnds(diagram: ShapeDiagram, edge: ShapeEdge, boxes: Map<string, Obstacle>, sides: RelationshipSides | undefined): { source: RouteEnd; target: RouteEnd } | null {
  const sourceBox = boxes.get(edge.source);
  const targetBox = boxes.get(edge.target);
  if (!sourceBox || !targetBox) return null;
  if (diagram.type !== "erd" || !sides) {
    return {
      source: { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height, side: Position.Bottom },
      target: { x: targetBox.x + targetBox.width / 2, y: targetBox.y, side: Position.Top },
    };
  }
  const rowEnd = (nodeId: string, column: string | undefined, box: Obstacle, side: HandleSide): RouteEnd | null => {
    const node = diagram.nodes.find((candidate) => candidate.id === nodeId);
    const index = node?.columns?.findIndex((candidate) => candidate.name === column) ?? -1;
    if (!node || index < 0) return null;
    return { x: side === "right" ? box.x + box.width : box.x, y: box.y + tableRowCenterY(node, index), side: side === "right" ? Position.Right : Position.Left };
  };
  const source = rowEnd(edge.source, edge.sourceColumn, sourceBox, sides.source);
  const target = rowEnd(edge.target, edge.targetColumn, targetBox, sides.target);
  return source && target ? { source, target } : null;
}

/**
 * Lays the diagram out and returns React Flow nodes (boundaries before the shapes inside them) and edges. Shape
 * positions are relative to their boundary; edge routes are absolute. ELK lays an ERD out several times and the
 * layout whose relationships cross each other least wins: once per bound on the tables per layer
 * (`ERD_TABLES_PER_LAYER_BOUNDS`), every relationship between its columns' ports on the facing sides of a
 * left-to-right reading, and once more where the placement has a table left of the one referencing it, or above
 * it, with the sides that placement calls for (`ERD_LAYOUT_PASSES`). In a manual layout ELK's routes no longer fit
 * the moved elements: Hunt routes the connections around the elements and clear of each other itself
 * (`routeConnections`), on the sides the placement calls for. Waits and aborts like `layoutGraph`.
 */
export async function layoutShapeDiagram(diagram: ShapeDiagram, signal?: AbortSignal): Promise<{ nodes: ShapeDiagramFlowNode[]; edges: ShapeFlowEdge[] }> {
  const isErd = diagram.type === "erd";
  const isManual = hasManualLayout(diagram);
  const facingSides = new Map(diagram.edges.map((edge): [string, RelationshipSides] => [shapeEdgeId(diagram, edge), { source: "right", target: "left" }]));
  let sides = facingSides;
  let layout: LayoutResult = await layoutGraph(toLayoutInput(diagram, sides), signal);
  let placed = placeElements(diagram, layout.positions, layout.groupSizes);
  if (isErd && isManual) {
    sides = relationshipSidesOf(diagram, absoluteBoxes(diagram, placed));
  } else if (isErd) {
    let best = { layout, placed, sides, crossings: Infinity };
    for (const bound of ERD_TABLES_PER_LAYER_BOUNDS) {
      sides = facingSides;
      for (let pass = 1; pass <= ERD_LAYOUT_PASSES; pass++) {
        layout = await layoutGraph(toLayoutInput(diagram, sides, bound), signal);
        placed = placeElements(diagram, layout.positions, layout.groupSizes);
        const crossings = countCrossings([...layout.routes.values()].map((route) => route.points));
        if (crossings < best.crossings) {
          best = { layout, placed, sides, crossings };
        }
        const settled = relationshipSidesOf(diagram, absoluteBoxes(diagram, placed));
        if ([...settled].every(([id, side]) => sides.get(id)?.source === side.source && sides.get(id)?.target === side.target)) break;
        sides = settled;
      }
    }
    ({ layout, placed, sides } = best);
  }
  const { shapes, boundaries } = placed;
  let routes = layout.routes;
  if (isManual) {
    const boxes = absoluteBoxes(diagram, placed);
    const connections = diagram.edges.flatMap((edge): Connection[] => {
      const id = shapeEdgeId(diagram, edge);
      const ends = connectionEnds(diagram, edge, boxes, sides.get(id));
      return ends && !edge.bends ? [{ id, ...ends }] : [];
    });
    const routed = await routeConnections(connections, [...boxes.values()], signal);
    routes = new Map([...routed].flatMap(([id, points]) => (points ? [[id, { points, labelCenter: null }]] : [])));
  }

  const boundaryNodes: BoundaryFlowNode[] = (diagram.groups ?? []).map((group) => {
    const { position, width, height } = boundaries.get(group.id) ?? { position: { x: 0, y: 0 }, width: 0, height: 0 };
    return {
      id: group.id,
      type: "boundary",
      position,
      data: group,
      width,
      height,
      // The area must not catch the mouse, or the edges and labels inside it could not be hovered.
      style: { width, height, pointerEvents: "none" },
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
      position: shapes.get(node.id) ?? { x: 0, y: 0 },
      parentId: node.parent && boundaries.has(node.parent) ? node.parent : undefined,
      data: { ...node, ...size },
      width: size.width,
      height: size.height,
      selectable: true,
      draggable: true,
    };
  });

  const edges: ShapeFlowEdge[] = diagram.edges.map((edge) => {
    const id = shapeEdgeId(diagram, edge);
    const route = routes.get(id);
    const data: ShapeEdgeData = {
      label: edge.label,
      description: edge.description,
      points: route?.points ?? [],
      labelCenter: route?.labelCenter ?? null,
      hasInlineLabel: isManual && !isErd,
      sourceColumn: edge.sourceColumn,
      targetColumn: edge.targetColumn,
      cardinality: edge.cardinality,
      bends: edge.bends,
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
      const edgeSides = sides.get(id) ?? { source: "right", target: "left" };
      flowEdge.sourceHandle = columnPortId(edge.source, edge.sourceColumn ?? "", "out", edgeSides.source);
      flowEdge.targetHandle = columnPortId(edge.target, edge.targetColumn ?? "", "in", edgeSides.target);
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

/** What the mouse is on and which element or connection the editor shows; every id null when nothing is. */
export type ShapeFocus = { hoveredEdgeId: string | null; hoveredNodeId: string | null; selectedNodeId: string | null; selectedEdgeId?: string | null };

/**
 * The flow nodes and edges with the interaction flags of `focus`: the hovered edge and the edges of the hovered
 * node are lit and get their bright markers, every other edge is muted while something is hovered; a hovered node
 * also mutes the nodes it is not connected to. ERD tables learn which of their columns the lit relationships are on.
 * Boundaries are left alone.
 */
export function decorateShapeFlow(nodes: ShapeDiagramFlowNode[], edges: ShapeFlowEdge[], focus: ShapeFocus, isErd: boolean): { nodes: ShapeDiagramFlowNode[]; edges: ShapeFlowEdge[] } {
  const isFocusing = Boolean(focus.hoveredEdgeId) || Boolean(focus.hoveredNodeId);
  const isLit = (edge: ShapeFlowEdge) =>
    edge.id === focus.hoveredEdgeId || (Boolean(focus.selectedEdgeId) && edge.id === focus.selectedEdgeId) || edge.source === focus.hoveredNodeId || edge.target === focus.hoveredNodeId;
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
      // Tables mark their selection themselves; every other shape gets the outline of `.shape-node-selected`.
      return { ...node, className: flags.isSelected && node.type !== "table" ? "shape-node-selected" : undefined, data: { ...node.data, ...flags } };
    }),
    edges: edges.map((edge) => {
      const lit = isLit(edge);
      const data = edge.data ? { ...edge.data, isHovered: edge.id === focus.hoveredEdgeId, isLit: lit, isMuted: isFocusing && !lit } : edge.data;
      const markers = isErd ? erdMarkers(data ?? {}, lit) : { markerEnd: edgeMarker(lit) };
      return { ...edge, ...markers, selected: lit, data };
    }),
  };
}
