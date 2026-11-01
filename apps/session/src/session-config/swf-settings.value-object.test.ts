import { describe, expect, it } from "vitest";
import { SwfSettings } from "./swf-settings.value-object.ts";

const SKILLS = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", review: "swf-review", pr: "swf-pr" };

describe("SwfSettings", () => {
  it("has Claude Code's default model without the field, and the skill of every agent step as hunt.json names them", () => {
    expect(new SwfSettings({ skills: SKILLS }).toJSON()).toEqual({ model: null, skills: SKILLS });
  });

  it("keeps the skills in the order of the steps", () => {
    const skills = { review: "acme-review", pr: "swf-pr", plan: "acme-plan", verify: "swf-verify", implement: "swf-implement" };
    const settings = new SwfSettings({ model: "claude-opus-5-5", skills });
    expect(settings.model).toBe("claude-opus-5-5");
    expect(settings.skills).toEqual({ plan: "acme-plan", implement: "swf-implement", verify: "swf-verify", review: "acme-review", pr: "swf-pr" });
    expect(Object.keys(settings.skills)).toEqual(["plan", "implement", "verify", "review", "pr"]);
    expect(new SwfSettings(settings.toJSON()).isEqualTo(settings)).toBe(true);
  });

  it("rejects skills that leave out an agent step, name a step without an agent or break the name rule", () => {
    const withoutReview: Record<string, string> = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", pr: "swf-pr" };
    expect(() => new SwfSettings({ skills: withoutReview })).toThrow();
    const pollerStepSkills: Record<string, string> = { ...SKILLS, checks: "swf-checks" };
    expect(() => new SwfSettings({ skills: pollerStepSkills })).toThrow();
    expect(() => new SwfSettings({ skills: { ...SKILLS, review: "Swf Review" } })).toThrow(/kebab-case name of a skill/);
  });

  it("rejects a model alias", () => {
    expect(() => new SwfSettings({ model: "opus", skills: SKILLS })).toThrow(/full ID of a Claude model/);
  });
});
