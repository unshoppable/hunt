import type { Pipeline, RunOutcome } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import type { ReturningStep } from "../../../../libs/domain/src/swf/step-settings.value-object.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { openableRuns, shownRun } from "../factory/factory-runs.utils";
import type { SessionPipeline } from "../sessions/swf-pipeline.store";

/** A run of the pipeline as `hunt-client factory` prints it: its findings when it sent the issue back, whether it has a step result or a transcript to open. */
export type FactoryRunState = { n: number; step: SwfStep; outcome: RunOutcome; findings?: number; hasResult: boolean; hasTranscript: boolean };

/**
 * The Factory tab as `hunt-client factory` prints it: the issue (`<owner>/<repo>`, number, branch), the step it stands
 * at, the returns of each step that sent it back, the pull request, the runs in order, the running run, the run picked
 * (`selectedRun`, null for the tab's own choice) and the one shown; `step` and `runs` are empty while the pipeline wrote
 * no record, `error` says why the record could not be read.
 */
export type FactoryState = {
  issue: { repo: string; number: number; branch: string } | null;
  step: SwfStep | null;
  returns: Partial<Record<ReturningStep, number>>;
  pullRequest: number | null;
  runs: FactoryRunState[];
  currentRun: number | null;
  selectedRun: number | null;
  shownRun: number | null;
  isLoaded: boolean;
  error: string | null;
};

/** The fields of a pipeline the state reads. */
export type PipelineSummary = Pick<Pipeline, "repo" | "issue" | "branch" | "step" | "returns" | "pullRequest" | "runs" | "currentRun">;

/**
 * The state of the Factory tab reading `record`, whose pipeline is `pipeline`, with the run `selected` picked; `fallbackIssue`
 * is the issue the session was claimed for, which names it while the pipeline wrote no record.
 */
export function factoryState(
  record: Omit<SessionPipeline, "pipeline">,
  pipeline: PipelineSummary | null,
  fallbackIssue: { repo: string; number: number } | null,
  selected: number | null,
): FactoryState {
  const results = new Set(record.steps.map((file) => file.n));
  const transcripts = new Set(record.transcripts.map((file) => file.n));
  const runs = (pipeline?.runs ?? []).map(
    (run): FactoryRunState => ({
      n: run.n,
      step: run.step,
      outcome: run.outcome,
      ...(run.outcome === "returned" && run.findings !== undefined ? { findings: run.findings } : {}),
      hasResult: results.has(run.n),
      hasTranscript: transcripts.has(run.n),
    }),
  );
  return {
    issue: pipeline ? { repo: pipeline.repo, number: pipeline.issue, branch: pipeline.branch } : fallbackIssue ? { ...fallbackIssue, branch: "" } : null,
    step: pipeline?.step ?? null,
    returns: pipeline?.returns ?? {},
    pullRequest: pipeline?.pullRequest ?? null,
    runs,
    currentRun: pipeline?.currentRun?.n ?? null,
    selectedRun: selected,
    shownRun: shownRun(selected, openableRuns(record.steps, record.transcripts)),
    isLoaded: record.isLoaded,
    error: record.error,
  };
}
