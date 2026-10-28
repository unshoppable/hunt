import { describe, expect, it } from "vitest";
import { hasStepMarker, LIST_LIMIT, parseStepResult, TEXT_LIMIT } from "./step-result.utils.ts";
import { isAgentStep, isSwfStep } from "./swf-step.types.ts";

describe("steps", () => {
  it("tells the agent steps from the poller steps and both from anything else", () => {
    expect(isAgentStep("plan")).toBe(true);
    expect(isAgentStep("review")).toBe(false);
    expect(isSwfStep("review")).toBe(true);
    expect(isSwfStep("human-review")).toBe(true);
    expect(isSwfStep("running")).toBe(false);
  });
});

describe("parseStepResult", () => {
  it("is null without a marker and tells a marker apart from the question marker", () => {
    expect(parseStepResult("Plan posted.\n<!-- hunt:question -->")).toBeNull();
    expect(hasStepMarker("<!-- hunt:question -->")).toBe(false);
    expect(hasStepMarker("x <!-- hunt:step {\"step\":\"plan\"} -->")).toBe(true);
  });

  it("reads each step's result and cuts texts and lists", () => {
    expect(parseStepResult("The plan.\n\n<!-- hunt:step {\"step\":\"plan\"} -->\n")).toEqual({ result: { step: "plan" } });
    expect(parseStepResult(`<!--hunt:step {"step":"implement","summary":"  ${"x".repeat(TEXT_LIMIT + 5)} "}-->`)).toEqual({
      result: { step: "implement", summary: "x".repeat(TEXT_LIMIT) },
    });
    const findings = Array.from({ length: LIST_LIMIT + 3 }, (_, index) => `finding ${index}`);
    expect(parseStepResult(`<!-- hunt:step ${JSON.stringify({ step: "verify", findings: [...findings, "", 3] })} -->`)).toEqual({
      result: { step: "verify", findings: findings.slice(0, LIST_LIMIT) },
    });
    expect(parseStepResult('<!-- hunt:step {"step":"verify"} -->')).toEqual({ result: { step: "verify", findings: [] } });
    expect(parseStepResult('<!-- hunt:step {"step":"gate","humanReview":true,"risk":"high","reasons":["migration"]} -->')).toEqual({
      result: { step: "gate", humanReview: true, risk: "high", reasons: ["migration"] },
    });
    expect(parseStepResult('<!-- hunt:step {"step":"pr","pullRequest":42} -->')).toEqual({ result: { step: "pr", pullRequest: 42 } });
  });

  it("takes the last marker of a comment", () => {
    const body = '<!-- hunt:step {"step":"plan"} -->\n\nCorrection:\n<!-- hunt:step {"step":"pr","pullRequest":7} -->';
    expect(parseStepResult(body)).toEqual({ result: { step: "pr", pullRequest: 7 } });
  });

  it("names the problem of an unusable marker", () => {
    expect(parseStepResult("<!-- hunt:step {not json} -->")?.problem).toMatch(/no JSON object/);
    expect(parseStepResult('<!-- hunt:step {"foo":1} -->')?.problem).toMatch(/no object with a step/);
    expect(parseStepResult('<!-- hunt:step {"step":"review"} -->')?.problem).toMatch(/unknown step "review"/);
    expect(parseStepResult('<!-- hunt:step {"step":"verify","findings":"one"} -->')?.problem).toMatch(/must be a list/);
    expect(parseStepResult('<!-- hunt:step {"step":"gate","humanReview":"yes","risk":"low"} -->')?.problem).toMatch(/humanReview/);
    expect(parseStepResult('<!-- hunt:step {"step":"gate","humanReview":false,"risk":"huge"} -->')?.problem).toMatch(/risk/);
    expect(parseStepResult('<!-- hunt:step {"step":"pr","pullRequest":"42"} -->')?.problem).toMatch(/pullRequest/);
    expect(parseStepResult('<!-- hunt:step {"step":"pr","pullRequest":0} -->')?.problem).toMatch(/pullRequest/);
  });
});
