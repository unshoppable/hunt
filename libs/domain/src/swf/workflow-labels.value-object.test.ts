import { describe, expect, it } from "vitest";
import { WorkflowLabels } from "./workflow-labels.value-object.ts";

describe("WorkflowLabels", () => {
  const labels = WorkflowLabels.of("swf");

  it("derives the labels of the workflow from the configured label, one per step", () => {
    expect([labels.requested, labels.question, labels.done, labels.failed]).toEqual(["swf", "swf:question", "swf:done", "swf:failed"]);
    expect(labels.step("plan")).toBe("swf:plan");
    expect(labels.step("pr-gate")).toBe("swf:pr-gate");
    expect(labels.stepOf("swf:merge")).toBe("merge");
    expect(labels.stepOf("swf:pr-gate")).toBe("pr-gate");
    expect(labels.stepOf("swf:question")).toBeNull();
    expect(labels.stepOf("swf:running")).toBeNull();
    expect(labels.stepOf("swf")).toBeNull();
    expect(labels.stepOf("other:plan")).toBeNull();
  });

  it("reads the labels of the retired steps checks and human-review, which an issue of an earlier release may carry, as pr-gate", () => {
    for (const label of ["swf:checks", "swf:human-review"]) {
      expect(labels.stepOf(label), label).toBe("pr-gate");
      expect(labels.agentStateOf({ state: "open", labels: [label] }), label).toBe("pr-gate");
      expect(labels.carriedBy({ labels: ["bug", label] }), label).toEqual([label]);
    }
  });

  it("rejects a label with a colon or whitespace", () => {
    expect(() => WorkflowLabels.of("swf:plan")).toThrow(/no colon/);
    expect(() => WorkflowLabels.of("s wf")).toThrow(/no colon/);
    expect(() => WorkflowLabels.of("")).toThrow(/no colon/);
  });

  it("creates a label per step and the question, done and failed labels, the PR gate in red", () => {
    const specs = labels.specs();
    expect(specs.map((spec) => spec.name)).toEqual([
      "swf:plan",
      "swf:implement",
      "swf:verify",
      "swf:review",
      "swf:pr",
      "swf:pr-gate",
      "swf:merge",
      "swf:question",
      "swf:done",
      "swf:failed",
    ]);
    expect(specs.find((spec) => spec.name === "swf:pr-gate")).toEqual({
      name: "swf:pr-gate",
      color: "e99695",
      description: "The pull request waits for its checks and an approval",
    });
    expect(specs.find((spec) => spec.name === "swf:review")).toEqual({ name: "swf:review", color: "fbca04", description: "Hunt's agent reviews the change by the repository's review criteria" });
    expect(specs.every((spec) => /^[0-9a-f]{6}$/.test(spec.color) && spec.description !== "")).toBe(true);
  });

  it("reads the agent state off the labels, the outcomes before the step, a closed or deleted issue as done", () => {
    expect(labels.agentStateOf({ state: "open", labels: ["bug", "swf:implement"] })).toBe("implement");
    expect(labels.agentStateOf({ state: "open", labels: ["swf:pr-gate"] })).toBe("pr-gate");
    expect(labels.agentStateOf({ state: "open", labels: ["swf:verify", "swf:question"] })).toBe("question");
    expect(labels.agentStateOf({ state: "open", labels: ["swf:merge", "swf:done"] })).toBe("done");
    expect(labels.agentStateOf({ state: "open", labels: ["swf:review", "swf:failed"] })).toBe("failed");
    expect(labels.agentStateOf({ state: "open", labels: ["swf:gate"] })).toBeNull();
    expect(labels.agentStateOf({ state: "closed", labels: ["swf:plan"] })).toBe("done");
    expect(labels.agentStateOf(null)).toBe("done");
    expect(labels.agentStateOf({ state: "open", labels: ["bug", "swf", "swf:running"] })).toBeNull();
  });

  it("lists the labels of the workflow an issue carries", () => {
    expect(labels.carriedBy({ labels: ["bug", "swf", "swf:plan", "swf:question", "other:done"] })).toEqual(["swf:plan", "swf:question"]);
  });

  it("names the labels of an issue in progress: the steps, the retired ones and the question, not the request or the outcomes", () => {
    expect(labels.inProgress).toEqual(["swf:plan", "swf:implement", "swf:verify", "swf:review", "swf:pr", "swf:pr-gate", "swf:merge", "swf:checks", "swf:human-review", "swf:question"]);
  });
});
