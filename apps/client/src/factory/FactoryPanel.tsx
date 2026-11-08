import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Background, getViewportForBounds, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Rect } from "@xyflow/react";
import type { Pipeline, Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { RETURNING_STEPS } from "../../../../libs/domain/src/swf/step-settings.value-object.ts";
import { isAgentStep, type SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { PlanUsageWindows, useMinuteClock } from "../accounts/PlanUsageBar";
import type { UsageWindow } from "../accounts/plan-usage.types";
import { formatTokens } from "../chat/ContextMeter";
import { MarkdownText, MessageList } from "../chat/messages/MessageList";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import { useSessionViewStore } from "../sessions/inspector.store";
import { EMPTY_PIPELINE, useFactoryStore } from "../sessions/swf-pipeline.store";
import type { RunTokens, SwfStepFile } from "../sessions/swf-pipeline.types";
import { HEADER_BAR } from "../ui/bars.constants";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { AGENT_CHIP, Chip } from "../ui/Chip";
import { errorText } from "../ui/error-text.utils";
import { ExternalIcon, GitHubIcon, Spinner } from "../ui/Icons";
import { useLoad } from "../ui/load.hook";
import { PaneSeparator, Panel, PersistentGroup } from "../ui/ResizablePanes";
import { modelText, openableRuns, runModelWindows, shownRun, sumTokens, tokensTitle, totalTokens, uncachedTokens, type TokenCounts } from "./factory-runs.utils";
import { FACTORY_EDGE_TYPES, FACTORY_NODE_TYPES, PipelineFocusContext } from "./FactoryNodes";
import {
  formatRunDuration,
  OUTCOME_LABELS,
  pipelineGraph,
  pipelineLinks,
  runDuration,
  STEP_LABELS,
  transitionText,
  type PipelineFocus,
  type Transition,
} from "./pipeline-graph.utils";
import { layoutPipeline, pipelineBounds, type PipelineFlowEdge, type StepFlowNode } from "./pipeline-layout.utils";
import { runConversation, type RunConversation } from "./run-transcript.utils";
import { vmCost, type VmCost } from "./vm-cost.utils";

/** How often the duration of a running run counts up. */
const CLOCK_TICK_MS = 1000;
const FIT_VIEW_OPTIONS = { padding: 0.1, minZoom: 0.3, maxZoom: 1 };
const HINT = "px-4 py-3 text-[13px] leading-snug text-neutral-500";
/** Smallest heights of the graph, the run list and the run details, in pixels. */
const MIN_GRAPH_HEIGHT = 80;
const MIN_RUNS_HEIGHT = 60;
const MIN_DETAILS_HEIGHT = 120;

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
 * the worktree tells it, pulled from the VM whenever the runner wrote it, so it follows the pipeline live and reads
 * without the VM too. On top the steps plan →
 * implement → verify → review → pr → human-review → merge as a graph, each with its run count, the current step
 * marked and every return to implement as an amber edge labelled with its findings; below the runs in order with their
 * outcome and duration, and under them the step result and the conversation of the selected run (by default the latest
 * one that has either; the selection is stored per session, where `hunt-client factory` reads and sets it).
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
  const { pipeline, steps, transcripts, tokens } = record;
  const selectedN = useSessionViewStore((state) => state.views[sessionId]?.factoryRun ?? null);
  const updateView = useSessionViewStore((state) => state.updateView);
  const [flow, setFlow] = useState<{ nodes: StepFlowNode[]; edges: PipelineFlowEdge[] } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  /** Bumped when a layout lands so React Flow remounts and fits the graph into view. */
  const [layoutVersion, setLayoutVersion] = useState(0);
  const now = useClock(Boolean(pipeline?.currentRun));
  const [hover, setHover] = useState<PipelineFocus>(null);
  /** The step clicked in the graph, whose runs the list marks; it belongs to the session it was clicked in. */
  const [selection, setSelection] = useState<{ sessionId: string; step: SwfStep } | null>(null);
  const selectedStep = selection?.sessionId === sessionId ? selection.step : null;
  /** Shows the run `n` below the list; a clicked step would fade it, so its selection ends. */
  const showRun = useCallback(
    (n: number) => {
      setSelection(null);
      updateView(sessionId, { factoryRun: n });
    },
    [sessionId, updateView],
  );
  const focusContext = useMemo(
    () => ({ focus: hover ?? (selectedStep ? { stepId: selectedStep } : null), selectedStep, setHover, showRun }),
    [hover, selectedStep, showRun],
  );

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
  const openableNs = useMemo(() => openableRuns(steps, transcripts), [steps, transcripts]);
  const runningN = pipeline?.currentRun?.n ?? null;
  const shownN = shownRun(selectedN, openableNs, runningN);
  const links = pipelineLinks(repo, issue, pipeline?.pullRequest ?? null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Factory</span>
        {pipeline ? <span className="min-w-0 truncate text-[13px] text-neutral-400">{statusText(pipeline, graph?.lastTransition ?? null)}</span> : null}
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
        <PersistentGroup id="factory-panes" fillPane="details" orientation="vertical" className="flex min-h-0 flex-1 flex-col">
          <Panel id="graph" defaultSize={180} minSize={MIN_GRAPH_HEIGHT} className="relative min-h-0">
            <PlanUsageOverlay key={sessionId} sessionId={sessionId} pipeline={pipeline} isTurnRunning={isTurnRunning} />
            {layoutError ? <p className="absolute inset-x-3 top-3 z-10 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[13px] text-red-300">{layoutError}</p> : null}
            {flow ? (
              <ReactFlowProvider key={layoutVersion}>
                <PipelineFocusContext.Provider value={focusContext}>
                  <ReactFlow
                    nodes={flow.nodes}
                    edges={flow.edges}
                    nodeTypes={FACTORY_NODE_TYPES}
                    edgeTypes={FACTORY_EDGE_TYPES}
                    minZoom={0.2}
                    maxZoom={1.5}
                    colorMode="dark"
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    zIndexMode="manual"
                    proOptions={{ hideAttribution: true }}
                    onNodeMouseEnter={(_, node) => setHover({ stepId: node.id })}
                    onNodeMouseLeave={() => setHover(null)}
                    onEdgeMouseEnter={(_, edge) => setHover({ edgeId: edge.id })}
                    onEdgeMouseLeave={() => setHover(null)}
                    onEdgeClick={(_, edge) => edge.data?.cause !== undefined && showRun(edge.data.cause)}
                    onNodeClick={(_, node) => setSelection(selectedStep === node.data.id ? null : { sessionId, step: node.data.id })}
                    onPaneClick={() => setSelection(null)}
                  >
                    <Background gap={24} color="#2f343d" />
                    <FitViewOnResize nodes={flow.nodes} edges={flow.edges} />
                  </ReactFlow>
                </PipelineFocusContext.Provider>
              </ReactFlowProvider>
            ) : null}
          </Panel>
          <PaneSeparator orientation="vertical" />
          <Panel id="runs" defaultSize="25" minSize={MIN_RUNS_HEIGHT} className={`flex min-h-0 flex-col ${FACTORY_TEXT}`}>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {runs.length ? <HeaderRow /> : null}
              {runs.length ? (
                runs.map((run) => (
                  <RunRow
                    key={run.n}
                    run={run}
                    now={now}
                    model={modelText(pipeline.settings.steps[run.step])}
                    tokens={tokens.find((entry) => entry.n === run.n)}
                    isOpenable={openableNs.has(run.n) || run.n === runningN}
                    isSelected={run.n === shownN}
                    stepMark={selectedStep ? (run.step === selectedStep ? "marked" : "dimmed") : null}
                    onSelect={() => updateView(sessionId, { factoryRun: run.n })}
                  />
                ))
              ) : (
                <p className={HINT}>The record lists no runs yet.</p>
              )}
              {runs.length ? <TotalRow runCount={runs.length} tokens={tokens.length ? sumTokens(tokens) : null} duration={runs.reduce((sum, run) => sum + runDuration(run, now), 0)} /> : null}
            </div>
          </Panel>
          <PaneSeparator orientation="vertical" />
          <Panel id="details" minSize={MIN_DETAILS_HEIGHT} className="flex min-h-0 flex-col">
            {shownN !== null ? (
              <RunDetails
                key={`${sessionId}:${shownN}`}
                sessionId={sessionId}
                n={shownN}
                run={runs.find((run) => run.n === shownN) ?? null}
                stepCount={steps.length}
                transcripts={transcripts}
              />
            ) : (
              <p className={HINT}>No run has a step result or a conversation yet. A run with one opens it here.</p>
            )}
          </Panel>
        </PersistentGroup>
      ) : null}
    </div>
  );
}

