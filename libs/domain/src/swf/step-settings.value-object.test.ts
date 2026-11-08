import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RETURNS,
  DEFAULT_MERGE_METHOD,
  DEFAULT_MIN_SEVERITY,
  DEFAULT_PROJECT_STATUS,
  DEFAULT_QUESTION_PREFIX,
  isReturningStep,
  isScoringStep,
  RETURNING_STEPS,
  StepSettings,
} from "./step-settings.value-object.ts";
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
    expect(settings.of("implement")).toEqual({ skill: SKILLS.implement, model: null, effort: null, maxReturns: null, minSeverity: null, gate: IMPLEMENT_GATE });
    expect(settings.of("pr-gate")).toEqual({ skill: null, model: null, effort: null, maxReturns: DEFAULT_MAX_RETURNS["pr-gate"], minSeverity: null, gate: [] });
    expect(settings.of("review")).toEqual({ skill: SKILLS.review, model: null, effort: null, maxReturns: DEFAULT_MAX_RETURNS.review, minSeverity: DEFAULT_MIN_SEVERITY, gate: [] });
  });

  it("parses settings a VM reported before minSeverity existed, with none", () => {
    const plain = SETTINGS.toJSON();
    const { minSeverity: _minSeverity, ...review } = plain.steps.review;
    const settings = new StepSettings({ ...plain, steps: { ...plain.steps, review } });
    expect(settings.of("review").minSeverity).toBeNull();
    expect(settings.minSeverityOf("review")).toBe(DEFAULT_MIN_SEVERITY);
    expect(settingsWith({ verify: { minSeverity: 5 } }).minSeverityOf("verify")).toBe(5);
  });

  it("drops the settings of the retired step checks, which a VM of an earlier release reported", () => {
    const plain = SETTINGS.toJSON();
    const checks = { skill: null, model: null, effort: null, maxReturns: 2, minSeverity: null, gate: [] };
    const settings = new StepSettings({ ...plain, steps: { ...plain.steps, checks } as typeof plain.steps });
    expect(Object.keys(settings.steps)).toEqual([...SWF_STEPS]);
    expect(settings.isEqualTo(SETTINGS)).toBe(true);
  });

  it("parses settings a VM reported before the workflow settings existed, with Hunt's, and keeps a repository's own", () => {
    const { questionPrefix: _prefix, projectStatus: _status, mergeMethod: _method, ...plain } = SETTINGS.toJSON();
    const settings = new StepSettings(plain);
    expect(settings).toMatchObject({ questionPrefix: DEFAULT_QUESTION_PREFIX, projectStatus: DEFAULT_PROJECT_STATUS, mergeMethod: DEFAULT_MERGE_METHOD });
    expect(settings.toJSON()).toMatchObject({ questionPrefix: "❓ RÜCKFRAGE", projectStatus: { inProgress: "In Progress", inReview: "In Review", done: "Done" }, mergeMethod: "squash" });
    expect(settings.isEqualTo(SETTINGS)).toBe(true);
    const own = { questionPrefix: "❓ QUESTION", projectStatus: { inProgress: "Doing", inReview: "Review", done: "Shipped" }, mergeMethod: "rebase" as const };
    const kept = new StepSettings({ ...plain, ...own });
    expect(kept.toJSON()).toMatchObject(own);
    expect(new StepSettings(kept.toJSON()).isEqualTo(kept)).toBe(true);
    expect(kept.isEqualTo(SETTINGS)).toBe(false);
  });

  it("rejects settings without every step, with an unknown step, a limit below 1, an empty name, an unknown effort, a severity off the scale or an unknown merge method", () => {
    const plain = SETTINGS.toJSON();
    const { pr: _pr, ...withoutPr } = plain.steps;
    const invalid: unknown[] = [
      { steps: plain.steps },
      { ...plain, maxGateRuns: 0 },
      { ...plain, questionPrefix: "" },
      { ...plain, projectStatus: { inProgress: "Doing", inReview: "Review" } },
      { ...plain, projectStatus: { ...plain.projectStatus, done: "" } },
      { ...plain, mergeMethod: "fast-forward" },
      { ...plain, mergeMethod: null },
      { ...plain, steps: withoutPr },
      { ...plain, steps: { ...plain.steps, gate: plain.steps.pr } },
      { ...plain, steps: { ...plain.steps, verify: { ...plain.steps.verify, maxReturns: 0 } } },
      { ...plain, steps: { ...plain.steps, plan: { ...plain.steps.plan, skill: "" } } },
      { ...plain, steps: { ...plain.steps, plan: { ...plain.steps.plan, model: "" } } },
      { ...plain, steps: { ...plain.steps, plan: { ...plain.steps.plan, effort: "extreme" } } },
      { ...plain, steps: { ...plain.steps, implement: { ...plain.steps.implement, gate: [""] } } },
      { ...plain, steps: { ...plain.steps, review: { ...plain.steps.review, minSeverity: 0 } } },
      { ...plain, steps: { ...plain.steps, review: { ...plain.steps.review, minSeverity: 6 } } },
      { ...plain, steps: { ...plain.steps, review: { ...plain.steps.review, minSeverity: 2.5 } } },
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

  it("tells the scoring steps, verify and review only", () => {
    expect(["verify", "review"].every(isScoringStep)).toBe(true);
    expect([...POLLER_STEPS, "plan", "implement", "pr", "gate"].some(isScoringStep)).toBe(false);
  });
});
