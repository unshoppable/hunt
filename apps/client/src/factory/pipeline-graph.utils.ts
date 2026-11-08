import type { Run, RunOutcome } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { SWF_STEPS, type SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { LayoutInput } from "../graph/layout.utils";
import type { PipelineRecord } from "../sessions/swf-pipeline.utils";

/** The step names as the Factory tab shows them. */
export const STEP_LABELS: Record<SwfStep, string> = {
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  pr: "Pull request",
  checks: "Checks",
  "human-review": "Human review",
  merge: "Merge",
};

/** How a run ended, in words. */
export const OUTCOME_LABELS: Record<RunOutcome, string> = { running: "Running", passed: "Passed", returned: "Returned", failed: "Failed", restarted: "Restarted" };

/** One step of the pipeline as a node: its runs so far, whether the pipeline stands at it and how its last run ended. */
export type StepNode = {
  id: SwfStep;
  label: string;
  runs: Run[];
  /** How often the step ran again after its first run. */
  repeats: number;
  /** The pipeline's current step, running or not. */
  isCurrent: boolean;
  /** A run of the step is under way. */
  isRunning: boolean;
  /** How the step's last run ended; null before its first run and while one runs. */
  outcome: Exclude<RunOutcome, "running"> | null;
};

/** The baseline from one step to the next. */
export type FlowEdge = { id: string; kind: "flow"; source: SwfStep; target: SwfStep };
/**
 * A run that sent the issue back to implement: from the step of the run `cause` to the step of the run `n` it caused;
 * `index` counts the returns in their order from 1, and the label leads with it.
 */
export type ReturnEdge = { id: string; kind: "return"; source: SwfStep; target: SwfStep; cause: number; n: number; index: number; findings: number; label: string };
/** The last transition when neither the baseline nor a return connects its steps, such as checks → merge or merge → human-review. */
export type JumpEdge = { id: string; kind: "jump"; source: SwfStep; target: SwfStep };
export type PipelineEdge = FlowEdge | ReturnEdge | JumpEdge;

/** The move from the step of the last run but one (`source`) to the step of the last run `n`. */
export type Transition = { source: SwfStep; target: SwfStep; n: number };

/** `lastEdgeId` names the edge of `lastTransition`; null without one or for a step that started over (`source` = `target`). */
export type PipelineGraph = { nodes: StepNode[]; edges: PipelineEdge[]; lastTransition: Transition | null; lastEdgeId: string | null };

/**
 * The graph of the pipeline: every step of the baseline plan → … → merge as a node with its runs, the current step
 * marked, plus one return edge per implement run that a `returned` run caused, labelled with that run's findings. A
 * `cause` that names no run of the record (a record cut by hand) draws no edge. The last transition is marked on the
 * return edge of the last run, else on the baseline edge between its steps, else on a jump edge drawn for it alone.
 */
export function pipelineGraph(record: PipelineRecord): PipelineGraph {
  const nodes: StepNode[] = SWF_STEPS.map((step) => {
    const runs = record.runs.filter((run) => run.step === step);
    const last = runs[runs.length - 1];
    return {
      id: step,
      label: STEP_LABELS[step],
      runs,
      repeats: Math.max(0, runs.length - 1),
      isCurrent: record.step === step,
      isRunning: last?.outcome === "running",
      outcome: last && last.outcome !== "running" ? last.outcome : null,
    };
  });
  const edges: PipelineEdge[] = SWF_STEPS.slice(1).map((step, index) => ({ id: `flow:${SWF_STEPS[index]}->${step}`, kind: "flow", source: SWF_STEPS[index], target: step }));
  for (const run of record.runs) {
    if (run.cause === undefined) continue;
    const cause = record.runs.find((candidate) => candidate.n === run.cause);
    if (!cause) continue;
    const findings = cause.findings ?? 0;
    const index = edges.filter((edge) => edge.kind === "return").length + 1;
    edges.push({
      id: `return:${cause.n}->${run.n}`,
      kind: "return",
      source: cause.step,
      target: run.step,
      cause: cause.n,
      n: run.n,
      index,
      findings,
      label: `#${index} · ${findingsText(findings)}`,
    });
  }
  const lastTransition = pipelineLastTransition(record);
  return { nodes, edges, lastTransition, lastEdgeId: lastTransition ? lastTransitionEdge(lastTransition, edges) : null };
}

/** The transition into the last run of `record`; null before the second run. */
export function pipelineLastTransition(record: PipelineRecord): Transition | null {
  const target = record.runs[record.runs.length - 1];
  const source = record.runs[record.runs.length - 2];
  if (!target || !source) return null;
  return { source: source.step, target: target.step, n: target.n };
}

/** The id of the edge that shows `transition`, adding a jump edge to `edges` when no edge connects its steps. */
function lastTransitionEdge(transition: Transition, edges: PipelineEdge[]): string | null {
  if (transition.source === transition.target) return null;
  const returned = edges.find((edge) => edge.kind === "return" && edge.n === transition.n);
  if (returned) return returned.id;
  const flow = edges.find((edge) => edge.kind === "flow" && edge.source === transition.source && edge.target === transition.target);
  if (flow) return flow.id;
  const jump: JumpEdge = { id: `jump:${transition.source}->${transition.target}`, kind: "jump", source: transition.source, target: transition.target };
  edges.push(jump);
  return jump.id;
}

/** What the graph focuses on: the edge (or its label) or the step the pointer rests on, else the clicked step. */
export type PipelineFocus = { edgeId: string } | { stepId: string } | null;

/**
 * How an edge shows for `focus`: the focused edge and every edge of a focused step stand out, all others fade; null
 * while nothing is focused.
 */
export function edgeEmphasis(focus: PipelineFocus, edge: { id: string; source: string; target: string }): "highlighted" | "dimmed" | null {
  if (!focus) return null;
  const isFocused = "edgeId" in focus ? focus.edgeId === edge.id : focus.stepId === edge.source || focus.stepId === edge.target;
  return isFocused ? "highlighted" : "dimmed";
}

/** What a return edge stands for, as its label's tooltip says it. */
export function returnEdgeTitle(edge: ReturnEdge): string {
  const text = `Return #${edge.index}: run ${edge.cause} (${STEP_LABELS[edge.source]}) sent the issue back to ${STEP_LABELS[edge.target]}`;
  return `${text} with ${findingsText(edge.findings)}; run ${edge.n} took them on`;
}

function findingsText(findings: number): string {
  return `${findings} ${findings === 1 ? "finding" : "findings"}`;
}

/** `transition` in words for the Factory tab's header: `Review → Implement`. */
export function transitionText(transition: Transition): string {
  return `${STEP_LABELS[transition.source]} → ${STEP_LABELS[transition.target]}`;
}

export const STEP_NODE_WIDTH = 132;
export const STEP_NODE_HEIGHT = 52;

/** Keeps the baseline pointing forward when ELK breaks the cycles the return edges make, so the steps stay one line. */
const BASELINE_PRIORITY = 10;

/** The port of `step` where the baseline enters (`in`, left), leaves (`out`, right) or a return attaches (`top`). */
export function stepPortId(step: SwfStep, side: "in" | "out" | "top"): string {
  return `${step}:${side}`;
}

/**
 * The graph as ELK lays it out: the steps left to right in one line, the baseline between their left and right sides,
 * every return and the jump between the top sides of their two steps so that they arc over the baseline, a return with
 * its label; nothing grouped.
 */
export function pipelineLayoutInput(graph: PipelineGraph): LayoutInput {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      width: STEP_NODE_WIDTH,
      height: STEP_NODE_HEIGHT,
      ports: [
        { id: stepPortId(node.id, "in"), x: 0, y: STEP_NODE_HEIGHT / 2 },
        { id: stepPortId(node.id, "out"), x: STEP_NODE_WIDTH, y: STEP_NODE_HEIGHT / 2 },
        { id: stepPortId(node.id, "top"), x: STEP_NODE_WIDTH / 2, y: 0 },
      ],
    })),
    groups: [],
    edges: graph.edges.map((edge) => {
      if (edge.kind === "return") return { id: edge.id, source: stepPortId(edge.source, "top"), target: stepPortId(edge.target, "top"), label: edge.label };
      if (edge.kind === "jump") return { id: edge.id, source: stepPortId(edge.source, "top"), target: stepPortId(edge.target, "top") };
      return { id: edge.id, source: stepPortId(edge.source, "out"), target: stepPortId(edge.target, "in"), priority: BASELINE_PRIORITY };
    }),
    direction: "RIGHT",
    mergeEdges: false,
    spacing: { nodeNode: 32, betweenLayers: 40 },
  };
}

/** How long `run` took, or has been running at `now` (milliseconds since the epoch); 0 for a run whose times do not parse. */
export function runDuration(run: Run, now: number): number {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

/** `milliseconds` as a short duration of a run, which lasts seconds to hours: `45s`, `12m`, `1h 05m`. */
export function formatRunDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A link of the Factory tab's header to the pipeline's issue or pull request on GitHub. */
export type PipelineLink = { label: string; url: string };

/**
 * The GitHub pages of the issue `issue` and the pull request `pullRequest` in the repository `repo` (`<owner>/<repo>`);
 * none without the repository, which only a session still on its VM names.
 */
export function pipelineLinks(repo: string | null, issue: number | null, pullRequest: number | null): PipelineLink[] {
  if (!repo) return [];
  const links: PipelineLink[] = [];
  if (issue) {
    links.push({ label: `Issue #${issue}`, url: `https://github.com/${repo}/issues/${issue}` });
  }
  if (pullRequest) {
    links.push({ label: `PR #${pullRequest}`, url: `https://github.com/${repo}/pull/${pullRequest}` });
  }
  return links;
}
