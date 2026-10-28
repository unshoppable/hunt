import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import type { ParsedStepResult, StepResult } from "../../../../libs/domain/src/swf/step-result.utils.ts";
import { AGENT_STEPS, POLLER_STEPS, type SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { MAX_ATTEMPTS, Pipeline, stepSkills, type PullRequestReview } from "./pipeline.domain.ts";
import { SKILLS } from "./swf.fixtures.ts";
import { UnusableStepResult } from "./unusable-step-result.error.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
/** The record's `skills` of SKILLS, as the record comment spells it. */
const SKILLS_JSON = '"skills":{"plan":"swf-plan","implement":"swf-implement","verify":"swf-verify","gate":"swf-gate","pr":"swf-pr"}';

/** A fresh pipeline at `step`, apart from `fields`. */
function pipelineAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...Pipeline.start([], SKILLS).toJSON(), step, ...fields });
}

/** `result` as `parseStepResult` reports a usable one. */
function reported(result: StepResult): ParsedStepResult {
  return { result };
}

function review(id: number, author: string, state: string, body = ""): PullRequestReview {
  return { id, author, state, body, submittedAt: `2026-10-25T10:0${id}:00Z` };
}

describe("Pipeline.start", () => {
  it("starts at plan with nothing sent or acted on, with the repository's review paths and the skill of every agent step", () => {
    expect(Pipeline.start(["**/migrations/**"], { ...SKILLS, plan: "acme-plan" }).toJSON()).toEqual({
      step: "plan",
      attempt: 0,
      humanReview: false,
      pullRequest: null,
      humanReviewPaths: ["**/migrations/**"],
      skills: { plan: "acme-plan", implement: "swf-implement", verify: "swf-verify", gate: "swf-gate", pr: "swf-pr" },
      findings: [],
      escalate: false,
      promptTurn: null,
      reminded: false,
      lastResultId: 0,
      handledReview: null,
      mergeSha: null,
      notified: false,
    });
    const unordered = { pr: "a-pr", plan: "a-plan", implement: "a-implement", verify: "a-verify", gate: "a-gate" };
    expect(Object.keys(Pipeline.start([], unordered).skills)).toEqual([...AGENT_STEPS]);
    expect(() => Pipeline.start([], { ...SKILLS, pr: "" })).toThrow();
  });
});

