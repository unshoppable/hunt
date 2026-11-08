import { describe, expect, it } from "vitest";
import { SWF_STEPS } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { SwfSettings } from "./swf-settings.value-object.ts";

/** Every agent step with its skill, as `swf.steps` names them. */
const STEPS = { plan: { skill: "swf-plan" }, implement: { skill: "swf-implement" }, verify: { skill: "swf-verify" }, review: { skill: "swf-review" }, pr: { skill: "swf-pr" } };
const CHECKS = ["format", "lint", "test"];
const UNSET = { model: null, effort: null };
/** Hunt's workflow settings, which a section without `questionPrefix`, `projectStatus` and `mergeMethod` resolves to. */
const DEFAULT_WORKFLOW = { questionPrefix: "❓ RÜCKFRAGE", projectStatus: { inProgress: "In Progress", inReview: "In Review", done: "Done" }, mergeMethod: "squash" };

describe("SwfSettings", () => {
  it("resolves Hunt's defaults for every step: no model or effort, the limits of returns, every check as the gate of implement", () => {
    const settings = new SwfSettings({ steps: STEPS });
    expect(settings.toJSON()).toMatchObject({ model: null, effort: null, maxGateRuns: 5, questionPrefix: null, projectStatus: null, mergeMethod: null });
    const resolved = settings.resolve(CHECKS);
    expect(resolved.maxGateRuns).toBe(5);
    expect(resolved.toJSON()).toMatchObject(DEFAULT_WORKFLOW);
    expect(Object.keys(resolved.steps)).toEqual([...SWF_STEPS]);
    expect(resolved.steps).toEqual({
      plan: { skill: "swf-plan", ...UNSET, maxReturns: null, minSeverity: null, gate: [] },
      implement: { skill: "swf-implement", ...UNSET, maxReturns: null, minSeverity: null, gate: CHECKS },
      verify: { skill: "swf-verify", ...UNSET, maxReturns: 5, minSeverity: 3, gate: [] },
      review: { skill: "swf-review", ...UNSET, maxReturns: 3, minSeverity: 3, gate: [] },
      pr: { skill: "swf-pr", ...UNSET, maxReturns: null, minSeverity: null, gate: [] },
      "human-review": { skill: null, ...UNSET, maxReturns: 3, minSeverity: null, gate: [] },
      merge: { skill: null, ...UNSET, maxReturns: 2, minSeverity: null, gate: [] },
    });
  });

  it("lets a step's model, effort, limit of returns and minSeverity win over the section's and Hunt's", () => {
    const steps = { ...STEPS, implement: { skill: "swf-implement", model: "claude-sonnet-5-5", effort: "medium" as const }, verify: { skill: "swf-verify", maxReturns: 9, minSeverity: 4 } };
    const resolved = new SwfSettings({ model: "claude-opus-5-5", effort: "high", maxGateRuns: 2, steps: { ...steps, merge: { maxReturns: 1 } } }).resolve([]);
    expect(resolved.maxGateRuns).toBe(2);
    expect(resolved.of("plan")).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(resolved.of("implement")).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", gate: [] });
    expect(resolved.of("verify")).toMatchObject({ maxReturns: 9, minSeverity: 4 });
    expect(resolved.of("review").minSeverity).toBe(3);
    expect(resolved.of("merge")).toEqual({ skill: null, ...UNSET, maxReturns: 1, minSeverity: null, gate: [] });
  });

  it("keeps the section's question prefix, project statuses and merge method and resolves them as they are", () => {
    const workflow = { questionPrefix: "❓ QUESTION", projectStatus: { inProgress: "Doing", inReview: "Review", done: "Shipped" }, mergeMethod: "merge" as const };
    const settings = new SwfSettings({ ...workflow, steps: STEPS });
    expect(settings.toJSON()).toMatchObject(workflow);
    expect(settings.resolve(CHECKS).toJSON()).toMatchObject(workflow);
    expect(settings.resolve(CHECKS).steps).toEqual(new SwfSettings({ steps: STEPS }).resolve(CHECKS).steps);
    expect(new SwfSettings({ mergeMethod: "rebase", steps: STEPS }).resolve([]).toJSON()).toMatchObject({ ...DEFAULT_WORKFLOW, mergeMethod: "rebase" });
  });

  it("expands a gate in the order of hunt.json's checks: * for every check, a list for the checks it names, [] for none", () => {
    const gated = (implement: "*" | string[], review: "*" | string[]) =>
      new SwfSettings({ steps: { ...STEPS, implement: { skill: "swf-implement", checks: implement }, review: { skill: "swf-review", checks: review } } }).resolve(CHECKS);
    expect(gated([], "*").steps).toMatchObject({ implement: { gate: [] }, review: { gate: CHECKS } });
    expect(gated(["test", "format", "test"], ["lint"]).steps).toMatchObject({ implement: { gate: ["format", "test"] }, review: { gate: ["lint"] } });
    expect(new SwfSettings({ steps: STEPS }).gateChecks).toEqual([]);
    expect(new SwfSettings({ steps: { ...STEPS, implement: { skill: "swf-implement", checks: "*" }, verify: { skill: "swf-verify", checks: ["lint"] } } }).gateChecks).toEqual(["lint"]);
  });

  it("round-trips through its JSON", () => {
    const settings = new SwfSettings({ model: "claude-opus-5-5", steps: { ...STEPS, implement: { skill: "swf-implement", checks: ["lint"] } } });
    expect(new SwfSettings(settings.toJSON()).isEqualTo(settings)).toBe(true);
  });

  it("rejects an agent step without a skill, agent fields on a poller step and a limit of returns on a step that never sends the pipeline back", () => {
    const { review: _review, ...withoutReview } = STEPS;
    expect(() => new SwfSettings({ steps: withoutReview })).toThrow(/every agent step names its skill/);
    for (const merge of [{ skill: "swf-merge" }, { model: "claude-opus-5-5" }, { effort: "low" as const }, { checks: "*" as const }]) {
      expect(() => new SwfSettings({ steps: { ...STEPS, merge } })).toThrow(/only an agent step/);
    }
    expect(() => new SwfSettings({ steps: { ...STEPS, implement: { skill: "swf-implement", maxReturns: 2 } } })).toThrow(/only a returning step has maxReturns/);
    expect(() => new SwfSettings({ steps: { ...STEPS, "human-review": { minSeverity: 2 } } })).toThrow(/only a scoring step has minSeverity/);
    expect(() => new SwfSettings({ steps: { ...STEPS, plan: { skill: "swf-plan", minSeverity: 2 } } })).toThrow(/only a scoring step has minSeverity/);
  });

  it("rejects values that break their rules", () => {
    expect(() => new SwfSettings({ model: "opus", steps: STEPS })).toThrow(/full ID of a Claude model/);
    expect(() => new SwfSettings({ steps: { ...STEPS, review: { skill: "Swf Review" } } })).toThrow(/kebab-case name of a skill/);
    expect(() => new SwfSettings({ effort: "extreme" as never, steps: STEPS })).toThrow(/must be one of low, medium, high, xhigh, max/);
    expect(() => new SwfSettings({ maxGateRuns: 0, steps: STEPS })).toThrow(/at least 1/);
    expect(() => new SwfSettings({ steps: { ...STEPS, verify: { skill: "swf-verify", maxReturns: 21 } } })).toThrow(/from 1 to 20/);
    expect(() => new SwfSettings({ steps: { ...STEPS, review: { skill: "swf-review", minSeverity: 6 } } })).toThrow(/from 1 to 5/);
    expect(() => new SwfSettings({ steps: { ...STEPS, review: { skill: "swf-review", minSeverity: 0 } } })).toThrow(/from 1 to 5/);
    for (const questionPrefix of ["", "Frage:", "Frage\nbitte", "x".repeat(41)]) {
      expect(() => new SwfSettings({ questionPrefix, steps: STEPS })).toThrow(/does not end with a colon/);
    }
    expect(() => new SwfSettings({ projectStatus: { inProgress: "Doing", inReview: "Review" } as never, steps: STEPS })).toThrow(/name of a Status option/);
    expect(() => new SwfSettings({ projectStatus: { inProgress: "", inReview: "Review", done: "Done" }, steps: STEPS })).toThrow(/name of a Status option/);
    expect(() => new SwfSettings({ mergeMethod: "fast-forward" as never, steps: STEPS })).toThrow(/must be one of squash, merge, rebase/);
  });
});
