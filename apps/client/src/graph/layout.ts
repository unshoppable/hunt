import type ElkConstructor from "elkjs/lib/elk-api";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { Edge, EdgeMarker, Node, XYPosition } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { Diagram, DiagramGroup, DiagramNode } from "./diagram";

export type FileNode = Node<DiagramNode, "file">;
export type FolderGroupNode = Node<DiagramGroup, "folder">;
export type DiagramFlowNode = FileNode | FolderGroupNode;
/** Room ELK keeps between a group's border and its files; the top holds the folder label. */
const GROUP_PADDING = "[top=34,left=16,bottom=16,right=16]";
/**
 * `points` is ELK's orthogonal route from source to target, `labelCenter` the middle of the label box ELK reserved
 * on that route: the label sits on a segment that is long enough for it and clear of the nodes.
 */
export type DependencyEdgeData = {
  label?: string;
  description?: string;
  points: XYPosition[];
  labelCenter: XYPosition | null;
  /** The mouse is on the edge's path; the view then shows its description. */
  isHovered?: boolean;
  /** Another edge or file is hovered and this edge is not part of it; the view then fades it. */
  isMuted?: boolean;
  /** The edge points at a file without changes, shown for context; the view draws it dashed. */
  isToContext?: boolean;
};
export type DependencyEdge = Edge<DependencyEdgeData, "dependency">;

type ElkEngine = InstanceType<typeof ElkConstructor>;
let elkPromise: Promise<ElkEngine> | null = null;

/** The ELK engine, loaded on first use because its bundle is large; it lays out in a Web Worker, so a large diagram never blocks the page. */
function elk(): Promise<ElkEngine> {
  if (!elkPromise) {
    elkPromise = Promise.all([import("elkjs/lib/elk-api.js"), import("elkjs/lib/elk-worker.min.js?url")]).then(
      ([api, worker]) => new api.default({ workerUrl: worker.default }),
    );
  }
  return elkPromise;
}

/** The last requested layout; ELK lays out one diagram at a time, in the order they were requested. */
let lastLayout: Promise<unknown> = Promise.resolve();

/**
 * Lays the diagram out top-down (dependents above their dependencies) with ELK's layered algorithm, folder groups
 * as compound nodes, and returns React Flow nodes (groups before their files) and edges. Edges leaving the same
 * file share one trunk and split near their targets, and the layers are compacted towards short edges, so a
 * dependency chain reads as a stack with few parallel lines.
 * A layout waits for the one requested before it; when `signal` aborts in the meantime it rejects without running,
 * so a burst of requests (unchecking files one after another) lays out only the newest diagram.
 */
export function layoutDiagram(diagram: Diagram, signal?: AbortSignal): Promise<{ nodes: DiagramFlowNode[]; edges: DependencyEdge[] }> {
  const start = () => {
    signal?.throwIfAborted();
    return runLayout(diagram);
  };
  const layout = lastLayout.then(start, start);
  lastLayout = layout;
  return layout;
}

