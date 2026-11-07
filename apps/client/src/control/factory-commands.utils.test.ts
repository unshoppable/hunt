import { describe, expect, it } from "vitest";
import type { Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { EMPTY_PIPELINE } from "../sessions/swf-pipeline.store";
import { factoryState, type PipelineSummary } from "./factory-commands.utils";

const RUNS: Run[] = [
  { n: 1, step: "plan", startedAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:05:00Z", outcome: "passed" },
  { n: 2, step: "implement", startedAt: "2026-11-01T10:05:00Z", endedAt: "2026-11-01T10:30:00Z", outcome: "passed" },
  { n: 3, step: "verify", startedAt: "2026-11-01T10:30:00Z", endedAt: "2026-11-01T10:40:00Z", outcome: "returned", findings: 2 },
  { n: 4, step: "implement", startedAt: "2026-11-01T10:40:00Z", endedAt: null, outcome: "running", cause: 3 },
];

const PIPELINE: PipelineSummary = {
  repo: "unshoppable/hunt",
  issue: 7,
  branch: "feat/general/issue-7",
  step: "implement",
  returns: { verify: 1 },
  pullRequest: null,
  runs: RUNS,
  currentRun: RUNS[3],
};

const RECORD = {
  ...EMPTY_PIPELINE,
  steps: [
    { n: 1, step: "plan" },
    { n: 3, step: "verify" },
  ],
  transcripts: [
    { n: 1, step: "plan" },
    { n: 2, step: "implement" },
    { n: 3, step: "verify" },
    { n: 4, step: "implement" },
  ],
  isLoaded: true,
};

describe("factoryState", () => {
  it("summarizes the pipeline, its runs and the run shown", () => {
    expect(factoryState(RECORD, PIPELINE, { repo: "unshoppable/hunt", number: 7 }, 3)).toEqual({
      issue: { repo: "unshoppable/hunt", number: 7, branch: "feat/general/issue-7" },
      step: "implement",
      returns: { verify: 1 },
      pullRequest: null,
      runs: [
        { n: 1, step: "plan", outcome: "passed", hasResult: true, hasTranscript: true },
        { n: 2, step: "implement", outcome: "passed", hasResult: false, hasTranscript: true },
        { n: 3, step: "verify", outcome: "returned", findings: 2, hasResult: true, hasTranscript: true },
        { n: 4, step: "implement", outcome: "running", hasResult: false, hasTranscript: true },
      ],
      currentRun: 4,
      selectedRun: 3,
      shownRun: 3,
      isLoaded: true,
      error: null,
    });
  });

  it("shows the latest run that can be opened without a selection", () => {
    expect(factoryState(RECORD, PIPELINE, null, null).shownRun).toBe(4);
  });

  it("names the claimed issue while the pipeline wrote no record", () => {
    expect(factoryState({ ...EMPTY_PIPELINE, isLoaded: true }, null, { repo: "unshoppable/hunt", number: 7 }, null)).toEqual({
      issue: { repo: "unshoppable/hunt", number: 7, branch: "" },
      step: null,
      returns: {},
      pullRequest: null,
      runs: [],
      currentRun: null,
      selectedRun: null,
      shownRun: null,
      isLoaded: true,
      error: null,
    });
  });
});
