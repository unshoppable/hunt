import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import type { Finding, ParsedStepResult, StepResult } from "./step-result.utils.ts";
import { AGENT_STEPS, POLLER_STEPS, type SwfStep } from "./swf-step.types.ts";
import { Pipeline, RECORD_VERSION, stepSettings, type PullRequestReview, type Run } from "./pipeline.domain.ts";
import { DEFAULT_MAX_GATE_RUNS, DEFAULT_MAX_RETURNS } from "./step-settings.value-object.ts";
import { IMPLEMENT_GATE, ISSUE, SETTINGS, settingsWith, started } from "./swf.fixtures.ts";
import { UnusableStepResult } from "./unusable-step-result.error.ts";

/** The poller's clock in the tests: 2026-10-25 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
/** The record's `settings` of SETTINGS, as the record comment spells it. */
const SETTINGS_JSON = `"settings":${JSON.stringify(SETTINGS)}`;
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

/** `texts` as findings written as plain strings, which carry no severity. */
function unscored(...texts: string[]): Finding[] {
  return texts.map((text) => ({ text, severity: null }));
}

/** The pipeline of the record comment `body`; undefined when the comment holds none. */
function recordOf(body: string): Pipeline | undefined {
  return Pipeline.fromComment(body)?.pipeline;
}

function review(id: number, author: string, state: string, body = ""): PullRequestReview {
  return { id, author, state, body, submittedAt: `2026-10-25T10:0${id}:00Z` };
}

