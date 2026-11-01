import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import type { ParsedStepResult, StepResult } from "./step-result.utils.ts";
import { AGENT_STEPS, POLLER_STEPS, type SwfStep } from "./swf-step.types.ts";
import { MAX_ATTEMPTS, Pipeline, RECORD_VERSION, stepSkills, type PullRequestReview, type Run } from "./pipeline.domain.ts";
import { ISSUE, SKILLS, started } from "./swf.fixtures.ts";
import { UnusableStepResult } from "./unusable-step-result.error.ts";

/** The poller's clock in the tests: 2026-10-25 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
/** The record's `skills` of SKILLS, as the record comment spells it. */
const SKILLS_JSON = '"skills":{"plan":"swf-plan","implement":"swf-implement","verify":"swf-verify","review":"swf-review","pr":"swf-pr"}';
/** The fields a record written by hand lacks, at their start values. */
const BARE = { repo: "", issue: 0, branch: "" };

/** A fresh pipeline at `step`, apart from `fields`. */
function pipelineAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...started(NOW).toJSON(), step, runs: [runOf(1, step)], ...fields });
}

/** A run of `step` that started at NOW and still runs, apart from `fields`. */
function runOf(n: number, step: SwfStep, fields: Partial<Run> = {}): Run {
  return { n, step, startedAt: new Date(NOW).toISOString(), endedAt: null, outcome: "running", ...fields };
}

/** `result` as `parseStepResult` reports a usable one. */
function reported(result: StepResult): ParsedStepResult {
  return { result };
}

/** The pipeline of the record comment `body`; undefined when the comment holds none. */
function recordOf(body: string): Pipeline | undefined {
  return Pipeline.fromComment(body)?.pipeline;
}

function review(id: number, author: string, state: string, body = ""): PullRequestReview {
  return { id, author, state, body, submittedAt: `2026-10-25T10:0${id}:00Z` };
}

describe("Pipeline.start", () => {
  it("starts at plan with nothing sent or acted on, of the current record version, with the issue and the skill of every agent step", () => {
    expect(RECORD_VERSION).toBe(3);
    expect(Pipeline.start(ISSUE, { ...SKILLS, plan: "acme-plan" }, NOW).toJSON()).toEqual({
      version: 3,
      repo: "acme/app",
      issue: 12,
      branch: "feat/general/12-issue-12",
      recordId: 0,
      step: "plan",
      attempt: 0,
      pullRequest: null,
      skills: { plan: "acme-plan", implement: "swf-implement", verify: "swf-verify", review: "swf-review", pr: "swf-pr" },
      findings: [],
      escalate: false,
      promptTurn: null,
      reminded: false,
      lastResultId: 0,
      handledReview: null,
      mergeSha: null,
      notified: false,
      inReview: false,
      runs: [{ n: 1, step: "plan", startedAt: "2026-10-25T10:00:00.000Z", endedAt: null, outcome: "running" }],
    });
    const unordered = { pr: "a-pr", plan: "a-plan", implement: "a-implement", verify: "a-verify", review: "a-review" };
    expect(Object.keys(started(NOW, unordered).skills)).toEqual([...AGENT_STEPS]);
    expect(() => started(NOW, { ...SKILLS, pr: "" })).toThrow();
  });
});

