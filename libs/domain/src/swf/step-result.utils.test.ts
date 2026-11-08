import { describe, expect, it } from "vitest";
import { hasStepMarker, LIST_LIMIT, MAX_SEVERITY, MIN_SEVERITY, parseStepResult, TEXT_LIMIT } from "./step-result.utils.ts";
import { isAgentStep, isSwfStep } from "./swf-step.types.ts";

describe("steps", () => {
  it("tells the agent steps from the poller steps and both from anything else", () => {
    expect(isAgentStep("plan")).toBe(true);
    expect(isAgentStep("review")).toBe(true);
    expect(isAgentStep("human-review")).toBe(false);
    expect(isAgentStep("gate")).toBe(false);
    expect(isSwfStep("human-review")).toBe(true);
    expect(isSwfStep("checks")).toBe(false);
    expect(isSwfStep("gate")).toBe(false);
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
    expect(parseStepResult("The plan.\n\n<!-- hunt:step {\"step\":\"plan\",\"branch\":\"feat/general/12-fix-login\"} -->\n")).toEqual({
      result: { step: "plan", branch: "feat/general/12-fix-login" },
    });
    const branchRule = "branch of a plan result must be the name of the branch you created and pushed, as git check-ref-format --branch accepts it";
    expect(parseStepResult('<!-- hunt:step {"step":"plan"} -->')).toEqual({ problem: branchRule });
    expect(parseStepResult('<!-- hunt:step {"step":"plan","branch":""} -->')).toEqual({ problem: branchRule });
    expect(parseStepResult('<!-- hunt:step {"step":"plan","branch":"bad..branch"} -->')).toEqual({ problem: branchRule });
    expect(parseStepResult('<!-- hunt:step {"step":"plan","branch":12} -->')).toEqual({ problem: branchRule });
    expect(parseStepResult(`<!--hunt:step {"step":"implement","summary":"  ${"x".repeat(TEXT_LIMIT + 5)} "}-->`)).toEqual({
      result: { step: "implement", summary: "x".repeat(TEXT_LIMIT) },
    });
    const texts = Array.from({ length: LIST_LIMIT + 3 }, (_, index) => `finding ${index}`);
    const unscored = texts.slice(0, LIST_LIMIT).map((text) => ({ text, severity: null }));
    expect(parseStepResult(`<!-- hunt:step ${JSON.stringify({ step: "verify", findings: [...texts, "", 3] })} -->`)).toEqual({
      result: { step: "verify", findings: unscored },
    });
    expect(parseStepResult('<!-- hunt:step {"step":"verify"} -->')).toEqual({ result: { step: "verify", findings: [] } });
    expect(parseStepResult(`<!-- hunt:step ${JSON.stringify({ step: "review", findings: [...texts, "", 3] })} -->`)).toEqual({
      result: { step: "review", findings: unscored },
    });
    expect(parseStepResult('<!-- hunt:step {"step":"review","findings":["  api.ts logs the token  "]} -->')).toEqual({
      result: { step: "review", findings: [{ text: "api.ts logs the token", severity: null }] },
    });
    expect(parseStepResult('<!-- hunt:step {"step":"review","findings":[]} -->')).toEqual({ result: { step: "review", findings: [] } });
    expect(parseStepResult('<!-- hunt:step {"step":"review"} -->')).toEqual({ result: { step: "review", findings: [] } });
    expect(parseStepResult('<!-- hunt:step {"step":"pr","pullRequest":42} -->')).toEqual({ result: { step: "pr", pullRequest: 42 } });
  });

  it("reads scored findings, keeps a plain string unscored and drops an entry without text or a severity off the scale", () => {
    const scored = [
      { text: `  ${"y".repeat(TEXT_LIMIT + 5)}`, severity: 4 },
      { text: "api.ts: nit", severity: 1 },
      { text: "a string" },
      "plain",
      { text: "off the scale", severity: 6 },
      { text: "below", severity: 0 },
      { text: "fraction", severity: 2.5 },
      { text: "as text", severity: "3" },
      { text: "   ", severity: 5 },
      { severity: 5 },
      { text: 7, severity: 5 },
      null,
    ];
    expect(parseStepResult(`<!-- hunt:step ${JSON.stringify({ step: "review", findings: scored })} -->`)).toEqual({
      result: {
        step: "review",
        findings: [
          { text: "y".repeat(TEXT_LIMIT), severity: 4 },
          { text: "api.ts: nit", severity: 1 },
          { text: "a string", severity: null },
          { text: "plain", severity: null },
          { text: "off the scale", severity: null },
          { text: "below", severity: null },
          { text: "fraction", severity: null },
          { text: "as text", severity: null },
        ],
      },
    });
    expect(MIN_SEVERITY).toBe(1);
    expect(MAX_SEVERITY).toBe(5);
  });

  it("takes the last marker of a comment", () => {
    const body = '<!-- hunt:step {"step":"plan"} -->\n\nCorrection:\n<!-- hunt:step {"step":"pr","pullRequest":7} -->';
    expect(parseStepResult(body)).toEqual({ result: { step: "pr", pullRequest: 7 } });
  });

  it("names the problem of an unusable marker", () => {
    expect(parseStepResult("<!-- hunt:step {not json} -->")?.problem).toMatch(/no JSON object/);
    expect(parseStepResult('<!-- hunt:step {"foo":1} -->')?.problem).toMatch(/no object with a step/);
    expect(parseStepResult('<!-- hunt:step {"step":"checks"} -->')?.problem).toBe('unknown step "checks"; the agent steps are plan, implement, verify, review, pr');
    expect(parseStepResult('<!-- hunt:step {"step":"gate","humanReview":true,"risk":"low"} -->')?.problem).toMatch(/unknown step "gate"/);
    expect(parseStepResult('<!-- hunt:step {"step":"verify","findings":"one"} -->')?.problem).toBe("findings of a verify result must be a list");
    expect(parseStepResult('<!-- hunt:step {"step":"review","findings":"one"} -->')?.problem).toBe("findings of a review result must be a list");
    expect(parseStepResult('<!-- hunt:step {"step":"pr","pullRequest":"42"} -->')?.problem).toMatch(/pullRequest/);
    expect(parseStepResult('<!-- hunt:step {"step":"pr","pullRequest":0} -->')?.problem).toMatch(/pullRequest/);
  });
});
