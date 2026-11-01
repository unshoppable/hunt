import type { Edge, Node, XYPosition } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { EDGE_COLOR, layoutGraph } from "../graph/layout.utils";
import { pipelineLayoutInput, type PipelineEdge, type PipelineGraph, type StepNode, STEP_NODE_HEIGHT, STEP_NODE_WIDTH } from "./pipeline-graph.utils";

export type StepFlowNode = Node<StepNode, "step">;
/** `points` is ELK's orthogonal route, `labelCenter` the middle of the label box ELK reserved on it; both absolute. */
export type PipelineEdgeData = { kind: PipelineEdge["kind"]; label?: string; points: XYPosition[]; labelCenter: XYPosition | null };
export type PipelineFlowEdge = Edge<PipelineEdgeData, "pipeline">;

/** Stroke of a return edge and its label: the amber of findings that send the issue back. */
export const RETURN_EDGE_COLOR = "#fbbf24";

/**
 * Lays the pipeline out left to right with ELK (`layoutGraph`, whose waiting and aborting it shares) and returns the
 * React Flow nodes and edges: one node per step, the baseline in the diagram's edge color and every return in amber
 * with its findings label on the route.
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
    const color = edge.kind === "return" ? RETURN_EDGE_COLOR : EDGE_COLOR;
    return {
      id: edge.id,
      type: "pipeline",
      source: edge.source,
      target: edge.target,
      data: {
        kind: edge.kind,
        label: edge.kind === "return" ? edge.label : undefined,
        points: routes.get(edge.id)?.points ?? [],
        labelCenter: routes.get(edge.id)?.labelCenter ?? null,
      },
      // Sized in pixels so the arrowhead keeps its size at every stroke width.
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14, markerUnits: "userSpaceOnUse" },
      selectable: false,
      // Behind the steps, so a return route passing a box does not cover it.
      zIndex: -1,
    };
  });
  return { nodes, edges };
}
