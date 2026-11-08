import { describe, expect, it } from "vitest";
import { pipelineBounds, type PipelineFlowEdge, type StepFlowNode } from "./pipeline-layout.utils";

function step(id: "plan" | "implement", x: number): StepFlowNode {
  return {
    id,
    type: "step",
    position: { x, y: 100 },
    width: 132,
    height: 52,
    data: { id, label: id, runs: [], repeats: 0, isCurrent: false, isRunning: false, outcome: null },
  };
}

describe("pipelineBounds", () => {
  it("spans the steps alone when no edge leaves them", () => {
    expect(pipelineBounds([step("plan", 0), step("implement", 200)], [])).toEqual({ x: 0, y: 100, width: 332, height: 52 });
  });

  it("reaches up to the routes and labels of the returns arcing above the steps", () => {
    const label = "#1 · 14 findings";
    const edge: PipelineFlowEdge = {
      id: "return:4->5",
      type: "pipeline",
      source: "plan",
      target: "implement",
      data: { kind: "return", label, isLast: false, points: [{ x: 66, y: 100 }, { x: 66, y: 20 }, { x: 266, y: 20 }, { x: 266, y: 100 }], labelCenter: { x: 166, y: 40 } },
    };
    expect(pipelineBounds([step("plan", 0), step("implement", 200)], [edge])).toEqual({ x: 0, y: 20, width: 332, height: 132 });
  });
});
