import type { Edge, Node, Rect, XYPosition } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { EDGE_COLOR, LABEL_HEIGHT, labelWidth, layoutGraph } from "../graph/layout.utils";
import { pipelineLayoutInput, returnEdgeTitle, type PipelineEdge, type PipelineGraph, type StepNode, STEP_NODE_HEIGHT, STEP_NODE_WIDTH } from "./pipeline-graph.utils";

export type StepFlowNode = Node<StepNode, "step">;
/** `points` is ELK's orthogonal route, `labelCenter` the middle of the label box ELK reserved on it; both absolute. */
/**
 * `isLast` marks the edge of the pipeline's last transition; `title` explains a return edge on its label, `cause` is the
 * run that returned the issue.
 */
export type PipelineEdgeData = { kind: PipelineEdge["kind"]; label?: string; title?: string; cause?: number; isLast: boolean; points: XYPosition[]; labelCenter: XYPosition | null };
export type PipelineFlowEdge = Edge<PipelineEdgeData, "pipeline">;

/** Stroke of a return edge and its label: the amber of findings that send the issue back. */
export const RETURN_EDGE_COLOR = "#fbbf24";
/** Stroke of the last transition's edge: the blue that marks the current step. */
export const LAST_EDGE_COLOR = "#60a5fa";

/** Stroke of an edge: a return always in amber, else the last transition in blue and the rest in the diagram's edge color. */
export function pipelineEdgeColor(kind: PipelineEdge["kind"], isLast: boolean): string {
  if (kind === "return") return RETURN_EDGE_COLOR;
  return isLast ? LAST_EDGE_COLOR : EDGE_COLOR;
}

/**
 * Lays the pipeline out left to right with ELK (`layoutGraph`, whose waiting and aborting it shares) and returns the
 * React Flow nodes and edges: one node per step, the baseline in the diagram's edge color, every return in amber
 * with its findings label on the route and the edge of the last transition, unless a return, in blue.
 */
export async function layoutPipeline(graph: PipelineGraph, signal?: AbortSignal): Promise<{ nodes: StepFlowNode[]; edges: PipelineFlowEdge[] }> {
  const { positions, routes } = await layoutGraph(pipelineLayoutInput(graph), signal);
  const nodes: StepFlowNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: "step",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: node,
    width: STEP_NODE_WIDTH,
    height: STEP_NODE_HEIGHT,
    draggable: false,
    selectable: false,
  }));
  const edges: PipelineFlowEdge[] = graph.edges.map((edge) => {
    const isLast = edge.id === graph.lastEdgeId;
    const color = pipelineEdgeColor(edge.kind, isLast);
    return {
      id: edge.id,
      type: "pipeline",
      source: edge.source,
      target: edge.target,
      data: {
        kind: edge.kind,
        label: edge.kind === "return" ? edge.label : undefined,
        title: edge.kind === "return" ? returnEdgeTitle(edge) : undefined,
        cause: edge.kind === "return" ? edge.cause : undefined,
        isLast,
        points: routes.get(edge.id)?.points ?? [],
        labelCenter: routes.get(edge.id)?.labelCenter ?? null,
      },
      // Sized in pixels so the arrowhead keeps its size at every stroke width.
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14, markerUnits: "userSpaceOnUse" },
      selectable: false,
      // Behind the steps, so a return route passing a box does not cover it; the last transition above the other edges.
      zIndex: isLast ? -1 : -2,
    };
  });
  return { nodes, edges };
}

/**
 * The box the laid-out pipeline takes: its steps, the routes of its edges and their labels. The returns arc above the
 * steps, so fitting the steps alone would cut them off.
 */
export function pipelineBounds(nodes: StepFlowNode[], edges: PipelineFlowEdge[]): Rect {
  const boxes: Rect[] = nodes.map((node) => ({ x: node.position.x, y: node.position.y, width: node.width ?? 0, height: node.height ?? 0 }));
  for (const edge of edges) {
    for (const point of edge.data?.points ?? []) {
      boxes.push({ x: point.x, y: point.y, width: 0, height: 0 });
    }
    const center = edge.data?.labelCenter;
    if (center && edge.data?.label) {
      const width = labelWidth(edge.data.label);
      boxes.push({ x: center.x - width / 2, y: center.y - LABEL_HEIGHT / 2, width, height: LABEL_HEIGHT });
    }
  }
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
