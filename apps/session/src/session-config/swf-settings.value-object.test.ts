import { describe, expect, it } from "vitest";
import { SWF_STEPS } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { SwfSettings } from "./swf-settings.value-object.ts";

/** Every agent step with its skill, as `swf.steps` names them. */
const STEPS = { plan: { skill: "swf-plan" }, implement: { skill: "swf-implement" }, verify: { skill: "swf-verify" }, review: { skill: "swf-review" }, pr: { skill: "swf-pr" } };
const CHECKS = ["format", "lint", "test"];
const UNSET = { model: null, effort: null };

describe("SwfSettings", () => {
  it("resolves Hunt's defaults for every step: no model or effort, the limits of returns, every check as the gate of implement", () => {
    const settings = new SwfSettings({ steps: STEPS });
    expect(settings.toJSON()).toMatchObject({ model: null, effort: null, maxGateRuns: 5 });
    const resolved = settings.resolve(CHECKS);
    expect(resolved.maxGateRuns).toBe(5);
    expect(Object.keys(resolved.steps)).toEqual([...SWF_STEPS]);
    expect(resolved.steps).toEqual({
      plan: { skill: "swf-plan", ...UNSET, maxReturns: null, gate: [] },
      implement: { skill: "swf-implement", ...UNSET, maxReturns: null, gate: CHECKS },
      verify: { skill: "swf-verify", ...UNSET, maxReturns: 5, gate: [] },
      review: { skill: "swf-review", ...UNSET, maxReturns: 3, gate: [] },
      pr: { skill: "swf-pr", ...UNSET, maxReturns: null, gate: [] },
      checks: { skill: null, ...UNSET, maxReturns: 2, gate: [] },
      "human-review": { skill: null, ...UNSET, maxReturns: 3, gate: [] },
      merge: { skill: null, ...UNSET, maxReturns: 2, gate: [] },
    });
  });

  it("lets a step's model, effort and limit of returns win over the section's and Hunt's", () => {
    const steps = { ...STEPS, implement: { skill: "swf-implement", model: "claude-sonnet-5-5", effort: "medium" as const }, verify: { skill: "swf-verify", maxReturns: 9 } };
    const resolved = new SwfSettings({ model: "claude-opus-5-5", effort: "high", maxGateRuns: 2, steps: { ...steps, merge: { maxReturns: 1 } } }).resolve([]);
    expect(resolved.maxGateRuns).toBe(2);
    expect(resolved.of("plan")).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(resolved.of("implement")).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", gate: [] });
    expect(resolved.of("verify").maxReturns).toBe(9);
    expect(resolved.of("merge")).toEqual({ skill: null, ...UNSET, maxReturns: 1, gate: [] });
  });

  it("expands a gate in the order of hunt.json's checks: * for every check, a list for the checks it names, [] for none", () => {
    const gated = (implement: "*" | string[], review: "*" | string[]) =>
      new SwfSettings({ steps: { ...STEPS, implement: { skill: "swf-implement", gate: implement }, review: { skill: "swf-review", gate: review } } }).resolve(CHECKS);
    expect(gated([], "*").steps).toMatchObject({ implement: { gate: [] }, review: { gate: CHECKS } });
    expect(gated(["test", "format", "test"], ["lint"]).steps).toMatchObject({ implement: { gate: ["format", "test"] }, review: { gate: ["lint"] } });
    expect(new SwfSettings({ steps: STEPS }).gateChecks).toEqual([]);
    expect(new SwfSettings({ steps: { ...STEPS, implement: { skill: "swf-implement", gate: "*" }, verify: { skill: "swf-verify", gate: ["lint"] } } }).gateChecks).toEqual(["lint"]);
  });

  it("round-trips through its JSON", () => {
    const settings = new SwfSettings({ model: "claude-opus-5-5", steps: { ...STEPS, implement: { skill: "swf-implement", gate: ["lint"] } } });
    expect(new SwfSettings(settings.toJSON()).isEqualTo(settings)).toBe(true);
  });

  it("rejects an agent step without a skill, agent fields on a poller step and a limit of returns on a step that never sends the pipeline back", () => {
    const { review: _review, ...withoutReview } = STEPS;
    expect(() => new SwfSettings({ steps: withoutReview })).toThrow(/every agent step names its skill/);
    for (const checks of [{ skill: "swf-checks" }, { model: "claude-opus-5-5" }, { effort: "low" as const }, { gate: "*" as const }]) {
      expect(() => new SwfSettings({ steps: { ...STEPS, checks } })).toThrow(/only an agent step/);
    }
    expect(() => new SwfSettings({ steps: { ...STEPS, implement: { skill: "swf-implement", maxReturns: 2 } } })).toThrow(/only a returning step has maxReturns/);
  });

  it("rejects values that break their rules", () => {
    expect(() => new SwfSettings({ model: "opus", steps: STEPS })).toThrow(/full ID of a Claude model/);
    expect(() => new SwfSettings({ steps: { ...STEPS, review: { skill: "Swf Review" } } })).toThrow(/kebab-case name of a skill/);
    expect(() => new SwfSettings({ effort: "extreme" as never, steps: STEPS })).toThrow(/must be one of low, medium, high, xhigh, max/);
    expect(() => new SwfSettings({ maxGateRuns: 0, steps: STEPS })).toThrow(/at least 1/);
    expect(() => new SwfSettings({ steps: { ...STEPS, verify: { skill: "swf-verify", maxReturns: 21 } } })).toThrow(/from 1 to 20/);
  });
});
