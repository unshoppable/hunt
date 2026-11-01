import type { Pipeline } from "../../../../libs/domain/src/swf/pipeline.domain.ts";

/** The part of the pipeline's record (`libs/domain/src/swf/pipeline.domain.ts`) the sidebar and the Factory tab read. */
export type PipelineRecord = Pick<Pipeline, "step" | "runs">;

/**
 * The state of the pipeline's agent as the gateway words it (`RemoteTarget.agent`): the step of the running run, `failed`
 * once a run failed, `done` once the merge run passed, else the current step (between two runs, or a record written
 * before Hunt kept runs).
 */
export function pipelineAgentState(record: PipelineRecord): string {
  const last = record.runs[record.runs.length - 1];
  if (!last) return record.step;
  if (last.outcome === "running") return last.step;
  if (last.outcome === "failed") return "failed";
  if (last.step === "merge" && last.outcome === "passed") return "done";
  return record.step;
}
