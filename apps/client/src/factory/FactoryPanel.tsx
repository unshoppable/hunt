import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Background, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { MAX_ATTEMPTS, type Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { MarkdownText } from "../chat/messages/MessageList";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import { EMPTY_PIPELINE, useFactoryStore } from "../sessions/swf-pipeline.store";
import { HEADER_BAR } from "../ui/bars.constants";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { AGENT_CHIP, Chip } from "../ui/Chip";
import { errorText } from "../ui/error-text.utils";
import { ExternalIcon, GitHubIcon, Spinner } from "../ui/Icons";
import { useLoad } from "../ui/load.hook";
import { FACTORY_EDGE_TYPES, FACTORY_NODE_TYPES } from "./FactoryNodes";
import { formatRunDuration, OUTCOME_LABELS, pipelineGraph, pipelineLinks, runDuration, STEP_LABELS } from "./pipeline-graph.utils";
import { layoutPipeline, type PipelineFlowEdge, type StepFlowNode } from "./pipeline-layout.utils";

/** How often the duration of a running run counts up. */
const CLOCK_TICK_MS = 1000;
const FIT_VIEW_OPTIONS = { padding: 0.1, minZoom: 0.3, maxZoom: 1 };
const HINT = "px-4 py-3 text-[13px] leading-snug text-neutral-500";

/** Colour of a run's outcome chip in the timeline. */
const OUTCOME_CHIP: Record<Run["outcome"], string> = {
  running: "border-blue-400/40 bg-blue-400/10 text-blue-300",
  passed: AGENT_CHIP.done,
  returned: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  failed: AGENT_CHIP.failed,
  restarted: AGENT_CHIP.neutral,
};

/**
 * The Factory tab of a session of the swf poller: the pipeline of its issue as the record in `.hunt/swf/pipeline.json` of
 * the worktree tells it, pulled from the VM after every turn, so it reads without the VM too. On top the steps plan →
 * implement → verify → gate → pr → review → human-review → merge as a graph, each with its run count, the current step
 * marked and every return to implement as an amber edge labelled with its findings; below the runs in order with their
 * outcome and duration, and under them the step result of the selected run (by default the latest one that has one).
 * Reads the record again after every pull of `.hunt/swf/` (`swf:pulled`, wired in app/window-bootstrap.hook.ts), when the
 * session's turn ends or its files synced, when the window gets the focus and on Refresh.
 */
export function FactoryPanel({ sessionId }: { sessionId: string }) {
  const record = useFactoryStore((state) => state.pipelines[sessionId] ?? EMPTY_PIPELINE);
  const refresh = useFactoryStore((state) => state.refresh);
  const repo = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.remote?.repo ?? null);
  const issue = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.remote?.issue ?? null);
  /** Bumped when a sync brought files from the VM or a turn of a local agent ended: the record may have changed. */
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  /** The relay's report of a running turn; its end means the pipeline moved on and the pull of `.hunt/swf/` followed. */
  const isTurnRunning = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.remote?.relayActivity?.isTurnRunning ?? false);
  const lastActiveAt = useHuntStore((state) => state.sessions.find((session) => session.id === sessionId)?.remote?.lastActiveAt ?? null);
  const { pipeline, steps } = record;
  const [selectedN, setSelectedN] = useState<number | null>(null);
  const [flow, setFlow] = useState<{ nodes: StepFlowNode[]; edges: PipelineFlowEdge[] } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  /** Bumped when a layout lands so React Flow remounts and fits the graph into view. */
  const [layoutVersion, setLayoutVersion] = useState(0);
  const now = useClock(Boolean(pipeline?.currentRun));

  useEffect(() => {
    void refresh(sessionId);
  }, [sessionId, editVersion, isTurnRunning, lastActiveAt, refresh]);

  useEffect(() => {
    const onFocus = () => void refresh(sessionId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sessionId, refresh]);

  const graph = useMemo(() => (pipeline ? pipelineGraph(pipeline) : null), [pipeline]);
  useLoad(
    (signal) => (graph ? layoutPipeline(graph, signal) : Promise.resolve(null)),
    {
      onValue: (laidOut) => {
        setFlow(laidOut);
        setLayoutError(null);
        setLayoutVersion((version) => version + 1);
      },
      onError: (reason) => setLayoutError(errorText(reason)),
    },
    [graph],
  );

  const runs = pipeline?.runs ?? [];
  const stepFileNs = useMemo(() => new Set(steps.map((step) => step.n)), [steps]);
  /** The run whose step result shows: the selected one, else the latest run that has a result. */
  const shownN = selectedN !== null && stepFileNs.has(selectedN) ? selectedN : (steps[steps.length - 1]?.n ?? null);
  const links = pipelineLinks(repo, issue, pipeline?.pullRequest ?? null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Factory</span>
        {pipeline ? <span className="min-w-0 truncate text-[13px] text-neutral-400">{statusText(pipeline)}</span> : null}
        <span className="flex-1" />
        {record.isLoading ? <Spinner /> : null}
        {links.map((link) => (
          <button key={link.url} type="button" onClick={() => void openUrl(link.url)} className={SECONDARY_BUTTON_XS} title={`Open ${link.url}`}>
            <GitHubIcon />
            {link.label}
            <ExternalIcon className="size-3" />
          </button>
        ))}
        <button type="button" onClick={() => void refresh(sessionId)} className={SECONDARY_BUTTON_XS} title="Read the pipeline's record again">
          Refresh
        </button>
      </div>

      {record.error ? <p className="shrink-0 px-4 pt-3 text-[13px] leading-snug break-words text-red-300">{record.error}</p> : null}

      {record.isLoaded && !pipeline && !record.error ? (
        <p className={HINT}>
          The pipeline has not reported yet. Its record lands in <code className="font-mono text-[12px] text-neutral-400">.hunt/swf/</code> of the worktree with
          the first step and comes here from the VM after every turn.
        </p>
      ) : null}

      {pipeline ? (
        <>
          <div className="relative h-[180px] shrink-0 border-b border-(--line)">
            {layoutError ? <p className="absolute inset-x-3 top-3 z-10 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[13px] text-red-300">{layoutError}</p> : null}
            {flow ? (
              <ReactFlowProvider key={layoutVersion}>
                <ReactFlow
                  nodes={flow.nodes}
                  edges={flow.edges}
                  nodeTypes={FACTORY_NODE_TYPES}
                  edgeTypes={FACTORY_EDGE_TYPES}
                  fitView
                  fitViewOptions={FIT_VIEW_OPTIONS}
                  minZoom={0.2}
                  maxZoom={1.5}
                  colorMode="dark"
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  zIndexMode="manual"
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={24} color="#2f343d" />
                </ReactFlow>
              </ReactFlowProvider>
            ) : null}
          </div>
          <div className="flex max-h-[40%] shrink-0 flex-col overflow-y-auto py-1.5 text-[13px]">
            {runs.length ? (
              runs.map((run) => (
                <RunRow key={run.n} run={run} now={now} hasStepFile={stepFileNs.has(run.n)} isSelected={run.n === shownN} onSelect={() => setSelectedN(run.n)} />
              ))
            ) : (
              <p className={HINT}>The record lists no runs yet.</p>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-(--line)">
            {shownN !== null ? (
              <StepResult key={`${sessionId}:${shownN}`} sessionId={sessionId} n={shownN} run={runs.find((run) => run.n === shownN) ?? null} stepCount={steps.length} />
            ) : (
              <p className={HINT}>No step has reported a result yet. A run with a result opens it here.</p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One line on where the pipeline stands, for the header: the step, the attempt and whether a person reviews. */
function statusText(pipeline: { step: Run["step"]; attempt: number; humanReview: boolean }): string {
  const parts = [`At ${STEP_LABELS[pipeline.step]}`];
  if (pipeline.attempt > 0) {
    parts.push(`attempt ${pipeline.attempt} of ${MAX_ATTEMPTS}`);
  }
  if (pipeline.humanReview) {
    parts.push("a person reviews before the merge");
  }
  return parts.join(" · ");
}

/**
 * A run of the timeline: its number, step, outcome, start and duration (counting up while it runs); a run with a step
 * result is a button that shows the result below, the shown one is highlighted.
 */
function RunRow({ run, now, hasStepFile, isSelected, onSelect }: { run: Run; now: number; hasStepFile: boolean; isSelected: boolean; onSelect: () => void }) {
  const started = Date.parse(run.startedAt);
  const startedText = Number.isNaN(started) ? run.startedAt : new Date(started).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  const content = (
    <>
      <span className="w-7 shrink-0 text-right text-neutral-500 tabular-nums">{run.n}</span>
      <span className="w-28 shrink-0 truncate font-medium text-neutral-100">{STEP_LABELS[run.step]}</span>
      <Chip className={OUTCOME_CHIP[run.outcome]} title={run.outcome === "returned" ? `Sent the issue back to implement with ${run.findings ?? 0} findings` : undefined}>
        {run.outcome === "running" ? <span className="size-1.5 animate-pulse rounded-full bg-blue-400" aria-hidden="true" /> : null}
        {OUTCOME_LABELS[run.outcome]}
        {run.outcome === "returned" && run.findings !== undefined ? ` · ${run.findings}` : ""}
      </Chip>
      <span className="flex-1" />
      <span className="shrink-0 text-neutral-400" title={run.startedAt}>
        {startedText}
      </span>
      <span className="w-16 shrink-0 text-right text-neutral-400 tabular-nums">{formatRunDuration(runDuration(run, now))}</span>
    </>
  );
  const row = `flex h-7 w-full items-center gap-3 px-4 ${isSelected ? "bg-(--row-selected)" : ""}`;
  if (!hasStepFile) return <div className={`${row} ${run.outcome === "running" ? "" : "opacity-80"}`}>{content}</div>;
  return (
    <button type="button" onClick={onSelect} className={`${row} rounded text-left hover:bg-(--row-hover)`} title="Show the step result of this run">
      {content}
    </button>
  );
}

/** The step result that ended the run `n`, as the agent wrote it, rendered like the chat's markdown. */
function StepResult({ sessionId, n, run, stepCount }: { sessionId: string; n: number; run: Run | null; stepCount: number }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // The count of step files changes when a result is added or replaced; the shown one is read again then.
  useLoad(() => commands.readSwfStep(sessionId, n), { onValue: setText, onError: (reason) => setError(errorText(reason)) }, [sessionId, n, stepCount]);
  if (error) return <p className="px-4 py-3 text-[13px] leading-snug break-words text-red-300">{error}</p>;
  if (text === undefined) return null;
  if (text === null) return <p className={HINT}>The step result of run {n} is not here yet.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
        {run ? (
          <div className="text-neutral-400">
            Step result of run {run.n}, <span className="text-neutral-200">{STEP_LABELS[run.step]}</span>
          </div>
        ) : null}
        {text.trim() ? <MarkdownText text={text} className="markdown-document" /> : <p className="text-neutral-500 italic">The step result is empty.</p>}
      </div>
    </div>
  );
}

/** The current time, every second while `isTicking`; otherwise the time of the last render that changed it. */
function useClock(isTicking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!isTicking) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isTicking]);
  return now;
}