/** One ELK run of `layoutDiagram`. */
async function runLayout(diagram: Diagram): Promise<{ nodes: DiagramFlowNode[]; edges: DependencyEdge[] }> {
  const toElkNode = (node: DiagramNode): ElkNode => ({ id: node.path, width: node.width, height: node.height });
  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.edgeNode": "24",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.mergeEdges": "true",
      "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
      "elk.layered.thoroughness": "100",
    },
    children: [
      ...diagram.groups.map((group) => ({
        id: group.id,
        layoutOptions: { "elk.padding": GROUP_PADDING },
        children: diagram.nodes.filter((node) => node.groupId === group.id).map(toElkNode),
      })),
      ...diagram.nodes.filter((node) => !node.groupId).map(toElkNode),
    ],
    // ELK keeps room for each label on its edge, widening the gap between two layers when a label needs it.
    edges: diagram.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      labels: edge.label ? [{ text: edge.label, width: labelWidth(edge.label), height: LABEL_HEIGHT, layoutOptions: INLINE_LABEL }] : [],
    })),
  };

  const engine = await elk();
  const result: ElkNode = diagram.nodes.length ? await engine.layout(elkGraph) : elkGraph;
  // ELK positions children relative to their parent and edge routes relative to the edge's container node.
  const groupBoxes = new Map((result.children ?? []).filter((child) => child.children?.length).map((child) => [child.id, child]));
  const relativePositions = new Map<string, XYPosition>();
  const absoluteOrigins = new Map<string, XYPosition>([["root", { x: 0, y: 0 }]]);
  for (const child of result.children ?? []) {
    const position = { x: child.x ?? 0, y: child.y ?? 0 };
    relativePositions.set(child.id, position);
    absoluteOrigins.set(child.id, position);
    for (const grandchild of child.children ?? []) {
      relativePositions.set(grandchild.id, { x: grandchild.x ?? 0, y: grandchild.y ?? 0 });
    }
  }
  const routes = new Map(
    (result.edges ?? []).map((edge) => {
      // Routes and label boxes are relative to the edge's container node.
      const origin = absoluteOrigins.get(edge.container ?? "root") ?? { x: 0, y: 0 };
      const section = edge.sections?.[0];
      const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({ x: point.x + origin.x, y: point.y + origin.y })) : [];
      const label = edge.labels?.[0];
      const labelCenter = label && label.x !== undefined && label.y !== undefined ? { x: label.x + (label.width ?? 0) / 2 + origin.x, y: label.y + (label.height ?? 0) / 2 + origin.y } : null;
      return [edge.id, { points, labelCenter }];
    }),
  );

  const groupNodes: FolderGroupNode[] = diagram.groups.map((group) => {
    const box = groupBoxes.get(group.id);
    return {
      id: group.id,
      type: "folder",
      position: relativePositions.get(group.id) ?? { x: 0, y: 0 },
      data: group,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
      // The area must not catch the mouse, or the edges and labels inside it could not be hovered.
      style: { pointerEvents: "none" },
    };
  });
  const fileNodes: FileNode[] = diagram.nodes.map((node) => ({
    id: node.path,
    type: "file",
    position: relativePositions.get(node.path) ?? { x: 0, y: 0 },
    parentId: node.groupId,
    data: node,
    width: node.width,
    height: node.height,
    selectable: true,
    draggable: false,
  }));
  const nodes: DiagramFlowNode[] = [...groupNodes, ...fileNodes];

  const contextPaths = new Set(diagram.nodes.filter((node) => !node.isChanged).map((node) => node.path));
  const edges: DependencyEdge[] = diagram.edges.map((edge) => ({
    id: edge.id,
    type: "dependency",
    source: edge.source,
    target: edge.target,
    data: {
      label: edge.label,
      description: edge.description,
      points: routes.get(edge.id)?.points ?? [],
      labelCenter: routes.get(edge.id)?.labelCenter ?? null,
      isToContext: contextPaths.has(edge.target),
    },
    markerEnd: edgeMarker(false),
    // React Flow lets the mouse through an unselectable edge; the panel needs its hover for the description.
    selectable: true,
    // Behind the folder areas (-1) and the files (0); the panel keeps these levels fixed, also while hovered.
    zIndex: -2,
  }));

  return { nodes, edges };
}

/** Stroke of an edge and its arrowhead at rest and while it or its source file is hovered. */
export const EDGE_COLOR = "#4b5563";
export const EDGE_COLOR_HIGHLIGHTED = "#e5e7eb";

/** Arrowhead in the edge's color; sized in pixels so it keeps its size when the highlighted stroke gets thicker. */
export function edgeMarker(isHighlighted: boolean): EdgeMarker {
  return { type: MarkerType.ArrowClosed, color: isHighlighted ? EDGE_COLOR_HIGHLIGHTED : EDGE_COLOR, width: 14, height: 14, markerUnits: "userSpaceOnUse" };
}

const LABEL_CHAR_WIDTH = 7.4;
/** Horizontal padding and border of the rendered label box. */
const LABEL_PADDING = 20;
/** Widest box the layout reserves; the view truncates a longer label and shows the whole text in its tooltip. */
export const MAX_LABEL_WIDTH = 300;
/** Height of the rendered label box. */
export const LABEL_HEIGHT = 26;
/** Puts the label on its edge instead of beside it; the edge runs behind the label box. */
const INLINE_LABEL = { "elk.edgeLabels.inline": "true" };

/** Approximate rendered width of an edge label in px, capped at `MAX_LABEL_WIDTH`. */
export function labelWidth(label: string): number {
  return Math.min(label.length * LABEL_CHAR_WIDTH + LABEL_PADDING, MAX_LABEL_WIDTH);
}

const CORNER_RADIUS = 8;

/** SVG path through `points` with rounded corners; straight between the first and last point when there are no bends. */
export function orthogonalPath(points: XYPosition[]): string {
  if (points.length < 2) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const radius = Math.min(CORNER_RADIUS, distance(previous, corner) / 2, distance(corner, next) / 2);
    const entry = towards(corner, previous, radius);
    const exit = towards(corner, next, radius);
    path += ` L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

function distance(a: XYPosition, b: XYPosition): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point `length` away from `from` in the direction of `to`. */
function towards(from: XYPosition, to: XYPosition, length: number): XYPosition {
  const total = distance(from, to);
  if (!total) return from;
  return { x: from.x + ((to.x - from.x) / total) * length, y: from.y + ((to.y - from.y) / total) * length };
}