describe("Pipeline.start", () => {
  it("starts at plan with nothing sent or acted on, of the current record version, with the issue and the step settings", () => {
    const settings = settingsWith({ plan: { skill: "acme-plan", model: "claude-opus-5-5" } });
    expect(RECORD_VERSION).toBe(4);
    expect(Pipeline.start(ISSUE, settings, NOW).toJSON()).toEqual({
      version: 4,
      repo: "acme/app",
      issue: 12,
      branch: "feat/general/12-issue-12",
      recordId: 0,
      step: "plan",
      returns: {},
      gateRuns: 0,
      pullRequest: null,
      settings: settings.toJSON(),
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
    expect(started(NOW, settings).settings.isEqualTo(settings)).toBe(true);
  });
});

describe("the record comment", () => {
  it("holds the status line and the record with its keys in their order, and survives the round trip with its settings and returns", () => {
    const settings = settingsWith({ review: { skill: "acme-review", maxReturns: 4, effort: "high" } }, 3);
    const fields = { returns: { verify: 2, review: 1 }, gateRuns: 1, findings: ["Verify: a"], pullRequest: 42, promptTurn: 1760000000000 };
    const pipeline = new Pipeline({ ...started(NOW, settings).toJSON(), step: "implement", runs: [runOf(1, "implement")], ...fields });
    const body = pipeline.toComment();
    expect(body).toBe(
      "**Hunt:** step `implement` · return 2 of 5 (verify) · return 1 of 4 (review) · pull request #42\n\n" +
        '<!-- hunt:pipeline {"version":4,"repo":"acme/app","issue":12,"branch":"feat/general/12-issue-12","recordId":0,' +
        '"step":"implement","returns":{"verify":2,"review":1},"gateRuns":1,"pullRequest":42,' +
        `"settings":${JSON.stringify(settings)},` +
        '"findings":["Verify: a"],"escalate":false,"promptTurn":1760000000000,"reminded":false,' +
        '"lastResultId":0,"handledReview":null,"mergeSha":null,"notified":false,"inReview":false,' +
        '"runs":[{"n":1,"step":"implement","startedAt":"2026-10-25T10:00:00.000Z","endedAt":null,"outcome":"running"}]} -->\n',
    );
    expect(body.startsWith(pipeline.statusLine)).toBe(true);
    expect(Pipeline.fromComment(body)).toEqual({ pipeline });
    const record = recordOf(body);
    expect(record?.toComment()).toBe(body);
    expect(record?.settings).toBeInstanceOf(settings.constructor);
    expect(record?.settings.isEqualTo(settings)).toBe(true);
    expect(record?.limitOf("review")).toBe(4);
    expect(record?.returnsOf("verify")).toBe(2);
    expect(record?.gateRuns).toBe(1);
  });

  it("says in the status line that a person reviews only at human-review and leaves out what is not there yet", () => {
    expect(started(NOW).statusLine).toBe("**Hunt:** step `plan`");
    expect(pipelineAt("checks", { pullRequest: 31 }).statusLine).toBe("**Hunt:** step `checks` · pull request #31");
    expect(pipelineAt("human-review", { pullRequest: 31 }).statusLine).toBe("**Hunt:** step `human-review` · pull request #31 · a person reviews before the merge");
    expect(pipelineAt("merge", { pullRequest: 31, returns: { merge: 1 } }).statusLine).toBe("**Hunt:** step `merge` · return 1 of 2 (merge) · pull request #31");
    const both = pipelineAt("implement", { returns: { checks: 1, verify: 3, review: 0 } });
    expect(both.statusLine).toBe("**Hunt:** step `implement` · return 3 of 5 (verify) · return 1 of 2 (checks)");
  });

  it("is null for a comment without a record marker", () => {
    expect(Pipeline.fromComment("<!-- hunt:step {\"step\":\"plan\"} -->")).toBeNull();
    expect(Pipeline.fromComment("Please hurry.")).toBeNull();
  });

  it("rejects records of version < 4 with the problem, a record without a version as one of version 1", () => {
    const problem = (version: number) => ({ problem: `the record is of version ${version}; this release drives records of version 4 and above only` });
    const skills = '"skills":{"plan":"swf-plan","implement":"swf-implement","verify":"swf-verify","review":"swf-review","pr":"swf-pr"}';
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":3,"step":"review","attempt":1,${skills}} -->`)).toEqual(problem(3));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":2,"step":"review","pullRequest":31,${SETTINGS_JSON}} -->`)).toEqual(problem(2));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":1,"step":"merge",${SETTINGS_JSON}} -->`)).toEqual(problem(1));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"step":"merge","humanReview":true,${SETTINGS_JSON}} -->`)).toEqual(problem(1));
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"attempt":1} -->')).toEqual(problem(1));
  });

  it("names the problem of a record that carries no usable pipeline, a version that is no number included", () => {
    const unusable = { problem: "the record is unusable" };
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":4,"step":"running"} -->')).toEqual(unusable);
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":4,"step":"gate"} -->')).toEqual(unusable);
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":4,"returns":{}} -->')).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":"4","step":"plan",${SETTINGS_JSON}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"version":null,"step":"plan",${SETTINGS_JSON}} -->`)).toEqual(unusable);
    expect(Pipeline.fromComment("<!-- hunt:pipeline {step: plan} -->")).toEqual(unusable);
    expect(Pipeline.fromComment("<!-- hunt:pipeline nope -->")).toBeNull();
  });

  it("is unusable without usable step settings", () => {
    const unusable = { problem: "the record is unusable" };
    const record = (settings: unknown) => Pipeline.fromComment(`<!-- hunt:pipeline {"version":4,"step":"plan","settings":${JSON.stringify(settings)}} -->`);
    const plain = SETTINGS.toJSON();
    expect(Pipeline.fromComment('<!-- hunt:pipeline {"version":4,"step":"plan"} -->')).toEqual(unusable);
    expect(record("swf-plan")).toEqual(unusable);
    expect(record({ steps: plain.steps })).toEqual(unusable);
    expect(record({ ...plain, maxGateRuns: 0 })).toEqual(unusable);
    const withoutPr = Object.fromEntries(Object.entries(plain.steps).filter(([step]) => step !== "pr"));
    expect(record({ ...plain, steps: withoutPr })).toEqual(unusable);
    expect(record({ ...plain, steps: { ...plain.steps, pr: { ...plain.steps.pr, skill: "" } } })).toEqual(unusable);
    expect(record({ ...plain, steps: { ...plain.steps, pr: { ...plain.steps.pr, effort: "extreme" } } })).toEqual(unusable);
    expect(record({ ...plain, steps: { ...plain.steps, gate: plain.steps.pr } })).toEqual(unusable);
  });

  it("tolerates the missing fields of a bare record of the current version or a later one", () => {
    const merge = recordOf(`<!-- hunt:pipeline {"version":4,"step":"merge",${SETTINGS_JSON}} -->`);
    expect(merge?.toJSON()).toEqual({ ...started(NOW).toJSON(), ...BARE, step: "merge", runs: [] });
    expect(merge?.toComment()).toBe(pipelineAt("merge", { ...BARE, runs: [] }).toComment());
    const later = recordOf(`<!-- hunt:pipeline {"version":5,"step":"plan",${SETTINGS_JSON}} -->`);
    expect(later?.toJSON()).toEqual({ ...started(NOW).toJSON(), ...BARE, version: 5, runs: [] });
  });

  it("takes the start value of a field with another type and keeps the strings of a list", () => {
    const body =
      `<!-- hunt:pipeline {"version":4,"step":"verify","returns":{"verify":"2"},"gateRuns":-1,"attempt":2,"humanReview":"yes","pullRequest":"31","humanReviewPaths":["a/**"],${SETTINGS_JSON},` +
      '"findings":"x","escalate":1,"promptTurn":"5","reminded":"no","lastResultId":1.5,"handledReview":false,"mergeSha":7,"notified":null,"inReview":"yes","extra":true} -->';
    expect(recordOf(body)?.toJSON()).toEqual({ ...started(NOW).toJSON(), ...BARE, step: "verify", runs: [] });
  });

  it("drops a runs field that is no list and keeps a list of runs as it is", () => {
    expect(recordOf(`<!-- hunt:pipeline {"version":4,"step":"verify","runs":"none",${SETTINGS_JSON}} -->`)?.runs).toEqual([]);
    const runs = [runOf(1, "plan", { endedAt: "2026-10-25T10:05:00.000Z", outcome: "passed" }), runOf(2, "verify")];
    expect(recordOf(`<!-- hunt:pipeline {"version":4,"step":"verify","runs":${JSON.stringify(runs)},${SETTINGS_JSON}} -->`)?.runs).toEqual(runs);
  });
});

