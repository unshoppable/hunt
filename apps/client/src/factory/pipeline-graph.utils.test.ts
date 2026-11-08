import { describe, expect, it } from "vitest";
import type { Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { SWF_STEPS } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import {
  edgeEmphasis,
  formatRunDuration,
  pipelineGraph,
  pipelineLayoutInput,
  pipelineLinks,
  returnEdgeTitle,
  runDuration,
  transitionText,
  type ReturnEdge,
} from "./pipeline-graph.utils";

function run(n: number, step: Run["step"], outcome: Run["outcome"], extra: Partial<Run> = {}): Run {
  const startedAt = `2026-10-31T10:${String(n).padStart(2, "0")}:00.000Z`;
  return { n, step, startedAt, endedAt: outcome === "running" ? null : `2026-10-31T10:${String(n).padStart(2, "0")}:30.000Z`, outcome, ...extra };
}

/** plan passed, implement passed, verify returned 2 findings, implement (caused by 3) passed, verify runs. */
const RETURNED_ONCE: Run[] = [
  run(1, "plan", "passed"),
  run(2, "implement", "passed"),
  run(3, "verify", "returned", { findings: 2 }),
  run(4, "implement", "passed", { cause: 3 }),
  run(5, "verify", "running"),
];

describe("pipelineGraph", () => {
  it("draws every step of the baseline in order, with its runs and the current one marked", () => {
    const { nodes } = pipelineGraph({ step: "verify", runs: RETURNED_ONCE });
    expect(nodes.map((node) => node.id)).toEqual([...SWF_STEPS]);
    expect(nodes.map((node) => node.runs.length)).toEqual([1, 2, 2, 0, 0, 0, 0]);
    expect(nodes.map((node) => node.repeats)).toEqual([0, 1, 1, 0, 0, 0, 0]);
    expect(nodes.find((node) => node.id === "verify")).toMatchObject({ label: "Verify", isCurrent: true, isRunning: true, outcome: null });
    expect(nodes.find((node) => node.id === "implement")).toMatchObject({ isCurrent: false, isRunning: false, outcome: "passed" });
    expect(nodes.find((node) => node.id === "merge")).toMatchObject({ isCurrent: false, isRunning: false, outcome: null, runs: [] });
  });

  it("connects the steps along the baseline and adds a labelled return edge per implement run a returned run caused", () => {
    const { edges } = pipelineGraph({ step: "verify", runs: RETURNED_ONCE });
    const flow = edges.filter((edge) => edge.kind === "flow");
    expect(flow.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      "plan->implement",
      "implement->verify",
      "verify->review",
      "review->pr",
      "pr->human-review",
      "human-review->merge",
    ]);
    const returns = edges.filter((edge): edge is ReturnEdge => edge.kind === "return");
    expect(returns).toEqual([{ id: "return:3->4", kind: "return", source: "verify", target: "implement", cause: 3, n: 4, index: 1, findings: 2, label: "#1 · 2 findings" }]);
  });

  it("numbers the returns in their order, words one finding in the singular and counts a return without findings as none", () => {
    const runs = [run(1, "review", "returned", { findings: 1 }), run(2, "implement", "running", { cause: 1 }), run(3, "merge", "returned"), run(4, "implement", "running", { cause: 3 })];
    const labels = pipelineGraph({ step: "implement", runs }).edges.filter((edge) => edge.kind === "return").map((edge) => edge.label);
    expect(labels).toEqual(["#1 · 1 finding", "#2 · 0 findings"]);
  });

  it("draws no return edge for a cause that names no run, and a plain graph for a record without runs", () => {
    expect(pipelineGraph({ step: "implement", runs: [run(1, "implement", "running", { cause: 9 })] }).edges.filter((edge) => edge.kind === "return")).toEqual([]);
    const { nodes, edges } = pipelineGraph({ step: "plan", runs: [] });
    expect(nodes.every((node) => node.runs.length === 0 && !node.isRunning && node.outcome === null)).toBe(true);
    expect(nodes.filter((node) => node.isCurrent).map((node) => node.id)).toEqual(["plan"]);
    expect(edges).toHaveLength(SWF_STEPS.length - 1);
  });

  it("marks the baseline edge of the last transition", () => {
    const graph = pipelineGraph({ step: "verify", runs: RETURNED_ONCE });
    expect(graph.lastTransition).toEqual({ source: "implement", target: "verify", n: 5 });
    expect(graph.lastEdgeId).toBe("flow:implement->verify");
    expect(transitionText(graph.lastTransition!)).toBe("Implement → Verify");
  });

  it("marks the return edge when the last run went back to implement", () => {
    const graph = pipelineGraph({ step: "implement", runs: RETURNED_ONCE.slice(0, 4) });
    expect(graph.lastTransition).toEqual({ source: "verify", target: "implement", n: 4 });
    expect(graph.lastEdgeId).toBe("return:3->4");
  });

  it("adds a jump edge for a last transition that no edge connects, and marks none for a step that started over", () => {
    const withdrawn = [run(1, "human-review", "passed"), run(2, "merge", "passed"), run(3, "human-review", "running")];
    const graph = pipelineGraph({ step: "human-review", runs: withdrawn });
    expect(graph.lastEdgeId).toBe("jump:merge->human-review");
    expect(graph.edges.filter((edge) => edge.kind === "jump")).toEqual([{ id: "jump:merge->human-review", kind: "jump", source: "merge", target: "human-review" }]);
    const restarted = pipelineGraph({ step: "implement", runs: [run(1, "implement", "restarted"), run(2, "implement", "running")] });
    expect(restarted.lastTransition).toEqual({ source: "implement", target: "implement", n: 2 });
    expect(restarted.lastEdgeId).toBeNull();
    expect(restarted.edges.some((edge) => edge.kind === "jump")).toBe(false);
  });

  it("has no last transition before the second run", () => {
    const graph = pipelineGraph({ step: "plan", runs: [run(1, "plan", "running")] });
    expect(graph.lastTransition).toBeNull();
    expect(graph.lastEdgeId).toBeNull();
  });
});

