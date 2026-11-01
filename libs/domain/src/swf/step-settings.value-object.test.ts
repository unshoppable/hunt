import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RETURNS, isReturningStep, RETURNING_STEPS, StepSettings } from "./step-settings.value-object.ts";
import { POLLER_STEPS, SWF_STEPS } from "./swf-step.types.ts";
import { IMPLEMENT_GATE, SETTINGS, settingsWith, SKILLS } from "./swf.fixtures.ts";

describe("StepSettings", () => {
  it("parses the settings of every step, in the order of the steps, and serializes them as they came", () => {
    const plain = SETTINGS.toJSON();
    const reversed = Object.fromEntries(Object.entries(plain.steps).reverse());
    const settings = new StepSettings({ ...plain, steps: reversed as typeof plain.steps });
    expect(Object.keys(settings.steps)).toEqual([...SWF_STEPS]);
    expect(JSON.parse(JSON.stringify(settings))).toEqual(plain);
    expect(settings.isEqualTo(SETTINGS)).toBe(true);
    expect(settings.of("implement")).toEqual({ skill: SKILLS.implement, model: null, effort: null, maxReturns: null, gate: IMPLEMENT_GATE });
    expect(settings.of("checks")).toEqual({ skill: null, model: null, effort: null, maxReturns: DEFAULT_MAX_RETURNS.checks, gate: [] });
  });

  it("rejects settings without every step, with an unknown step, a limit below 1, an empty name or an unknown effort", () => {
    const plain = SETTINGS.toJSON();
    const { pr: _pr, ...withoutPr } = plain.steps;
    const invalid: unknown[] = [
      { steps: plain.steps },
      { ...plain, maxGateRuns: 0 },
      { ...plain, steps: withoutPr },
      { ...plain, steps: { ...plain.steps, gate: plain.steps.pr } },
      { ...plain, steps: { ...plain.steps, verify: { ...plain.steps.verify, maxReturns: 0 } } },
      { ...plain, steps: { ...plain.steps, plan: { ...plain.steps.plan, skill: "" } } },
      { ...plain, steps: { ...plain.steps, plan: { ...plain.steps.plan, model: "" } } },
      { ...plain, steps: { ...plain.steps, plan: { ...plain.steps.plan, effort: "extreme" } } },
      { ...plain, steps: { ...plain.steps, implement: { ...plain.steps.implement, gate: [""] } } },
    ];
    for (const value of invalid) {
      expect(StepSettings.schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("names the skill of an agent step and throws for a step without one", () => {
    expect(SETTINGS.skillOf("review")).toBe(SKILLS.review);
    const settings = settingsWith({ review: { skill: null }, pr: { skill: null } });
    expect(() => settings.skillOf("review")).toThrow("the step review names no skill");
    expect(settings.stepsWithoutSkill).toEqual(["review", "pr"]);
    expect(SETTINGS.stepsWithoutSkill).toEqual([]);
  });

  it("gives the config options of an agent step's conversation, model and effort only where set", () => {
    const settings = settingsWith({ plan: { model: "claude-opus-5-5", effort: "max" }, verify: { effort: "low" }, review: { model: "claude-sonnet-5" } });
    expect(settings.configOptionsOf("plan")).toEqual({ model: "claude-opus-5-5", effort: "max" });
    expect(settings.configOptionsOf("verify")).toEqual({ effort: "low" });
    expect(settings.configOptionsOf("review")).toEqual({ model: "claude-sonnet-5" });
    expect(settings.configOptionsOf("pr")).toEqual({});
  });

  it("gives the limit of returns of a returning step and none for the other steps", () => {
    for (const step of RETURNING_STEPS) {
      expect(SETTINGS.limitOf(step), step).toBe(DEFAULT_MAX_RETURNS[step]);
    }
    expect(SETTINGS.limitOf("implement")).toBeNull();
    expect(settingsWith({ merge: { maxReturns: 9 } }).limitOf("merge")).toBe(9);
  });

  it("tells the returning steps, every poller step among them", () => {
    expect(POLLER_STEPS.every(isReturningStep)).toBe(true);
    expect(["verify", "review"].every(isReturningStep)).toBe(true);
    expect(["plan", "implement", "pr", "gate"].some(isReturningStep)).toBe(false);
  });
});