describe("the runs of the pipeline", () => {
  const LATER = NOW + 5 * 60_000;
  const ENDED = { endedAt: "2026-10-25T10:05:00.000Z" };

  it("logs one run per step, ends a run as passed when the step's result moves the pipeline on, and starts the next", () => {
    const pipeline = started(NOW);
    pipeline.acceptResult(reported({ step: "plan", branch: "feat/general/12-fix-login" }), 11, LATER);
    expect(pipeline.runs).toEqual([runOf(1, "plan", { ...ENDED, outcome: "passed" }), { ...runOf(2, "implement"), startedAt: "2026-10-25T10:05:00.000Z" }]);
    expect(pipeline.currentRun).toEqual(pipeline.runs[1]);
    expect(pipeline.lastEndedRun).toEqual(pipeline.runs[0]);
  });

  it("ends a run that sends the issue back as returned with the number of findings, and names it as the cause of the implement run", () => {
    const pipeline = pipelineAt("verify", { runs: [runOf(1, "plan", { ...ENDED, outcome: "passed" }), runOf(2, "implement", { ...ENDED, outcome: "passed" }), runOf(3, "verify")] });
    pipeline.acceptResult(reported({ step: "verify", findings: unscored("a", "b") }), 20, LATER);
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
    const pipeline = pipelineAt("implement", { returns: { verify: 2 }, gateRuns: 2, findings: ["Verify: a"], promptTurn: 1_000, reminded: true, runs: [runOf(1, "verify", { ...ENDED, outcome: "returned", findings: 1 }), runOf(2, "implement", { cause: 1 })] });
    pipeline.restart(LATER);
    expect(pipeline.runs.slice(1)).toEqual([runOf(2, "implement", { ...ENDED, outcome: "restarted", cause: 1 }), { ...runOf(3, "implement"), startedAt: "2026-10-25T10:05:00.000Z" }]);
    expect(pipeline).toMatchObject({ step: "implement", returns: { verify: 2 }, gateRuns: 0, findings: ["Verify: a"], promptTurn: null, reminded: false });
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

describe("stepSettings", () => {
  it("takes the step settings session-config reports", () => {
    const settings = stepSettings(JSON.parse(JSON.stringify(SETTINGS)));
    expect(settings.problem).toBeUndefined();
    expect(settings.settings?.isEqualTo(SETTINGS)).toBe(true);
  });

  it("names the problem of settings the schema rejects", () => {
    for (const value of [undefined, null, "swf-plan", [], {}]) {
      expect(stepSettings(value).problem, JSON.stringify(value)).toMatch(/^the step settings are unusable \(.+\)$/);
    }
    const plain = SETTINGS.toJSON();
    expect(stepSettings({ ...plain, maxGateRuns: 0 }).problem).toMatch(/^the step settings are unusable \(maxGateRuns: .+\)$/);
    expect(stepSettings({ ...plain, steps: { ...plain.steps, review: { ...plain.steps.review, effort: "extreme" } } }).problem).toMatch(/steps\.review\.effort: /);
  });

  it("names the agent steps without a skill, since Hunt has no default skill", () => {
    const plain = SETTINGS.toJSON();
    const without = (...steps: string[]) => ({ ...plain, steps: { ...plain.steps, ...Object.fromEntries(steps.map((step) => [step, { ...plain.steps.plan, skill: null }])) } });
    expect(stepSettings(without("review"))).toEqual({ problem: "the step settings name no skill for the step review" });
    expect(stepSettings(without("pr", "implement"))).toEqual({ problem: "the step settings name no skill for the steps implement, pr" });
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

  it("names the repository's settings of a step: skill, config options, limit of returns and gate", () => {
    const settings = settingsWith({ plan: { skill: "acme-plan", model: "claude-opus-5-5", effort: "max" }, review: { effort: "low", gate: ["spec"] } });
    const pipeline = started(NOW, settings);
    expect(pipeline.skillOf("plan")).toBe("acme-plan");
    expect(pipeline.skillOf("review")).toBe("swf-review");
    expect(pipeline.settingsOf("plan")).toEqual({ skill: "acme-plan", model: "claude-opus-5-5", effort: "max", maxReturns: null, minSeverity: null, gate: [] });
    expect(pipeline.configOptionsOf("plan")).toEqual({ model: "claude-opus-5-5", effort: "max" });
    expect(pipeline.configOptionsOf("review")).toEqual({ effort: "low" });
    expect(pipeline.configOptionsOf("pr")).toEqual({});
    expect(pipeline.limitOf("verify")).toBe(DEFAULT_MAX_RETURNS.verify);
    expect(pipeline.limitOf("merge")).toBe(DEFAULT_MAX_RETURNS.merge);
    expect(pipeline.limitOf("implement")).toBeNull();
    expect(pipeline.gateOf("implement")).toEqual(IMPLEMENT_GATE);
    expect(pipeline.gateOf("review")).toEqual(["spec"]);
    expect(pipeline.gateOf("plan")).toEqual([]);
    expect(pipelineAt("implement", { returns: { review: 2 } }).returnsOf("review")).toBe(2);
    expect(pipeline.returnsOf("review")).toBe(0);
    expect(pipeline.returnsOf("plan")).toBe(0);
  });

  it("names the step that sent the issue back to the current implement run, also after a restart", () => {
    const ended = { endedAt: new Date(NOW).toISOString() };
    expect(started(NOW).causeOf).toBeNull();
    const planned = pipelineAt("implement", { runs: [runOf(1, "plan", { ...ended, outcome: "passed" }), runOf(2, "implement")] });
    expect(planned.causeOf).toBeNull();
    expect(pipelineAt("implement", { runs: [] }).causeOf).toBeNull();
    const returned = pipelineAt("review");
    returned.sendBackToImplement(["Review: a"], NOW);
    expect(returned.causeOf).toBe("review");
    returned.restart(NOW);
    expect(returned.causeOf).toBe("review");
    returned.acceptResult(reported({ step: "implement", summary: "fixed" }), null, NOW);
    expect(returned.causeOf).toBeNull();
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
  it("takes the branch the plan step created, which the poller started the pipeline without", () => {
    const pipeline = Pipeline.start({ ...ISSUE, branch: "" }, SETTINGS, NOW);
    expect(pipeline.branch).toBe("");
    pipeline.acceptResult(reported({ step: "plan", branch: "fix/general/12-login" }), 11, NOW);
    expect(pipeline.branch).toBe("fix/general/12-login");
    expect(pipeline.step).toBe("implement");
  });

  it("walks plan → implement → verify → review → pr → checks and records the result's comment id", () => {
    const pipeline = pipelineAt("plan", { promptTurn: 5, reminded: true, returns: { verify: 3 }, gateRuns: 2, findings: ["old"], escalate: true });
    pipeline.acceptResult(reported({ step: "plan", branch: "feat/general/12-fix-login" }), 11, NOW);
    expect(pipeline).toMatchObject({ step: "implement", lastResultId: 11, promptTurn: null, reminded: false, returns: {}, gateRuns: 0, findings: [], escalate: false });
    expect(pipeline.branch).toBe("feat/general/12-fix-login");
    pipeline.acceptResult(reported({ step: "implement", summary: "done" }), 12, NOW);
    expect(pipeline.step).toBe("verify");
    pipeline.acceptResult(reported({ step: "verify", findings: [] }), 13, NOW);
    expect(pipeline.step).toBe("review");
    pipeline.acceptResult(reported({ step: "review", findings: [] }), 14, NOW);
    expect(pipeline).toMatchObject({ step: "pr", pullRequest: null });
    pipeline.acceptResult(reported({ step: "pr", pullRequest: 42 }), 15, NOW);
    expect(pipeline).toMatchObject({ step: "checks", pullRequest: 42, lastResultId: 15 });
  });

  it("sends unscored verify findings back to implement, prefixed, and counts the return of verify", () => {
    const pipeline = pipelineAt("verify");
    pipeline.acceptResult(reported({ step: "verify", findings: unscored("button missing", "test fails") }), 20, NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { verify: 1 }, escalate: false, lastResultId: 20 });
    expect(pipeline.findings).toEqual(["Verify: button missing", "Verify: test fails"]);
  });

  it("sends the review step's findings back to implement, prefixed, and counts the return of review", () => {
    const pipeline = pipelineAt("review", { pullRequest: 42, returns: { review: 1, verify: 4 } });
    pipeline.acceptResult(reported({ step: "review", findings: unscored("no test covers the new rule", "debug output left in api.ts") }), 21, NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { review: 2, verify: 4 }, escalate: false, pullRequest: 42, lastResultId: 21 });
    expect(pipeline.findings).toEqual(["Review: no test covers the new rule", "Review: debug output left in api.ts"]);
    expect(pipeline.runs.map((run) => [run.step, run.outcome, run.findings])).toEqual([["review", "returned", 2], ["implement", "running", undefined]]);
  });

  it("sends back only the findings at or above the step's minSeverity, gravest first, with their severity, and counts only those", () => {
    const pipeline = pipelineAt("review", { pullRequest: 42 });
    const findings = [
      { text: "naming of the helper", severity: 1 },
      { text: "duplicates formatDate", severity: 2 },
      { text: "no test for the new rule", severity: 3 },
      { text: "token logged", severity: 5 },
      { text: "api.ts: unscored", severity: null },
      { text: "null date crashes", severity: 4 },
    ];
    pipeline.acceptResult(reported({ step: "review", findings }), 21, NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { review: 1 }, pullRequest: 42 });
    expect(pipeline.findings).toEqual(["Review: api.ts: unscored", "Review (severity 5): token logged", "Review (severity 4): null date crashes", "Review (severity 3): no test for the new rule"]);
    expect(pipeline.runs[0]).toMatchObject({ step: "review", outcome: "returned", findings: 4 });
  });

  it("moves on when every finding is below the step's minSeverity, which the repository sets per step", () => {
    const suggestions = [{ text: "naming", severity: 1 }, { text: "duplicates formatDate", severity: 2 }];
    const verify = pipelineAt("verify");
    verify.acceptResult(reported({ step: "verify", findings: suggestions }), 20, NOW);
    expect(verify).toMatchObject({ step: "review", returns: {} });
    expect(verify.runs[0]).toMatchObject({ step: "verify", outcome: "passed" });
    expect(verify.runs[0].findings).toBeUndefined();
    const strict = pipelineAt("review", { settings: settingsWith({ review: { minSeverity: 4 } }) });
    strict.acceptResult(reported({ step: "review", findings: [...suggestions, { text: "no test", severity: 3 }] }), 21, NOW);
    expect(strict).toMatchObject({ step: "pr", returns: {} });
    const lenient = pipelineAt("review", { settings: settingsWith({ review: { minSeverity: 1 } }) });
    lenient.acceptResult(reported({ step: "review", findings: suggestions }), 21, NOW);
    expect(lenient.findings).toEqual(["Review (severity 2): duplicates formatDate", "Review (severity 1): naming"]);
    const unset = pipelineAt("verify", { settings: settingsWith({ verify: { minSeverity: null } }) });
    unset.acceptResult(reported({ step: "verify", findings: [{ text: "no test", severity: 3 }, { text: "nit", severity: 2 }] }), 20, NOW);
    expect(unset.findings).toEqual(["Verify (severity 3): no test"]);
  });

  it("skips the pr step when the pull request exists", () => {
    const pipeline = pipelineAt("review", { pullRequest: 42, inReview: true });
    pipeline.acceptResult(reported({ step: "review", findings: [] }), 21, NOW);
    expect(pipeline).toMatchObject({ step: "checks", pullRequest: 42, inReview: true });
  });

  it("refuses a result for another step than the current one and changes nothing", () => {
    const pipeline = pipelineAt("verify", { lastResultId: 3 });
    expect(() => pipeline.acceptResult(reported({ step: "plan", branch: "feat/general/12-fix-login" }), 22, NOW)).toThrow(UnusableStepResult);
    expect(() => pipeline.acceptResult(reported({ step: "plan", branch: "feat/general/12-fix-login" }), 22, NOW)).toThrow("the result reports step plan, but the current step is verify");
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

describe("Pipeline.noteGateFailure", () => {
  it("counts the gate's failures of the step's result, keeps the step and counts the agent's next turn, as a dismissed result", () => {
    const pipeline = pipelineAt("implement", { lastResultId: 7, promptTurn: 3_000, reminded: true, returns: { verify: 1 } });
    pipeline.noteGateFailure(4_000);
    expect(pipeline.toJSON()).toEqual(pipelineAt("implement", { lastResultId: 7, promptTurn: 4_000, returns: { verify: 1 }, gateRuns: 1 }).toJSON());
    expect(pipeline.hasTurnEndedSincePrompt(4_000)).toBe(false);
  });

  it("asks for an escalation once the result failed more often than maxGateRuns", () => {
    const pipeline = pipelineAt("implement", { settings: settingsWith({}, 2) });
    pipeline.noteGateFailure(1);
    pipeline.noteGateFailure(2);
    expect(pipeline).toMatchObject({ gateRuns: 2, gateEscalates: false });
    pipeline.noteGateFailure(3);
    expect(pipeline).toMatchObject({ gateRuns: 3, gateEscalates: true });
    expect(pipelineAt("implement", { gateRuns: DEFAULT_MAX_GATE_RUNS + 1 }).gateEscalates).toBe(true);
  });

  it("starts counting anew when the pipeline moves on, also back to implement, and on a restart", () => {
    const pipeline = pipelineAt("implement", { gateRuns: 3 });
    pipeline.acceptResult(reported({ step: "implement", summary: "green" }), null, NOW);
    expect(pipeline).toMatchObject({ step: "verify", gateRuns: 0 });
    const verify = pipelineAt("verify", { gateRuns: 2 });
    verify.sendBackToImplement(["Verify: a"], NOW);
    expect(verify.gateRuns).toBe(0);
    const restarted = pipelineAt("review", { gateRuns: 2 });
    restarted.restart(NOW);
    expect(restarted.gateRuns).toBe(0);
  });

  it("refuses a step of the poller, which has no gate", () => {
    const pipeline = pipelineAt("checks", { pullRequest: 31 });
    expect(() => pipeline.noteGateFailure(1_000)).toThrow("the step checks waits for GitHub and has no gate");
    expect(pipeline.gateRuns).toBe(0);
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
  it("counts the returns of each step, escalates past the step's limit and starts counting that step again", () => {
    const limit = DEFAULT_MAX_RETURNS.verify;
    const pipeline = pipelineAt("verify");
    for (let round = 1; round <= limit; round++) {
      pipeline.sendBackToImplement([`finding ${round}`], NOW);
      expect(pipeline).toMatchObject({ step: "implement", returns: { verify: round }, escalate: false, findings: [`finding ${round}`] });
      pipeline.acceptResult(reported({ step: "implement", summary: "fixed" }), null, NOW);
    }
    pipeline.sendBackToImplement(["again"], NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { verify: 0 }, escalate: true, findings: ["again"] });
    pipeline.acceptResult(reported({ step: "implement", summary: "asked" }), null, NOW);
    pipeline.sendBackToImplement(["once more"], NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { verify: 1 }, escalate: false });
  });

  it("keeps the count and the limit of each step apart", () => {
    const pipeline = pipelineAt("checks", { pullRequest: 31, returns: { verify: 4, checks: DEFAULT_MAX_RETURNS.checks } });
    pipeline.sendBackToImplement(["Checks: build failed"], NOW);
    expect(pipeline).toMatchObject({ returns: { verify: 4, checks: 0 }, escalate: true });
    const merge = pipelineAt("merge", { pullRequest: 31, returns: { checks: 2 } });
    merge.sendBackToImplement(["Merge: conflicts"], NOW);
    expect(merge).toMatchObject({ returns: { checks: 2, merge: 1 }, escalate: false });
    const strict = pipelineAt("review", { settings: settingsWith({ review: { maxReturns: 1 } }), returns: { review: 1 } });
    strict.sendBackToImplement(["Review: a"], NOW);
    expect(strict).toMatchObject({ returns: { review: 0 }, escalate: true });
    const unlimited = pipelineAt("verify", { settings: settingsWith({ verify: { maxReturns: null } }), returns: { verify: 40 } });
    unlimited.sendBackToImplement(["Verify: a"], NOW);
    expect(unlimited).toMatchObject({ returns: { verify: 41 }, escalate: false });
    expect(unlimited.statusLine).toBe("**Hunt:** step `implement` · return 41 (verify)");
  });

  it("enters implement afresh and keeps only findings with text, at most 20 of at most 4000 characters", () => {
    const pipeline = pipelineAt("merge", { pullRequest: 31, mergeSha: HEAD_SHA, promptTurn: 0, inReview: true });
    pipeline.sendBackToImplement(["", "  ", "x".repeat(5000), ...Array.from({ length: 25 }, (_entry, index) => `finding ${index}`)], NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { merge: 1 }, pullRequest: 31, mergeSha: null, promptTurn: null, reminded: false, inReview: true });
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
  it("goes on from passed checks with the review workflow's approval to merge", () => {
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
  it("goes on to human-review from checks the review workflow did not approve, or from a merge the workflow withdrew its approval from", () => {
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
    const pipeline = pipelineAt("human-review", { pullRequest: 31, returns: { "human-review": 1 } });
    pipeline.handleChangeRequest(503, "@carol requested changes on #31:\nRename the index.", NOW);
    expect(pipeline).toMatchObject({ step: "implement", returns: { "human-review": 2 }, findings: ["@carol requested changes on #31:\nRename the index."], handledReview: 503 });
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