/** How often the VM's running time is read again from the gateway while the tab is open. */
const VM_USAGE_REFRESH_MS = 5 * 60_000;

/**
 * The top left corner of the graph: the plan limits for the models the pipeline's runs used, as the session list shows
 * them, and below them the estimated cost of the session's VM. The plan limits are those of the Claude account the
 * session runs with on its VM (a poller session's is the poller's, not the one picked on this Mac), read there when the
 * tab opens, when the VM comes up and whenever a turn starts or ends; the last limits stay while the VM is off or the
 * read fails, with the reason in the tooltip. Nothing of them before the first agent run. The VM's cost is its running
 * time from the gateway (`vms.usage`), also while the VM is off, at the list price of its machine type, read at the same
 * moments and every five minutes.
 */
function PlanUsageOverlay({ sessionId, pipeline, isTurnRunning }: { sessionId: string; pipeline: Pipeline; isTurnRunning: boolean }) {
  const link = useHuntStore((state) => state.remoteLinks[sessionId]?.state ?? null);
  const isVmReachable = useHuntStore((state) => {
    const remoteLink = state.remoteLinks[sessionId];
    return remoteLink?.state !== "vmStopped" && !(remoteLink?.state === "locked" && remoteLink.reason === "unreachable");
  });
  const [windows, setWindows] = useState<UsageWindow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [cost, setCost] = useState<VmCost | null>(null);
  const [costNote, setCostNote] = useState<string | null>(null);
  const now = useMinuteClock();
  useLoad(
    () => commands.readSessionPlanUsage(sessionId),
    {
      onValue: (usage) => {
        if (usage?.windows.length) setWindows(usage.windows);
        setNote(usage?.retryAfterSeconds ? `Claude refuses usage reads for too many requests; retry in ${usage.retryAfterSeconds} s` : null);
      },
      onError: (reason) => setNote(`Reading the plan usage on the VM failed: ${errorText(reason)}`),
    },
    [sessionId, link, isTurnRunning],
    { isEnabled: isVmReachable },
  );
  useLoad(
    () => commands.readSessionVmUsage(sessionId),
    {
      onValue: (usage) => {
        setCost(usage ? vmCost(usage) : null);
        setCostNote(null);
      },
      onError: (reason) => setCostNote(`Reading the VM's running time from the gateway failed: ${errorText(reason)}`),
    },
    [sessionId, link, isTurnRunning, Math.floor(now / VM_USAGE_REFRESH_MS)],
  );
  const models = pipeline.runs.filter((run) => isAgentStep(run.step)).map((run) => pipeline.settings.steps[run.step].model);
  const shown = runModelWindows(windows, models);
  const hasPlanUsage = models.length > 0 && (shown.length > 0 || note !== null);
  if (!hasPlanUsage && !cost) return null;
  return (
    <div className="absolute top-3 left-3 z-10 flex w-72 flex-col gap-2 rounded-md border border-(--line) bg-black/50 px-3 py-2 backdrop-blur-md text-[13px] whitespace-nowrap text-neutral-500">
      {hasPlanUsage ? (
        <div title={note ?? undefined} className="flex gap-3">
          {shown.length ? <PlanUsageWindows windows={shown} now={now} /> : <span className="min-w-0 truncate">Plan usage unavailable</span>}
        </div>
      ) : null}
      {cost ? (
        <div title={costNote ? `${cost.title}\n${costNote}` : cost.title} className={`flex gap-1 leading-none ${hasPlanUsage ? "border-t border-(--line) pt-2" : ""}`}>
          <span className="min-w-0 truncate">VM</span>
          <span className="shrink-0 tabular-nums text-neutral-300">{cost.cost}</span>
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-neutral-600">{cost.duration}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line on where the pipeline stands, for the header: the step, the last transition, the returns of each step that
 * sent the issue back and whether a person reviews.
 */
function statusText(pipeline: Pipeline, lastTransition: Transition | null): string {
  const parts = [`At ${STEP_LABELS[pipeline.step]}`];
  if (lastTransition) {
    parts.push(lastTransition.source === lastTransition.target ? `last ${STEP_LABELS[lastTransition.target]} started over` : `last ${transitionText(lastTransition)}`);
  }
  for (const step of RETURNING_STEPS) {
    if (pipeline.returnsOf(step) > 0) {
      parts.push(`${pipeline.returnCountOf(step)} (${STEP_LABELS[step]})`);
    }
  }
  if (pipeline.step === "human-review") {
    parts.push("a person reviews");
  }
  return parts.join(" · ");
}

/** How a run row shows while a step is clicked in the graph: a run of that step is marked, any other one faded. */
const STEP_MARK: Record<"marked" | "dimmed", string> = {
  marked: "relative before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-white/70 before:content-['']",
  dimmed: "opacity-35",
};

/**
 * A run of the timeline: its number, step, outcome, the model and effort of its step, the tokens its conversation used so
 * far, start and duration (counting up while it runs); the running run and a
 * run with a step result or a transcript are a button that shows them below, the shown one is highlighted and scrolled into view.
 * `stepMark` marks or fades the row while a step is clicked in the graph.
 */
function RunRow({
  run,
  now,
  model,
  tokens,
  isOpenable,
  isSelected,
  stepMark,
  onSelect,
}: {
  run: Run;
  now: number;
  model: string | null;
  tokens: RunTokens | undefined;
  isOpenable: boolean;
  isSelected: boolean;
  stepMark: "marked" | "dimmed" | null;
  onSelect: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [isSelected]);
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
      <span className={COLUMNS}>
        <span className={`${MODEL_COLUMN} text-neutral-500`} title="Model and effort of the step's conversation">
          <span className="truncate">{model ?? ""}</span>
        </span>
        <TokensCells tokens={tokens ?? null} />
        <span className={`${DATE_COLUMN} text-neutral-400`} title={run.startedAt}>
          {startedText}
        </span>
        <span className={`${DURATION_COLUMN} text-neutral-400`}>{formatRunDuration(runDuration(run, now))}</span>
      </span>
    </>
  );
  const row = `flex min-h-7 w-full items-center gap-3 px-4 transition-opacity ${isSelected ? "bg-(--row-selected)" : ""} ${stepMark ? STEP_MARK[stepMark] : ""}`;
  if (!isOpenable) return <div className={`${row} ${run.outcome === "running" || stepMark === "dimmed" ? "" : "opacity-80"}`}>{content}</div>;
  return (
    <button ref={rowRef} type="button" onClick={onSelect} className={`${row} rounded text-left hover:bg-(--row-hover)`} title="Show the step result and the conversation of this run">
      {content}
    </button>
  );
}

/**
 * The right-hand columns the header, the run rows and the total row share, so that their values line up: one cluster
 * whose cells a faint line parts, each padded alike and right-aligned (`justify-center` centers one).
 */
const COLUMNS = "flex shrink-0 self-stretch divide-x divide-(--line) border-l border-(--line)";
const CELL = "flex shrink-0 items-center justify-end px-4 whitespace-nowrap tabular-nums";
const MODEL_COLUMN = `w-40 ${CELL}`;
const TOKENS_COLUMN = `w-32 ${CELL}`;
const UNCACHED_COLUMN = `w-32 ${CELL}`;
const DATE_COLUMN = `w-40 ${CELL}`;
const DURATION_COLUMN = `w-20 ${CELL}`;

/**
 * Two columns of token counts, the total and the uncached ones (input, cache writes and output, the tokens paid in
 * full), each with the kinds in the tooltip; empty without counts. `centered` centers the counts, for the total row.
 */
function TokensCells({ tokens, className = "text-neutral-400", centered = false }: { tokens: TokenCounts | null; className?: string; centered?: boolean }) {
  const align = centered ? "justify-center" : "";
  const title = tokens ? tokensTitle(tokens) : undefined;
  return (
    <>
      <span className={`${TOKENS_COLUMN} ${align} ${className}`} title={title}>
        {tokens ? `${formatTokens(totalTokens(tokens))} tokens` : ""}
      </span>
      <span className={`${UNCACHED_COLUMN} ${align} ${className}`} title={title}>
        {tokens ? `${formatTokens(uncachedTokens(tokens))} uncached` : ""}
      </span>
    </>
  );
}

/** The first row of the run list, pinned to the top while the runs scroll: the title of each column. */
function HeaderRow() {
  return (
    <div className="sticky top-0 z-10 flex min-h-8 shrink-0 items-center gap-3 border-b border-(--line) bg-(--factory-bg) px-4 py-1.5 font-medium text-neutral-500">
      <span className="w-7 shrink-0 text-right">#</span>
      <span className="w-28 shrink-0">Step</span>
      <span>Outcome</span>
      <span className="flex-1" />
      <span className={COLUMNS}>
        <span className={MODEL_COLUMN}>Model</span>
        <span className={TOKENS_COLUMN}>Tokens</span>
        <span className={UNCACHED_COLUMN}>Uncached</span>
        <span className={DATE_COLUMN}>Started</span>
        <span className={DURATION_COLUMN}>Duration</span>
      </span>
    </div>
  );
}

/** The last row of the run list, pinned to the bottom while the runs scroll: how many runs there were, the tokens they used and how long they took, all summed up. */
function TotalRow({ runCount, tokens, duration }: { runCount: number; tokens: TokenCounts | null; duration: number }) {
  return (
    <div className="sticky bottom-0 z-10 flex min-h-8 shrink-0 items-center gap-3 border-t border-(--line) bg-(--factory-bg) px-4 py-1.5 font-medium">
      <span className="w-7 shrink-0" />
      <span className="w-28 shrink-0 text-neutral-100">Total</span>
      <span className="text-neutral-400">
        {runCount} {runCount === 1 ? "run" : "runs"}
      </span>
      <span className="flex-1" />
      <span className={COLUMNS}>
        <span className={MODEL_COLUMN} />
        <TokensCells tokens={tokens} className="text-neutral-100" centered />
        <span className={DATE_COLUMN} />
        <span className={`${DURATION_COLUMN} justify-center text-neutral-100`}>{formatRunDuration(duration)}</span>
      </span>
    </div>
  );
}

/** Heading of the two parts of a run's details, Result and Conversation: a ruled line that sets them apart from the result's own headings. */
/** Type of the run list and the step result, as the Factory page of the settings sets it. */
const FACTORY_TEXT = "font-(family-name:--factory-font-family) text-(length:--factory-font-size)";

const SECTION_HEADING = "border-b border-(--line) pb-1.5 text-[18px] leading-snug font-semibold text-neutral-100";



/** The run `n`: the step result it ended with, as the agent wrote it, rendered like the chat's markdown, and its conversation. */
function RunDetails({ sessionId, n, run, stepCount, transcripts }: { sessionId: string; n: number; run: Run | null; stepCount: number; transcripts: SwfStepFile[] }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // The count of step files changes when a result is added or replaced; the shown one is read again then.
  useLoad(() => commands.readSwfStep(sessionId, n), { onValue: setText, onError: (reason) => setError(errorText(reason)) }, [sessionId, n, stepCount]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* A line length that stays readable on a wide panel. */}
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-6 py-5 text-[13px]">
        {run ? (
          <div className="text-neutral-400">
            Run {run.n}, <span className="text-neutral-200">{STEP_LABELS[run.step]}</span>
          </div>
        ) : null}
        <section className={`flex flex-col gap-3 ${FACTORY_TEXT} leading-(--factory-line-height)`}>
          <h2 className={SECTION_HEADING}>Result</h2>
          {error ? (
            <p className="leading-snug break-words text-red-300">{error}</p>
          ) : text === null ? (
            <p className="text-neutral-500">{run?.outcome === "running" ? "The run has not reported a step result yet." : `Run ${n} has no step result.`}</p>
          ) : text === undefined ? null : text.trim() ? (
            <MarkdownText text={text} className="markdown-document" />
          ) : (
            <p className="text-neutral-500 italic">The step result is empty.</p>
          )}
        </section>
        <RunConversationSection sessionId={sessionId} n={n} transcripts={transcripts} />
      </div>
    </div>
  );
}

/**
 * The conversation of the run `n` as its transcript records it (`.hunt/swf/transcripts/<nn>-<step>.jsonl`): prompts,
 * thoughts, replies and tool calls in the chat's rows; nothing while the run has no transcript.
 */
function RunConversationSection({ sessionId, n, transcripts }: { sessionId: string; n: number; transcripts: SwfStepFile[] }) {
  const [conversation, setConversation] = useState<RunConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every read of the pipeline gives a new list; the transcript of a running run may have grown with it.
  useLoad(
    () => commands.readSwfTranscript(sessionId, n),
    { onValue: (jsonl) => setConversation(jsonl === null ? null : runConversation(jsonl)), onError: (reason) => setError(errorText(reason)) },
    [sessionId, n, transcripts],
  );
  if (error) return <p className="leading-snug break-words text-red-300">{error}</p>;
  if (!conversation) return null;
  return (
    // `chat` gives the conversation the chat pane's type and its Markdown rules, so its rows read as they do there.
    <section className="chat mt-8 flex flex-col gap-3">
      <h2 className={SECTION_HEADING}>Conversation</h2>
      {conversation.items.length > 0 ? (
        <MessageList items={conversation.items} plan={[]} isBusy={false} isVerbose={false} basePath={conversation.cwd} />
      ) : (
        <p className="text-neutral-500 italic">The transcript holds no messages yet.</p>
      )}
    </section>
  );
}

/**
 * Fits the whole graph, the returns arcing above the steps included, into view once it is measured and again whenever
 * its pane changes size.
 */
function FitViewOnResize({ nodes, edges }: { nodes: StepFlowNode[]; edges: PipelineFlowEdge[] }) {
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { setViewport } = useReactFlow();
  const bounds: Rect = useMemo(() => pipelineBounds(nodes, edges), [nodes, edges]);
  useEffect(() => {
    if (width && height) void setViewport(getViewportForBounds(bounds, width, height, FIT_VIEW_OPTIONS.minZoom, FIT_VIEW_OPTIONS.maxZoom, FIT_VIEW_OPTIONS.padding));
  }, [width, height, bounds, setViewport]);
  return null;
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
