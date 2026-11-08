import { createContext, memo, useContext } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type EdgeTypes, type NodeProps, type NodeTypes } from "@xyflow/react";
import { HANDLE_STYLE } from "../graph/DiagramNodes";
import { MAX_LABEL_WIDTH, orthogonalPath } from "../graph/layout.utils";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { edgeEmphasis, OUTCOME_LABELS, type PipelineFocus } from "./pipeline-graph.utils";
import { isPollerStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { pipelineEdgeColor, type PipelineFlowEdge, type StepFlowNode } from "./pipeline-layout.utils";

/**
 * What the Factory graph focuses on, the clicked step, how the edge labels report the pointer resting on them and how a
 * click on one shows the run that returned the issue.
 */
export const PipelineFocusContext = createContext<{
  focus: PipelineFocus;
  selectedStep: SwfStep | null;
  setHover: (hover: PipelineFocus) => void;
  showRun: (n: number) => void;
}>({ focus: null, selectedStep: null, setHover: () => {}, showRun: () => {} });
/** Opacity of an edge that the focus on another edge or step fades. */
const DIMMED_EDGE_OPACITY = 0.15;
/** A return's label by its edge's emphasis; opaque, so that the edges behind it never show through its text. */
const LABEL_LOOK = {
  highlighted: "border-amber-300 bg-[color-mix(in_srgb,#fbbf24_18%,var(--surface-inspector))] text-amber-200",
  resting: "border-amber-400/40 bg-(--surface-inspector) text-amber-300",
  dimmed: "border-white/8 bg-(--surface-inspector) text-neutral-600",
};

/** Border of a step box by how its last run ended; a step without a run is dimmed, the current step is marked blue on top. */
const OUTCOME_BORDER: Record<NonNullable<StepFlowNode["data"]["outcome"]>, string> = {
  passed: "border-emerald-400/50",
  returned: "border-amber-400/60",
  failed: "border-red-400/60",
  restarted: "border-white/25",
};

/**
 * One step of the pipeline: its name and how often it ran, with the outcome of the last run colouring the border and
 * the count of its repeats beside the name. The current step gets a blue ring, a running one a pulsing dot beside its name,
 * the clicked one a white outline while the other steps fade.
 */
export const StepNodeView = memo(function StepNodeView({ data }: NodeProps<StepFlowNode>) {
  const { selectedStep } = useContext(PipelineFocusContext);
  const isSelected = selectedStep === data.id;
  const runs = data.runs.length;
  const border = data.outcome ? OUTCOME_BORDER[data.outcome] : data.isCurrent ? "border-blue-400/60" : "border-(--line)";
  const ring = data.isCurrent ? "shadow-[0_0_0_3px_rgba(96,165,250,0.3)]" : "";
  const outline = isSelected ? "outline-2 outline-offset-2 outline-white/80" : "";
  const opacity = selectedStep && !isSelected ? "opacity-40" : !data.outcome && !data.isCurrent ? "opacity-60" : "";
  const count = `${runs} ${runs === 1 ? "run" : "runs"}`;
  const isWaiting = data.isRunning && isPollerStep(data.id);
  const detail = runs === 0 ? "Not yet run" : isWaiting ? `${count} · Waiting` : data.isRunning ? `${count} · Running` : `${count} · ${OUTCOME_LABELS[data.outcome ?? "restarted"]}`;
  const repeated = data.repeats > 0 ? `Repeated ${data.repeats} ${data.repeats === 1 ? "time" : "times"}` : "";
  return (
    <div
      className={`flex h-full w-full flex-col justify-center gap-0.5 cursor-pointer rounded-lg border transition-opacity bg-(--surface-inset) px-3 py-2 text-neutral-100 ${border} ${ring} ${outline} ${opacity}`}
      title={`${repeated ? `${detail} · ${repeated}` : detail}\nClick to show its runs in the list`}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      <div className="flex items-center gap-1.5">
        {isWaiting ? <span className="size-2 shrink-0 rounded-full bg-violet-400" aria-hidden="true" /> : data.isRunning ? <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-400" aria-hidden="true" /> : null}
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
 * label on the box ELK reserved for it, the last transition thicker, glowing and, unless a return, in blue. A click on a return or
 * its label shows the run that returned the issue in the run list. Without a route (before the layout
 * landed) a smooth step path stands in. Once the pointer rests on an edge, its label or a step, or a step is clicked, the
 * edges it concerns stand out and the others fade, so the overlapping return routes can be told apart.
 */
export function PipelineEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<PipelineFlowEdge>) {
  const points = data?.points ?? [];
  const [fallbackPath] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  const path = points.length >= 2 ? orthogonalPath(points) : fallbackPath;
  const isLast = data?.isLast ?? false;
  const labelCenter = data?.labelCenter ?? null;
  const stroke = pipelineEdgeColor(data?.kind ?? "flow", isLast);
  const { focus, setHover, showRun } = useContext(PipelineFocusContext);
  const cause = data?.cause;
  const emphasis = edgeEmphasis(focus, { id, source, target });
  const strokeWidth = (isLast ? 2.2 : 1.4) + (emphasis === "highlighted" ? 1 : 0);
  const opacity = emphasis === "dimmed" ? DIMMED_EDGE_OPACITY : 1;
  const labelLook = LABEL_LOOK[emphasis ?? "resting"];
  const isGlowing = isLast && emphasis !== "dimmed";
  const filter = isGlowing ? `drop-shadow(0 0 3px ${stroke}) drop-shadow(0 0 6px ${stroke})` : undefined;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke, strokeWidth, opacity, filter, transition: EMPHASIS_TRANSITION }} />
      {labelCenter && data?.label ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelCenter.x}px, ${labelCenter.y}px)`, maxWidth: MAX_LABEL_WIDTH, boxShadow: isGlowing ? `0 0 8px ${stroke}` : undefined }}
            className={`nodrag nopan pointer-events-auto absolute cursor-pointer truncate rounded-md border px-2 transition-colors py-[3px] text-[12px] leading-[18px] ${labelLook}`}
            title={cause === undefined ? data.title : `${data.title}\nClick to show run ${cause}`}
            onClick={() => cause !== undefined && showRun(cause)}
            onMouseEnter={() => setHover({ edgeId: id })}
            onMouseLeave={() => setHover(null)}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const EMPHASIS_TRANSITION = "opacity 120ms, stroke-width 120ms";

export const FACTORY_NODE_TYPES: NodeTypes = { step: StepNodeView };
export const FACTORY_EDGE_TYPES: EdgeTypes = { pipeline: PipelineEdgeView };