describe("the record comment", () => {
  it("holds the status line and the record with its keys in their order, and survives the round trip", () => {
    const fields = { attempt: 2, findings: ["Verify: a"], pullRequest: 42, promptTurn: 1760000000000 };
    const pipeline = new Pipeline({ ...Pipeline.start(["**/migrations/**"], { ...SKILLS, gate: "acme-gate" }).toJSON(), step: "implement", ...fields });
    const body = pipeline.toComment();
    expect(body).toBe(
      "**Hunt:** step `implement` · attempt 2 of 5 · pull request #42 · merged without a human review unless the gate asks for one\n\n" +
        '<!-- hunt:pipeline {"step":"implement","attempt":2,"humanReview":false,"pullRequest":42,"humanReviewPaths":["**/migrations/**"],' +
        '"skills":{"plan":"swf-plan","implement":"swf-implement","verify":"swf-verify","gate":"acme-gate","pr":"swf-pr"},' +
        '"findings":["Verify: a"],"escalate":false,"promptTurn":1760000000000,"reminded":false,' +
        '"lastResultId":0,"handledReview":null,"mergeSha":null,"notified":false} -->\n',
    );
    expect(body.startsWith(pipeline.statusLine)).toBe(true);
    expect(Pipeline.fromComment(body)).toEqual(pipeline);
    expect(Pipeline.fromComment(body)?.toComment()).toBe(body);
  });

  it("tells in the status line whether a person approves and leaves out what is not there yet", () => {
    expect(Pipeline.start([], SKILLS).statusLine).toBe("**Hunt:** step `plan` · merged without a human review unless the gate asks for one");
    const human = pipelineAt("human-review", { humanReview: true, pullRequest: 31 });
    expect(human.statusLine).toBe("**Hunt:** step `human-review` · pull request #31 · a person reviews before the merge");
  });

  it("is null for a comment that carries no usable record", () => {
    expect(Pipeline.fromComment("<!-- hunt:step {\"step\":\"plan\"} -->")).toBeNull();
    expect(Pipeline.fromComment("Please hurry.")).toBeNull();
    expect(Pipeline.fromComment("<!-- hunt:pipeline {\"step\":\"running\"} -->")).toBeNull();
    expect(Pipeline.fromComment("<!-- hunt:pipeline {\"attempt\":1} -->")).toBeNull();
    expect(Pipeline.fromComment("<!-- hunt:pipeline nope -->")).toBeNull();
    expect(Pipeline.fromComment("<!-- hunt:pipeline {step: plan} -->")).toBeNull();
  });

  it("is null for a record without the skill of every agent step, since Hunt has no default skill", () => {
    expect(Pipeline.fromComment("<!-- hunt:pipeline {\"step\":\"plan\"} -->")).toBeNull();
    expect(Pipeline.fromComment("<!-- hunt:pipeline {\"step\":\"plan\",\"skills\":\"swf-plan\"} -->")).toBeNull();
    expect(Pipeline.fromComment("<!-- hunt:pipeline {\"step\":\"plan\",\"skills\":{\"plan\":\"acme-plan\"}} -->")).toBeNull();
    const withoutPr = Object.fromEntries(Object.entries(SKILLS).filter(([step]) => step !== "pr"));
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"step":"plan","skills":${JSON.stringify(withoutPr)}} -->`)).toBeNull();
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"step":"plan","skills":${JSON.stringify({ ...SKILLS, pr: "" })}} -->`)).toBeNull();
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"step":"plan","skills":${JSON.stringify({ ...SKILLS, pr: 7 })}} -->`)).toBeNull();
    expect(Pipeline.fromComment(`<!-- hunt:pipeline {"step":"plan","skills":${JSON.stringify({ ...SKILLS, review: "nope" })}} -->`)).toBeNull();
  });

  it("tolerates the missing fields of an older record and orders the skills by the steps", () => {
    const merge = Pipeline.fromComment(`<!-- hunt:pipeline {"step":"merge","humanReview":true,${SKILLS_JSON}} -->`);
    expect(merge?.toJSON()).toEqual({ ...Pipeline.start([], SKILLS).toJSON(), step: "merge", humanReview: true });
    expect(merge?.toComment()).toBe(pipelineAt("merge", { humanReview: true }).toComment());
    const unordered = Pipeline.fromComment('<!-- hunt:pipeline {"step":"plan","skills":{"pr":"swf-pr","plan":"acme-plan","gate":"swf-gate","verify":"swf-verify","implement":"swf-implement"}} -->');
    expect(unordered).toEqual(Pipeline.start([], { ...SKILLS, plan: "acme-plan" }));
    expect(Object.keys(unordered?.skills ?? {})).toEqual([...AGENT_STEPS]);
  });

  it("takes the start value of a field with another type and keeps the strings of a list", () => {
    const body =
      `<!-- hunt:pipeline {"step":"verify","attempt":"2","humanReview":"yes","pullRequest":"31","humanReviewPaths":["a/**",7],${SKILLS_JSON},` +
      '"findings":"x","escalate":1,"promptTurn":"5","reminded":"no","lastResultId":1.5,"handledReview":false,"mergeSha":7,"notified":null,"extra":true} -->';
    expect(Pipeline.fromComment(body)?.toJSON()).toEqual({ ...Pipeline.start(["a/**"], SKILLS).toJSON(), step: "verify" });
  });
});

describe("stepSkills", () => {
  it("names the skill of every agent step in the order of the steps and drops the entries of other steps", () => {
    const everyStep = { pr: "a-pr", plan: "a-plan", implement: "a-implement", verify: "a-verify", gate: "a-gate", review: "a-review", deploy: "x" };
    expect(stepSkills(everyStep)).toEqual({ skills: { plan: "a-plan", implement: "a-implement", verify: "a-verify", gate: "a-gate", pr: "a-pr" } });
    expect(Object.keys(stepSkills(everyStep).skills ?? {})).toEqual([...AGENT_STEPS]);
  });

  it("lists the steps the value names no skill for, in the order of the steps", () => {
    for (const value of [undefined, null, "acme-plan", ["acme-plan"], {}]) {
      expect(stepSkills(value), JSON.stringify(value)).toEqual({ missing: [...AGENT_STEPS] });
    }
    const mixed = { pr: "acme-pr", plan: "acme-plan", implement: "", verify: 7, gate: null, review: "acme-review" };
    expect(stepSkills(mixed)).toEqual({ missing: ["implement", "verify", "gate"] });
    expect(stepSkills({ ...SKILLS, pr: undefined })).toEqual({ missing: ["pr"] });
  });
});

describe("the pipeline's invariants", () => {
  it("refuses a reminder without a prompt", () => {
    expect(() => pipelineAt("verify", { reminded: true })).toThrow(/the agent is reminded only after a prompt/);
    const reminded = pipelineAt("verify", { reminded: true, promptTurn: 1_000 }).toComment();
    expect(Pipeline.fromComment(reminded.replace("\"promptTurn\":1000", "\"promptTurn\":null"))).toBeNull();
  });

  it("refuses a requested merge at another step than merge", () => {
    expect(() => pipelineAt("review", { mergeSha: HEAD_SHA })).toThrow(/a merge is requested only at the step merge/);
    expect(pipelineAt("merge", { mergeSha: HEAD_SHA }).mergeSha).toBe(HEAD_SHA);
  });

  it("refuses notified reviewers without a person's review", () => {
    expect(() => pipelineAt("review", { notified: true })).toThrow(/reviewers are notified only when a person reviews/);
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
    const pipeline = Pipeline.start([], { ...SKILLS, plan: "acme-plan" });
    expect(pipeline.skillOf("plan")).toBe("acme-plan");
    expect(pipeline.skillOf("gate")).toBe("swf-gate");
  });

  it("tells a turn that ended since the prompt from the prompt's own, and none before a prompt", () => {
    expect(pipelineAt("verify").hasTurnEndedSincePrompt(1_000)).toBe(false);
    const pipeline = pipelineAt("verify", { promptTurn: 1_000 });
    expect(pipeline.hasTurnEndedSincePrompt(1_000)).toBe(false);
    expect(pipeline.hasTurnEndedSincePrompt(2_000)).toBe(true);
  });

  it("counts each person's latest review, never bots, and hands an unhandled change request back once", () => {
    const bot = "hunt-agent[bot]";
    const pipeline = pipelineAt("human-review", { pullRequest: 31, humanReview: true });
    expect(pipeline.humanReviewOutcome([], bot)).toEqual({ kind: "wait" });
    expect(pipeline.humanReviewOutcome([review(1, bot, "APPROVED"), review(2, "dr-claude-bot[bot]", "APPROVED")], bot)).toEqual({ kind: "wait" });
    expect(pipeline.humanReviewOutcome([review(1, "alice", "COMMENTED"), review(2, "alice", "APPROVED")], bot)).toEqual({ kind: "approved", by: ["alice"] });
    const changes = [review(1, "alice", "APPROVED"), review(2, "bob", "CHANGES_REQUESTED", "Rename it")];
    expect(pipeline.humanReviewOutcome(changes, bot)).toEqual({ kind: "changes", review: changes[1] });
    const handled = pipelineAt("human-review", { pullRequest: 31, humanReview: true, handledReview: 2 });
    expect(handled.humanReviewOutcome(changes, bot)).toEqual({ kind: "wait" });
    expect(handled.humanReviewOutcome([...changes, review(3, "bob", "APPROVED")], bot)).toEqual({ kind: "approved", by: ["alice", "bob"] });
    expect(pipeline.humanReviewOutcome([review(1, "alice", "APPROVED"), review(2, "alice", "DISMISSED")], bot)).toEqual({ kind: "wait" });
  });
});

describe("Pipeline.acceptResult", () => {
  it("walks plan → implement → verify → gate → pr → review and records the result's comment id", () => {
    const pipeline = pipelineAt("plan", { promptTurn: 5, reminded: true, attempt: 3, findings: ["old"], escalate: true });
    pipeline.acceptResult(reported({ step: "plan" }), 11);
    expect(pipeline).toMatchObject({ step: "implement", lastResultId: 11, promptTurn: null, reminded: false, attempt: 0, findings: [], escalate: false });
    pipeline.acceptResult(reported({ step: "implement", summary: "done" }), 12);
    expect(pipeline.step).toBe("verify");
    pipeline.acceptResult(reported({ step: "verify", findings: [] }), 13);
    expect(pipeline.step).toBe("gate");
    pipeline.acceptResult(reported({ step: "gate", humanReview: false, risk: "low", reasons: [] }), 14);
    expect(pipeline).toMatchObject({ step: "pr", humanReview: false });
    pipeline.acceptResult(reported({ step: "pr", pullRequest: 42 }), 15);
    expect(pipeline).toMatchObject({ step: "review", pullRequest: 42, lastResultId: 15 });
  });

  it("sends verify findings back to implement, prefixed, and counts the attempt", () => {
    const pipeline = pipelineAt("verify");
    pipeline.acceptResult(reported({ step: "verify", findings: ["button missing", "test fails"] }), 20);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 1, escalate: false, lastResultId: 20 });
    expect(pipeline.findings).toEqual(["Verify: button missing", "Verify: test fails"]);
  });

  it("skips the pr step when the pull request exists and keeps humanReview once set", () => {
    const pipeline = pipelineAt("gate", { pullRequest: 42, humanReview: true });
    pipeline.acceptResult(reported({ step: "gate", humanReview: false, risk: "low", reasons: [] }), 21);
    expect(pipeline).toMatchObject({ step: "review", humanReview: true, pullRequest: 42 });
  });

  it("refuses a result for another step than the current one and changes nothing", () => {
    const pipeline = pipelineAt("verify", { lastResultId: 3 });
    expect(() => pipeline.acceptResult(reported({ step: "plan" }), 22)).toThrow(UnusableStepResult);
    expect(() => pipeline.acceptResult(reported({ step: "plan" }), 22)).toThrow("the result reports step plan, but the current step is verify");
    expect(pipeline.toJSON()).toEqual(pipelineAt("verify", { lastResultId: 3 }).toJSON());
  });

  it("refuses a comment without a usable result with the parser's problem", () => {
    const pipeline = pipelineAt("gate");
    expect(() => pipeline.acceptResult(null, 1)).toThrow(UnusableStepResult);
    expect(() => pipeline.acceptResult(null, 1)).toThrow("no step marker");
    const problem = "humanReview of a gate result must be true or false";
    expect(() => pipeline.acceptResult({ problem }, 1)).toThrow(problem);
    expect(pipeline.lastResultId).toBe(0);
  });

  it("refuses a result the poller acted on already", () => {
    const pipeline = pipelineAt("implement", { lastResultId: 12 });
    const again = reported({ step: "implement", summary: "again" });
    expect(() => pipeline.acceptResult(again, 12)).toThrow("the step result 12 is not newer than the last one acted on, 12");
    expect(pipeline.step).toBe("implement");
  });
});

describe("Pipeline.dismissResult", () => {
  it("keeps the step, makes the comment history and counts the agent's next turn", () => {
    const pipeline = pipelineAt("gate", { lastResultId: 1003, promptTurn: 3_000, reminded: true });
    pipeline.dismissResult(1004, 4_000);
    expect(pipeline.toJSON()).toEqual(pipelineAt("gate", { lastResultId: 1004, promptTurn: 4_000 }).toJSON());
  });

  it("refuses a result the poller acted on already", () => {
    const pipeline = pipelineAt("gate", { lastResultId: 1004 });
    expect(() => pipeline.dismissResult(1003, 5_000)).toThrow("the step result 1003 is not newer than the last one acted on, 1004");
    expect(pipeline.promptTurn).toBeNull();
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
    const pipeline = pipelineAt("review", { pullRequest: 31 });
    expect(pipeline.isPromptPending).toBe(false);
    expect(() => pipeline.recordPrompt(0)).toThrow("the step review has no prompt for the agent");
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
      pipeline.sendBackToImplement([`finding ${round}`]);
      expect(pipeline).toMatchObject({ step: "implement", attempt: round, escalate: false, findings: [`finding ${round}`] });
      pipeline.acceptResult(reported({ step: "implement", summary: "fixed" }), round);
    }
    pipeline.sendBackToImplement(["again"]);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 0, escalate: true, findings: ["again"] });
    pipeline.acceptResult(reported({ step: "implement", summary: "asked" }), MAX_ATTEMPTS + 1);
    pipeline.sendBackToImplement(["once more"]);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 1, escalate: false });
  });

  it("enters implement afresh and keeps only findings with text, at most 20 of at most 4000 characters", () => {
    const pipeline = pipelineAt("merge", { pullRequest: 31, mergeSha: HEAD_SHA, promptTurn: 0 });
    pipeline.sendBackToImplement(["", "  ", "x".repeat(5000), ...Array.from({ length: 25 }, (_entry, index) => `finding ${index}`)]);
    expect(pipeline).toMatchObject({ step: "implement", attempt: 1, pullRequest: 31, mergeSha: null, promptTurn: null, reminded: false });
    expect(pipeline.findings).toHaveLength(20);
    expect(pipeline.findings[0]).toBe("x".repeat(4000));
    expect(pipeline.findings[19]).toBe("finding 18");
  });

  it("refuses a step that checks nothing", () => {
    for (const step of ["plan", "implement", "gate", "pr"] as const) {
      const pipeline = pipelineAt(step);
      expect(() => pipeline.sendBackToImplement(["a finding"]), step).toThrow(`the step ${step} checks nothing that could send the issue back to implement`);
      expect(pipeline.step).toBe(step);
    }
  });
});

describe("Pipeline.passReview", () => {
  it("goes on from a passed review to merge, or to human-review when a person has to approve", () => {
    const merge = pipelineAt("review", { pullRequest: 31 });
    merge.passReview();
    expect(merge.step).toBe("merge");
    const human = pipelineAt("review", { pullRequest: 31, humanReview: true, notified: true });
    human.passReview();
    expect(human).toMatchObject({ step: "human-review", humanReview: true, notified: true });
  });

  it("refuses another step than review", () => {
    expect(() => pipelineAt("merge").passReview()).toThrow("passing the review needs the step review, but the pipeline is at merge");
  });
});

describe("Pipeline.approve", () => {
  it("goes on from a person's approval to merge", () => {
    const pipeline = pipelineAt("human-review", { pullRequest: 31, humanReview: true, notified: true });
    pipeline.approve();
    expect(pipeline.toJSON()).toEqual(pipelineAt("merge", { pullRequest: 31, humanReview: true, notified: true }).toJSON());
  });

  it("refuses another step than human-review", () => {
    expect(() => pipelineAt("review").approve()).toThrow("an approval needs the step human-review, but the pipeline is at review");
  });
});

describe("Pipeline.handleChangeRequest", () => {
  it("sends a person's change request back to implement and counts the review as handled", () => {
    const pipeline = pipelineAt("human-review", { pullRequest: 31, humanReview: true, attempt: 1 });
    pipeline.handleChangeRequest(503, "@carol requested changes on #31:\nRename the index.");
    expect(pipeline).toMatchObject({ step: "implement", attempt: 2, findings: ["@carol requested changes on #31:\nRename the index."], handledReview: 503 });
  });

  it("refuses another step than human-review", () => {
    const pipeline = pipelineAt("review");
    expect(() => pipeline.handleChangeRequest(503, "Rename it")).toThrow("a change request needs the step human-review, but the pipeline is at review");
  });

  it("refuses a review that was handled already", () => {
    const pipeline = pipelineAt("human-review", { humanReview: true, handledReview: 503 });
    expect(() => pipeline.handleChangeRequest(503, "Rename it")).toThrow("the review 503 was handled already");
    expect(pipeline.step).toBe("human-review");
  });
});

describe("Pipeline.requireHumanReview", () => {
  it("lets a person approve before the merge from now on", () => {
    const pipeline = pipelineAt("review", { pullRequest: 31 });
    pipeline.requireHumanReview();
    pipeline.passReview();
    expect(pipeline).toMatchObject({ step: "human-review", humanReview: true });
  });
});

describe("Pipeline.noteReviewersNotified", () => {
  it("remembers that the people who review were asked", () => {
    const pipeline = pipelineAt("review", { pullRequest: 31, humanReview: true });
    pipeline.noteReviewersNotified();
    expect(pipeline.notified).toBe(true);
  });

  it("refuses notified reviewers while no person reviews, and rolls the change back", () => {
    const pipeline = pipelineAt("review", { pullRequest: 31 });
    expect(() => pipeline.noteReviewersNotified()).toThrow(/reviewers are notified only when a person reviews/);
    expect(pipeline.notified).toBe(false);
  });
});

describe("Pipeline.noteMergeRequested", () => {
  it("remembers the head commit GitHub was asked to update or merge", () => {
    const pipeline = pipelineAt("merge", { pullRequest: 31 });
    pipeline.noteMergeRequested(HEAD_SHA);
    expect(pipeline.mergeSha).toBe(HEAD_SHA);
  });

  it("refuses another step than merge", () => {
    expect(() => pipelineAt("review").noteMergeRequested(HEAD_SHA)).toThrow("a merge request needs the step merge, but the pipeline is at review");
  });
});