describe("the record comment", () => {
  it("holds the status line and the record with its keys in their order, and survives the round trip", () => {
    const fields = { attempt: 2, findings: ["Verify: a"], pullRequest: 42, promptTurn: 1760000000000 };
    const pipeline = new Pipeline({ ...started(NOW, { ...SKILLS, review: "acme-review" }).toJSON(), step: "implement", runs: [runOf(1, "implement")], ...fields });
    const body = pipeline.toComment();
    expect(body).toBe(
      "**Hunt:** step `implement` · attempt 2 of 5 · pull request #42\n\n" +
        '<!-- hunt:pipeline {"version":3,"repo":"acme/app","issue":12,"branch":"feat/general/12-issue-12","recordId":0,' +
        '"step":"implement","attempt":2,"pullRequest":42,' +
        '"skills":{"plan":"swf-plan","implement":"swf-implement","verify":"swf-verify","review":"acme-review","pr":"swf-pr"},' +
        '"findings":["Verify: a"],"escalate":false,"promptTurn":1760000000000,"reminded":false,' +
        '"lastResultId":0,"handledReview":null,"mergeSha":null,"notified":false,"inReview":false,' +
        '"runs":[{"n":1,"step":"implement","startedAt":"2026-10-25T10:00:00.000Z","endedAt":null,"outcome":"running"}]} -->\n',
    );
    expect(body.startsWith(pipeline.statusLine)).toBe(true);
    expect(Pipeline.fromComment(body)).toEqual({ pipeline });
    expect(recordOf(body)?.toComment()).toBe(body);
  });

  it("says in the status line that a person reviews only at human-review and leaves out what is not there yet", () => {
    expect(started(NOW).statusLine).toBe("**Hunt:** step `plan`");
    expect(pipelineAt("checks", { pullRequest: 31 }).statusLine).toBe("**Hunt:** step `checks` · pull request #31");
    expect(pipelineAt("human-review", { pullRequest: 31 }).statusLine).toBe("**Hunt:** step `human-review` · pull request #31 · a person reviews before the merge");
    expect(pipelineAt("merge", { pullRequest: 31, attempt: 1 }).statusLine).toBe("**Hunt:** step `merge` · attempt 1 of 5 · pull request #31");
  });

  it("is null for a comment without a record marker", () => {
    expect(Pipeline.fromComment("<!-- hunt:step {\"step\":\"plan\"} -->")).toBeNull();
    expect(Pipeline.fromComment("Please hurry.")).toBeNull();
  });

  it("rejects records of version < 3 with the problem, a record without a version as one of version 1", () => {
    const problem = (version: number) => ({ problem: `the record is of version ${version}; this release drives records of version 3 and above only` });
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":2,"step":"review","pullRequest":31,${SKILLS_JSON}} -->`)).toEqual(problem(2));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":1,"step":"merge",${SKILLS_JSON}} -->`)).toEqual(problem(1));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"step":"merge","humanReview":true,${SKILLS_JSON}} -->`)).toEqual(problem(1));
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"attempt":1} -->')).toEqual(problem(1));
  });

  it("names the problem of a record that carries no usable pipeline, a version that is no number included", () => {
    const unusable = { problem: "the record is unusable" };
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":3,"step":"running"} -->')).toEqual(unusable);
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":3,"step":"gate"} -->')).toEqual(unusable);
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":3,"attempt":1} -->')).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":"3","step":"plan",${SKILLS_JSON}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":null,"step":"plan",${SKILLS_JSON}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment("<!-- hunt:pipeline {step: plan} -->")).toEqual(unusable);
    expect(Pipeline.fromComment("<!-- hunt:pipeline nope -->")).toBeNull();
  });

  it("is unusable without the skill of every agent step, since Hunt has no default skill", () => {
    const unusable = { problem: "the record is unusable" };
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":3,"step":"plan"} -->')).toEqual(unusable);
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":3,"step":"plan","skills":"swf-plan"} -->')).toEqual(unusable);
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":3,"step":"plan","skills":{"plan":"acme-plan"}} -->')).toEqual(unusable);
    const withoutPr = Object.fromEntries(Object.entries(SKILLS).filter(([step]) => step !== "pr"));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":3,"step":"plan","skills":${JSON.stringify(withoutPr)}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":3,"step":"plan","skills":${JSON.stringify({ ...SKILLS, pr: "" })}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":3,"step":"plan","skills":${JSON.stringify({ ...SKILLS, pr: 7 })}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":3,"step":"plan","skills":${JSON.stringify({ ...SKILLS, gate: "nope" })}} -->`)).toEqual(unusable);
  });

  it("tolerates the missing fields of a bare record of the current version and orders the skills by the steps", () => {
    const merge = recordOf(`<!-- hunt:pipeline {"version":3,"step":"merge",${SKILLS_JSON}} -->`);
    expect(merge?.toJSON()).toEqual({ ...started(NOW).toJSON(), ...BARE, step: "merge", runs: [] });
    expect(merge?.toComment()).toBe(pipelineAt("merge", { ...BARE, runs: [] }).toComment());
    const unordered = recordOf('<!-- hunt:pipeline {"version":4,"step":"plan","skills":{"pr":"swf-pr","plan":"acme-plan","review":"swf-review","verify":"swf-verify","implement":"swf-implement"}} -->');
    expect(unordered?.toJSON()).toEqual({ ...started(NOW, { ...SKILLS, plan: "acme-plan" }).toJSON(), ...BARE, version: 4, runs: [] });
    expect(Object.keys(unordered?.skills ?? {})).toEqual([...AGENT_STEPS]);
  });

  it("takes the start value of a field with another type and keeps the strings of a list", () => {
    const body =
      `<!-- hunt:pipeline {"version":3,"step":"verify","attempt":"2","humanReview":"yes","pullRequest":"31","humanReviewPaths":["a/**"],${SKILLS_JSON},` +
      '"findings":"x","escalate":1,"promptTurn":"5","reminded":"no","lastResultId":1.5,"handledReview":false,"mergeSha":7,"notified":null,"inReview":"yes","extra":true} -->';
    expect(recordOf(body)?.toJSON()).toEqual({ ...started(NOW).toJSON(), ...BARE, step: "verify", runs: [] });
  });

  it("drops a runs field that is no list and keeps a list of runs as it is", () => {
    expect(recordOf(`<!-- hunt:pipeline {"version":3,"step":"verify","runs":"none",${SKILLS_JSON}} -->`)?.runs).toEqual([]);
    const runs = [runOf(1, "plan", { endedAt: "2026-10-25T10:05:00.000Z", outcome: "passed" }), runOf(2, "verify")];
    expect(recordOf(`<!-- hunt:pipeline {"version":3,"step":"verify","runs":${JSON.stringify(runs)},${SKILLS_JSON}} -->`)?.runs).toEqual(runs);
  });
});

describe("the runs of the pipeline", () => {
  const LATER = NOW + 5 * 60_000;
  const ENDED = { endedAt: "2026-10-25T10:05:00.000Z" };

  it("logs one run per step, ends a run as passed when the step's result moves the pipeline on, and starts the next", () => {
    const pipeline = started(NOW);
    pipeline.acceptResult(reported({ step: "plan" }), 11, LATER);
    expect(pipeline.runs).toEqual([runOf(1, "plan", { ...ENDED, outcome: "passed" }), { ...runOf(2, "implement"), startedAt: "2026-10-25T10:05:00.000Z" }]);
    expect(pipeline.currentRun).toEqual(pipeline.runs[1]);
    expect(pipeline.lastEndedRun).toEqual(pipeline.runs[0]);
  });

  it("ends a run that sends the issue back as returned with the number of findings, and names it as the cause of the implement run", () => {
    const pipeline = pipelineAt("verify", { runs: [runOf(1, "plan", { ...ENDED, outcome: "passed" }), runOf(2, "implement", { ...ENDED, outcome: "passed" }), runOf(3, "verify")] });
    pipeline.acceptResult(reported({ step: "verify", findings: ["a", "b"] }), 20, LATER);
    expect(pipeline.runs.slice(2)).toEqual([runOf(3, "verify", { ...ENDED, outcome: "returned", findings: 2 }), { ...runOf(4, "implement", { cause: 3 }), startedAt: "2026-10-25T10:05:00.000Z" }]);
    const checks = pipelineAt("checks", { pullRequest: 31, runs: [runOf(1, "checks")] });
    checks.sendBackToImplement(["Checks: build failed"], LATER);
    expect(checks.runs[0]).toEqual(runOf(1, "checks", { ...ENDED, outcome: "returned", findings: 1 }));
    expect(checks.runs[1].cause).toBe(1);
    const human = pipelineAt("human-review", { pullRequest: 31, runs: [runOf(1, "human-review")] });
    human.handleChangeRequest(503, "Rename it", LATER);
    expect(human.runs.map((run) => [run.step, run.outcome, run.cause])).toEqual([["human-review", "returned", undefined], ["implement", "running", 1]]);
  });

  it("logs the poller's steps too: checks passed, the human review required, approval, the merge completed, and a failure at any step", () => {
    const pipeline = pipelineAt("checks", { pullRequest: 31, runs: [runOf(1, "checks")] });
    pipeline.requireHumanReview(LATER);
    pipeline.approve(LATER);
    pipeline.complete(LATER);
    expect(pipeline.runs.map((run) => [run.n, run.step, run.outcome])).toEqual([[1, "checks", "passed"], [2, "human-review", "passed"], [3, "merge", "passed"]]);
    expect(pipeline.currentRun).toBeUndefined();
    expect(pipeline.lastEndedRun?.n).toBe(3);
    const direct = pipelineAt("checks", { pullRequest: 31, runs: [runOf(1, "checks")] });
    direct.passChecks(LATER);
    direct.complete(LATER);
    expect(direct.runs.map((run) => [run.n, run.step, run.outcome])).toEqual([[1, "checks", "passed"], [2, "merge", "passed"]]);
    expect(() => pipelineAt("checks", { runs: [runOf(1, "checks")] }).complete(LATER)).toThrow("completing the pipeline needs the step merge, but the pipeline is at checks");
    const failed = pipelineAt("implement", { runs: [runOf(1, "implement")] });
    failed.fail(LATER);
    expect(failed.runs).toEqual([runOf(1, "implement", { ...ENDED, outcome: "failed" })]);
  });

  it("starts an agent step over on a replaced VM: the run ends as restarted, a new run of the step waits for its prompt, the rest stays", () => {
    const pipeline = pipelineAt("implement", { attempt: 2, findings: ["Verify: a"], promptTurn: 1_000, reminded: true, runs: [runOf(1, "verify", { ...ENDED, outcome: "returned", findings: 1 }), runOf(2, "implement", { cause: 1 })] });
    pipeline.restart(LATER);
    expect(pipeline.runs.slice(1)).toEqual([runOf(2, "implement", { ...ENDED, outcome: "restarted", cause: 1 }), { ...runOf(3, "implement"), startedAt: "2026-10-25T10:05:00.000Z" }]);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 2, findings: ["Verify: a"], promptTurn: null, reminded: false });
    expect(pipeline.isPromptPending).toBe(true);
    expect(() => pipelineAt("checks", { pullRequest: 31, runs: [runOf(1, "checks")] }).restart(LATER)).toThrow("the step checks waits for GitHub, not for the agent; nothing to restart");
  });

  it("goes on without a log for a bare record and refuses a running run of another step than the current one", () => {
    const bare = new Pipeline({ ...pipelineAt("verify").toJSON(), runs: [] });
    bare.acceptResult(reported({ step: "verify", findings: [] }), 20, LATER);
    expect(bare.runs).toEqual([{ ...runOf(1, "review"), startedAt: "2026-10-25T10:05:00.000Z" }]);
    expect(() => pipelineAt("verify", { runs: [runOf(1, "plan")] })).toThrow(/the running run is the current step's/);
  });
});

describe("stepSkills", () => {
  it("names the skill of every agent step in the order of the steps and drops the entries of other steps", () => {
    const everyStep = { pr: "a-pr", plan: "a-plan", implement: "a-implement", verify: "a-verify", review: "a-review", gate: "a-gate", deploy: "x" };
    expect(stepSkills(everyStep)).toEqual({ skills: { plan: "a-plan", implement: "a-implement", verify: "a-verify", review: "a-review", pr: "a-pr" } });
    expect(Object.keys(stepSkills(everyStep).skills ?? {})).toEqual([...AGENT_STEPS]);
  });

  it("lists the steps the value names no skill for, in the order of the steps", () => {
    for (const value of [undefined, null, "acme-plan", ["acme-plan"], {}]) {
      expect(stepSkills(value), JSON.stringify(value)).toEqual({ missing: [...AGENT_STEPS] });
    }
    const mixed = { pr: "acme-pr", plan: "acme-plan", implement: "", verify: 7, review: null, gate: "acme-gate" };
    expect(stepSkills(mixed)).toEqual({ missing: ["implement", "verify", "review"] });
    expect(stepSkills({ ...SKILLS, pr: undefined })).toEqual({ missing: ["pr"] });
  });
});

describe("the pipeline's invariants", () => {
  it("refuses a reminder without a prompt", () => {
    expect(() => pipelineAt("verify", { reminded: true })).toThrow(/the agent is reminded only after a prompt/);
    const reminded = pipelineAt("verify", { reminded: true, promptTurn: 1_000 }).toComment();
    expect(Pipeline.fromComment(reminded.replace("\"promptTurn\":1000", "\"promptTurn\":null"))).toEqual({ problem: "the record is unusable" });
  });

  it("refuses a requested merge at another step than merge", () => {
    expect(() => pipelineAt("checks", { mergeSha: HEAD_SHA })).toThrow(/a merge is requested only at the step merge/);
    expect(pipelineAt("merge", { mergeSha: HEAD_SHA }).mergeSha).toBe(HEAD_SHA);
  });

  it("refuses notified reviewers without a pull request", () => {
    expect(() => pipelineAt("checks", { notified: true })).toThrow(/reviewers are notified only on a pull request/);
    expect(pipelineAt("checks", { notified: true, pullRequest: 31 }).notified).toBe(true);
  });
});

describe("Pipeline queries", () => {
  it("waits for the agent at the agent steps only", () => {
    for (const step of AGENT_STEPS) {
      expect(pipelineAt(step).waitsForAgent, step).toBe(true);
    }
    for (const step of POLLER_STEPS) {
      expect(pipelineAt(step).waitsForAgent, step).toBe(false);
    }
  });

  it("names the repository's skill of a step", () => {
    const pipeline = started(NOW, { ...SKILLS, plan: "acme-plan" });
    expect(pipeline.skillOf("plan")).toBe("acme-plan");
    expect(pipeline.skillOf("review")).toBe("swf-review");
  });

  it("tells a turn that ended since the prompt from the prompt's own, and none before a prompt", () => {
    expect(pipelineAt("verify").hasTurnEndedSincePrompt(1_000)).toBe(false);
    const pipeline = pipelineAt("verify", { promptTurn: 1_000 });
    expect(pipeline.hasTurnEndedSincePrompt(1_000)).toBe(false);
    expect(pipeline.hasTurnEndedSincePrompt(2_000)).toBe(true);
  });

  it("counts each person's latest review, never bots, and hands an unhandled change request back once", () => {
    const bot = "hunt-agent[bot]";
    const pipeline = pipelineAt("human-review", { pullRequest: 31 });
    expect(pipeline.humanReviewOutcome([], bot)).toEqual({ kind: "wait" });
    expect(pipeline.humanReviewOutcome([review(1, bot, "APPROVED"), review(2, "dr-claude-bot[bot]", "APPROVED")], bot)).toEqual({ kind: "wait" });
    expect(pipeline.humanReviewOutcome([review(1, "alice", "COMMENTED"), review(2, "alice", "APPROVED")], bot)).toEqual({ kind: "approved", by: ["alice"] });
    const changes = [review(1, "alice", "APPROVED"), review(2, "bob", "CHANGES_REQUESTED", "Rename it")];
    expect(pipeline.humanReviewOutcome(changes, bot)).toEqual({ kind: "changes", review: changes[1] });
    const handled = pipelineAt("human-review", { pullRequest: 31, handledReview: 2 });
    expect(handled.humanReviewOutcome(changes, bot)).toEqual({ kind: "wait" });
    expect(handled.humanReviewOutcome([...changes, review(3, "bob", "APPROVED")], bot)).toEqual({ kind: "approved", by: ["alice", "bob"] });
    expect(pipeline.humanReviewOutcome([review(1, "alice", "APPROVED"), review(2, "alice", "DISMISSED")], bot)).toEqual({ kind: "wait" });
  });
});

describe("Pipeline.acceptResult", () => {
  it("walks plan → implement → verify → review → pr → checks and records the result's comment id", () => {
    const pipeline = pipelineAt("plan", { promptTurn: 5, reminded: true, attempt: 3, findings: ["old"], escalate: true });
    pipeline.acceptResult(reported({ step: "plan" }), 11, NOW);
    expect(pipeline).toMatchObject({ step: "implement", lastResultId: 11, promptTurn: null, reminded: false, attempt: 0, findings: [], escalate: false });
    pipeline.acceptResult(reported({ step: "implement", summary: "done" }), 12, NOW);
    expect(pipeline.step).toBe("verify");
    pipeline.acceptResult(reported({ step: "verify", findings: [] }), 13, NOW);
    expect(pipeline.step).toBe("review");
    pipeline.acceptResult(reported({ step: "review", findings: [] }), 14, NOW);
    expect(pipeline).toMatchObject({ step: "pr", pullRequest: null });
    pipeline.acceptResult(reported({ step: "pr", pullRequest: 42 }), 15, NOW);
    expect(pipeline).toMatchObject({ step: "checks", pullRequest: 42, lastResultId: 15 });
  });

  it("sends verify findings back to implement, prefixed, and counts the attempt", () => {
    const pipeline = pipelineAt("verify");
    pipeline.acceptResult(reported({ step: "verify", findings: ["button missing", "test fails"] }), 20, NOW);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 1, escalate: false, lastResultId: 20 });
    expect(pipeline.findings).toEqual(["Verify: button missing", "Verify: test fails"]);
  });

  it("sends the review step's findings back to implement, prefixed, and counts the attempt", () => {
    const pipeline = pipelineAt("review", { pullRequest: 42, attempt: 1 });
    pipeline.acceptResult(reported({ step: "review", findings: ["no test covers the new rule", "debug output left in api.ts"] }), 21, NOW);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 2, escalate: false, pullRequest: 42, lastResultId: 21 });
    expect(pipeline.findings).toEqual(["Review: no test covers the new rule", "Review: debug output left in api.ts"]);
    expect(pipeline.runs.map((run) => [run.step, run.outcome, run.findings])).toEqual([["review", "returned", 2], ["implement", "running", undefined]]);
  });

  it("skips the pr step when the pull request exists", () => {
    const pipeline = pipelineAt("review", { pullRequest: 42, inReview: true });
    pipeline.acceptResult(reported({ step: "review", findings: [] }), 21, NOW);
    expect(pipeline).toMatchObject({ step: "checks", pullRequest: 42, inReview: true });
  });

  it("refuses a result for another step than the current one and changes nothing", () => {
    const pipeline = pipelineAt("verify", { lastResultId: 3 });
    expect(() => pipeline.acceptResult(reported({ step: "plan" }), 22, NOW)).toThrow(UnusableStepResult);
    expect(() => pipeline.acceptResult(reported({ step: "plan" }), 22, NOW)).toThrow("the result reports step plan, but the current step is verify");
    expect(pipeline.toJSON()).toEqual(pipelineAt("verify", { lastResultId: 3 }).toJSON());
  });

  it("refuses a comment without a usable result with the parser's problem", () => {
    const pipeline = pipelineAt("review");
    expect(() => pipeline.acceptResult(null, 1, NOW)).toThrow(UnusableStepResult);
    expect(() => pipeline.acceptResult(null, 1, NOW)).toThrow("no step marker");
    const problem = "findings of a review result must be a list";
    expect(() => pipeline.acceptResult({ problem }, 1, NOW)).toThrow(problem);
    expect(pipeline.lastResultId).toBe(0);
  });

  it("refuses a result the poller acted on already", () => {
    const pipeline = pipelineAt("implement", { lastResultId: 12 });
    const again = reported({ step: "implement", summary: "again" });
    expect(() => pipeline.acceptResult(again, 12, NOW)).toThrow("the step result 12 is not newer than the last one acted on, 12");
    expect(pipeline.step).toBe("implement");
  });
});

describe("Pipeline.dismissResult", () => {
  it("keeps the step, makes the comment history and counts the agent's next turn", () => {
    const pipeline = pipelineAt("review", { lastResultId: 1003, promptTurn: 3_000, reminded: true });
    pipeline.dismissResult(1004, 4_000);
    expect(pipeline.toJSON()).toEqual(pipelineAt("review", { lastResultId: 1004, promptTurn: 4_000 }).toJSON());
  });

  it("refuses a result the poller acted on already", () => {
    const pipeline = pipelineAt("review", { lastResultId: 1004 });
    expect(() => pipeline.dismissResult(1003, 5_000)).toThrow("the step result 1003 is not newer than the last one acted on, 1004");
    expect(pipeline.promptTurn).toBeNull();
  });

  it("dismisses the result the runner read from the file without a comment id, keeping the last one acted on", () => {
    const pipeline = pipelineAt("review", { lastResultId: 1004, promptTurn: 3_000, reminded: true });
    pipeline.dismissResult(null, 4_000);
    expect(pipeline.toJSON()).toEqual(pipelineAt("review", { lastResultId: 1004, promptTurn: 4_000 }).toJSON());
  });
});

describe("Pipeline.recordPrompt", () => {
  it("records the turn at which the step's prompt went out", () => {
    const pipeline = pipelineAt("verify");
    expect(pipeline.isPromptPending).toBe(true);
    pipeline.recordPrompt(1_000);
    expect(pipeline.promptTurn).toBe(1_000);
    expect(pipeline.isPromptPending).toBe(false);
  });

  it("refuses a second prompt for the step", () => {
    const pipeline = pipelineAt("verify", { promptTurn: 1_000 });
    expect(() => pipeline.recordPrompt(2_000)).toThrow("the prompt of the step verify was sent already");
    expect(pipeline.promptTurn).toBe(1_000);
  });

  it("refuses a prompt at a step of the poller, which has none", () => {
    const pipeline = pipelineAt("checks", { pullRequest: 31 });
    expect(pipeline.isPromptPending).toBe(false);
    expect(() => pipeline.recordPrompt(0)).toThrow("the step checks has no prompt for the agent");
  });
});

describe("Pipeline.remind", () => {
  it("reminds the agent of a turn that ended without a result and waits for the next one", () => {
    const pipeline = pipelineAt("verify", { promptTurn: 1_000 });
    pipeline.remind(2_000);
    expect(pipeline).toMatchObject({ step: "verify", reminded: true, promptTurn: 2_000 });
  });

  it("refuses a second reminder", () => {
    const pipeline = pipelineAt("verify", { promptTurn: 2_000, reminded: true });
    expect(() => pipeline.remind(3_000)).toThrow("the agent was reminded of the step verify already");
    expect(pipeline.promptTurn).toBe(2_000);
  });

  it("refuses a reminder while no turn ended since the prompt", () => {
    expect(() => pipelineAt("verify", { promptTurn: 1_000 }).remind(1_000)).toThrow("no turn of the agent ended since the prompt of the step verify");
    expect(() => pipelineAt("verify").remind(1_000)).toThrow("no turn of the agent ended since the prompt of the step verify");
  });
});

describe("Pipeline.noteAnswersDelivered", () => {
  it("counts the turn after the answers as the step's and allows a reminder again", () => {
    const pipeline = pipelineAt("implement", { lastResultId: 1002, promptTurn: 500, reminded: true });
    pipeline.noteAnswersDelivered(1_000);
    expect(pipeline.toJSON()).toEqual(pipelineAt("implement", { lastResultId: 1002, promptTurn: 1_000 }).toJSON());
  });
});

describe("Pipeline.sendBackToImplement", () => {
  it("counts the attempts, escalates past MAX_ATTEMPTS and starts counting again", () => {
    const pipeline = pipelineAt("verify");
    for (let round = 1; round <= MAX_ATTEMPTS; round++) {
      pipeline.sendBackToImplement([`finding ${round}`], NOW);
      expect(pipeline).toMatchObject({ step: "implement", attempt: round, escalate: false, findings: [`finding ${round}`] });
      pipeline.acceptResult(reported({ step: "implement", summary: "fixed" }), round, NOW);
    }
    pipeline.sendBackToImplement(["again"], NOW);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 0, escalate: true, findings: ["again"] });
    pipeline.acceptResult(reported({ step: "implement", summary: "asked" }), MAX_ATTEMPTS + 1, NOW);
    pipeline.sendBackToImplement(["once more"], NOW);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 1, escalate: false });
  });

  it("enters implement afresh and keeps only findings with text, at most 20 of at most 4000 characters", () => {
    const pipeline = pipelineAt("merge", { pullRequest: 31, mergeSha: HEAD_SHA, promptTurn: 0, inReview: true });
    pipeline.sendBackToImplement(["", "  ", "x".repeat(5000), ...Array.from({ length: 25 }, (_entry, index) => `finding ${index}`)], NOW);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 1, pullRequest: 31, mergeSha: null, promptTurn: null, reminded: false, inReview: true });
    expect(pipeline.findings).toHaveLength(20);
    expect(pipeline.findings[0]).toBe("x".repeat(4000));
    expect(pipeline.findings[19]).toBe("finding 18");
  });

  it("refuses a step that checks nothing", () => {
    for (const step of ["plan", "implement", "pr"] as const) {
      const pipeline = pipelineAt(step);
      expect(() => pipeline.sendBackToImplement(["a finding"], NOW), step).toThrow(`the step ${step} checks nothing that could send the issue back to implement`);
      expect(pipeline.step).toBe(step);
    }
  });
});

describe("Pipeline.passChecks", () => {
  it("goes on from passed checks with the scorer's approval to merge", () => {
    const pipeline = pipelineAt("checks", { pullRequest: 31, inReview: true });
    pipeline.passChecks(NOW);
    expect(pipeline).toMatchObject({ step: "merge", pullRequest: 31, inReview: true });
  });

  it("refuses another step than checks", () => {
    expect(() => pipelineAt("merge").passChecks(NOW)).toThrow("passing the checks needs the step checks, but the pipeline is at merge");
    expect(() => pipelineAt("review").passChecks(NOW)).toThrow("passing the checks needs the step checks, but the pipeline is at review");
  });
});

describe("Pipeline.requireHumanReview", () => {
  it("goes on to human-review from checks the scorer did not approve, or from a merge the scorer withdrew its approval from", () => {
    const checks = pipelineAt("checks", { pullRequest: 31 });
    checks.requireHumanReview(NOW);
    expect(checks).toMatchObject({ step: "human-review", pullRequest: 31 });
    const merge = pipelineAt("merge", { pullRequest: 31, mergeSha: HEAD_SHA });
    merge.requireHumanReview(NOW);
    expect(merge).toMatchObject({ step: "human-review", pullRequest: 31, mergeSha: null });
    expect(merge.runs.map((run) => [run.step, run.outcome])).toEqual([["merge", "passed"], ["human-review", "running"]]);
  });

  it("refuses every other step and names it", () => {
    for (const step of ["plan", "implement", "verify", "review", "pr", "human-review"] as const) {
      const pipeline = pipelineAt(step, { pullRequest: 31 });
      expect(() => pipeline.requireHumanReview(NOW), step).toThrow(`a human review needs the step checks or merge, but the pipeline is at ${step}`);
      expect(pipeline.step).toBe(step);
    }
  });
});

describe("Pipeline.approve", () => {
  it("goes on from a person's approval to merge", () => {
    const pipeline = pipelineAt("human-review", { pullRequest: 31, notified: true });
    pipeline.approve(NOW);
    const runs = [runOf(1, "human-review", { endedAt: new Date(NOW).toISOString(), outcome: "passed" }), runOf(2, "merge")];
    expect(pipeline.toJSON()).toEqual(pipelineAt("merge", { pullRequest: 31, notified: true, runs }).toJSON());
  });

  it("refuses another step than human-review", () => {
    expect(() => pipelineAt("checks").approve(NOW)).toThrow("an approval needs the step human-review, but the pipeline is at checks");
  });
});

describe("Pipeline.handleChangeRequest", () => {
  it("sends a person's change request back to implement and counts the review as handled", () => {
    const pipeline = pipelineAt("human-review", { pullRequest: 31, attempt: 1 });
    pipeline.handleChangeRequest(503, "@carol requested changes on #31:\nRename the index.", NOW);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 2, findings: ["@carol requested changes on #31:\nRename the index."], handledReview: 503 });
  });

  it("refuses another step than human-review", () => {
    const pipeline = pipelineAt("checks");
    expect(() => pipeline.handleChangeRequest(503, "Rename it", NOW)).toThrow("a change request needs the step human-review, but the pipeline is at checks");
  });

  it("refuses a review that was handled already", () => {
    const pipeline = pipelineAt("human-review", { handledReview: 503 });
    expect(() => pipeline.handleChangeRequest(503, "Rename it", NOW)).toThrow("the review 503 was handled already");
    expect(pipeline.step).toBe("human-review");
  });
});

describe("Pipeline.noteReviewersNotified", () => {
  it("remembers that the people who review were asked", () => {
    const pipeline = pipelineAt("human-review", { pullRequest: 31 });
    pipeline.noteReviewersNotified();
    expect(pipeline.notified).toBe(true);
  });

  it("refuses notified reviewers without a pull request, and rolls the change back", () => {
    const pipeline = pipelineAt("human-review");
    expect(() => pipeline.noteReviewersNotified()).toThrow(/reviewers are notified only on a pull request/);
    expect(pipeline.notified).toBe(false);
  });
});

describe("Pipeline.noteInReview", () => {
  it("remembers that the issue was moved to In Review, at any step, and keeps it through every later step", () => {
    const pipeline = pipelineAt("checks", { pullRequest: 31 });
    pipeline.noteInReview();
    expect(pipeline.inReview).toBe(true);
    pipeline.sendBackToImplement(["Checks: build failed"], NOW);
    expect(pipeline).toMatchObject({ step: "implement", inReview: true });
    const merge = pipelineAt("merge", { pullRequest: 31 });
    merge.noteInReview();
    expect(merge.inReview).toBe(true);
  });
});

describe("Pipeline.noteMergeRequested", () => {
  it("remembers the head commit GitHub was asked to update or merge", () => {
    const pipeline = pipelineAt("merge", { pullRequest: 31 });
    pipeline.noteMergeRequested(HEAD_SHA);
    expect(pipeline.mergeSha).toBe(HEAD_SHA);
  });

  it("refuses another step than merge", () => {
    expect(() => pipelineAt("checks").noteMergeRequested(HEAD_SHA)).toThrow("a merge request needs the step merge, but the pipeline is at checks");
  });
});
