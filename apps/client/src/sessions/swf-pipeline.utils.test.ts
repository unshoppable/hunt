import { describe, expect, it } from "vitest";
import type { Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { pipelineAgentState } from "./swf-pipeline.utils";

function run(n: number, step: Run["step"], outcome: Run["outcome"]): Run {
  return { n, step, startedAt: "2026-10-31T10:00:00.000Z", endedAt: outcome === "running" ? null : "2026-10-31T10:00:30.000Z", outcome };
}

describe("pipelineAgentState", () => {
  it("names the running run's step, else failed, done after a passed merge, or the current step", () => {
    expect(pipelineAgentState({ step: "verify", runs: [run(1, "plan", "passed"), run(2, "verify", "running")] })).toBe("verify");
    expect(pipelineAgentState({ step: "implement", runs: [run(1, "plan", "passed"), run(2, "implement", "failed")] })).toBe("failed");
    expect(pipelineAgentState({ step: "merge", runs: [run(1, "merge", "passed")] })).toBe("done");
    expect(pipelineAgentState({ step: "merge", runs: [run(1, "human-review", "passed")] })).toBe("merge");
    expect(pipelineAgentState({ step: "human-review", runs: [] })).toBe("human-review");
  });
});