describe("pipelineLayoutInput", () => {
  it("lays the steps out left to right, sized alike, the baseline kept forward between their sides and the returns labelled between their tops", () => {
    const input = pipelineLayoutInput(pipelineGraph({ step: "verify", runs: RETURNED_ONCE }));
    expect(input.direction).toBe("RIGHT");
    expect(input.groups).toEqual([]);
    expect(input.nodes.map((node) => node.id)).toEqual([...SWF_STEPS]);
    expect(new Set(input.nodes.map((node) => `${node.width}x${node.height}`)).size).toBe(1);
    expect(input.nodes[0].ports?.map((port) => port.id)).toEqual(["plan:in", "plan:out", "plan:top"]);
    expect(input.edges.find((edge) => edge.id === "flow:plan->implement")).toEqual({ id: "flow:plan->implement", source: "plan:out", target: "implement:in", priority: 10 });
    expect(input.edges.find((edge) => edge.id === "return:3->4")).toEqual({ id: "return:3->4", source: "verify:top", target: "implement:top", label: "#1 · 2 findings" });
  });

  it("routes a jump edge between the tops of its steps, without a label", () => {
    const input = pipelineLayoutInput(pipelineGraph({ step: "human-review", runs: [run(1, "review", "passed"), run(2, "human-review", "running")] }));
    expect(input.edges.find((edge) => edge.id === "jump:review->human-review")).toEqual({ id: "jump:review->human-review", source: "review:top", target: "human-review:top" });
  });
});

describe("runDuration", () => {
  const now = Date.parse("2026-10-31T10:05:45.000Z");

  it("measures an ended run between its times and a running one up to now", () => {
    expect(runDuration(run(1, "plan", "passed"), now)).toBe(30_000);
    expect(runDuration(run(5, "verify", "running"), now)).toBe(45_000);
  });

  it("is zero for times that do not parse", () => {
    expect(runDuration({ ...run(1, "plan", "passed"), startedAt: "yesterday" }, now)).toBe(0);
  });
});

describe("formatRunDuration", () => {
  it("shows seconds, whole minutes, then hours and minutes", () => {
    expect(formatRunDuration(0)).toBe("0s");
    expect(formatRunDuration(45_500)).toBe("45s");
    expect(formatRunDuration(12 * 60_000 + 59_000)).toBe("12m");
    expect(formatRunDuration(65 * 60_000)).toBe("1h 05m");
  });
});

describe("pipelineLinks", () => {
  it("links the issue and the pull request of the repository, and nothing without a repository", () => {
    expect(pipelineLinks("acme/app", 123, 456)).toEqual([
      { label: "Issue #123", url: "https://github.com/acme/app/issues/123" },
      { label: "PR #456", url: "https://github.com/acme/app/pull/456" },
    ]);
    expect(pipelineLinks("acme/app", 123, null)).toEqual([{ label: "Issue #123", url: "https://github.com/acme/app/issues/123" }]);
    expect(pipelineLinks(null, 123, 456)).toEqual([]);
  });
});

describe("edgeEmphasis", () => {
  const edge = { id: "return:3->4", source: "verify", target: "implement" };

  it("leaves every edge as it is while nothing is focused", () => {
    expect(edgeEmphasis(null, edge)).toBeNull();
  });

  it("highlights the focused edge and dims the others", () => {
    expect(edgeEmphasis({ edgeId: "return:3->4" }, edge)).toBe("highlighted");
    expect(edgeEmphasis({ edgeId: "flow:plan->implement" }, edge)).toBe("dimmed");
  });

  it("highlights every edge that leaves or enters a focused step", () => {
    expect(edgeEmphasis({ stepId: "verify" }, edge)).toBe("highlighted");
    expect(edgeEmphasis({ stepId: "implement" }, edge)).toBe("highlighted");
    expect(edgeEmphasis({ stepId: "review" }, edge)).toBe("dimmed");
  });
});

describe("returnEdgeTitle", () => {
  it("names the run that returned the issue, its findings and the run that took them on", () => {
    const returned = pipelineGraph({ step: "verify", runs: RETURNED_ONCE }).edges.find((edge): edge is ReturnEdge => edge.kind === "return");
    expect(returned && returnEdgeTitle(returned)).toBe("Return #1: run 3 (Verify) sent the issue back to Implement with 2 findings; run 4 took them on");
  });
});
