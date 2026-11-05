import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type EdgeTypes, type NodeProps, type NodeTypes } from "@xyflow/react";
import { HANDLE_STYLE } from "../graph/DiagramNodes";
import { EDGE_COLOR, MAX_LABEL_WIDTH, orthogonalPath } from "../graph/layout.utils";
import { OUTCOME_LABELS } from "./pipeline-graph.utils";
import { LAST_EDGE_COLOR, RETURN_EDGE_COLOR, type PipelineFlowEdge, type StepFlowNode } from "./pipeline-layout.utils";

/** Border of a step box by how its last run ended; a step without a run is dimmed, the current step is marked blue on top. */
const OUTCOME_BORDER: Record<NonNullable<StepFlowNode["data"]["outcome"]>, string> = {
  passed: "border-emerald-400/50",
  returned: "border-amber-400/60",
  failed: "border-red-400/60",
  restarted: "border-white/25",
};

/**
 * One step of the pipeline: its name and how often it ran, with the outcome of the last run colouring the border and
 * the count of its repeats beside the name. The current step gets a blue ring, a running one a pulsing dot beside its name.
 */
export const StepNodeView = memo(function StepNodeView({ data }: NodeProps<StepFlowNode>) {
  const runs = data.runs.length;
  const border = data.outcome ? OUTCOME_BORDER[data.outcome] : data.isCurrent ? "border-blue-400/60" : "border-(--line) opacity-60";
  const ring = data.isCurrent ? "shadow-[0_0_0_3px_rgba(96,165,250,0.3)]" : "";
  const count = `${runs} ${runs === 1 ? "run" : "runs"}`;
  const detail = runs === 0 ? "Not yet run" : data.isRunning ? `${count} · Running` : `${count} · ${OUTCOME_LABELS[data.outcome ?? "restarted"]}`;
  const repeated = data.repeats > 0 ? `Repeated ${data.repeats} ${data.repeats === 1 ? "time" : "times"}` : "";
  return (
    <div
      className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border bg-(--surface-inset) px-3 py-2 text-neutral-100 ${border} ${ring}`}
      title={repeated ? `${detail} · ${repeated}` : detail}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      <div className="flex items-center gap-1.5">
        {data.isRunning ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-400" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{data.label}</span>
        {data.repeats > 0 ? (
          <span className="shrink-0 text-[11px] text-amber-300 tabular-nums" aria-label={repeated}>
            ↻{data.repeats}
          </span>
        ) : null}
      </div>
      <span className="truncate text-[12px] text-neutral-400">{detail}</span>
    </div>
  );
});

/**
 * A connection on ELK's orthogonal route: the baseline in the diagram's edge color, a return in amber with its findings
 * label on the box ELK reserved for it, the last transition in blue and thicker. Without a route (before the layout
 * landed) a smooth step path stands in.
 */
export function PipelineEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<PipelineFlowEdge>) {
  const points = data?.points ?? [];
  const [fallbackPath] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  const path = points.length >= 2 ? orthogonalPath(points) : fallbackPath;
  const isReturn = data?.kind === "return";
  const isLast = data?.isLast ?? false;
  const labelCenter = data?.labelCenter ?? null;
  const stroke = isLast ? LAST_EDGE_COLOR : isReturn ? RETURN_EDGE_COLOR : EDGE_COLOR;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke, strokeWidth: isLast ? 2.2 : 1.4 }} />
      {labelCenter && data?.label ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelCenter.x}px, ${labelCenter.y}px)`, maxWidth: MAX_LABEL_WIDTH }}
            className="nodrag nopan pointer-events-none absolute truncate rounded-md border border-amber-400/40 bg-(--surface-inspector) px-2 py-[3px] text-[12px] leading-[18px] text-amber-300"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const FACTORY_NODE_TYPES: NodeTypes = { step: StepNodeView };
export const FACTORY_EDGE_TYPES: EdgeTypes = { pipeline: PipelineEdgeView };
