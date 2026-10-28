import { describe, expect, it } from "vitest";
import { SwfSettings } from "./swf-settings.value-object.ts";

const SKILLS = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", gate: "swf-gate", pr: "swf-pr" };

describe("SwfSettings", () => {
  it("has Claude Code's default model and no paths without those fields, and the skill of every agent step as hunt.json names them", () => {
    expect(new SwfSettings({ skills: SKILLS }).toJSON()).toEqual({ model: null, humanReviewPaths: [], skills: SKILLS });
  });

  it("keeps the skills in the order of the steps", () => {
    const skills = { gate: "acme-gate", pr: "swf-pr", plan: "acme-plan", verify: "swf-verify", implement: "swf-implement" };
    const settings = new SwfSettings({ model: "claude-opus-5-5", humanReviewPaths: ["**/migrations/**"], skills });
    expect(settings.model).toBe("claude-opus-5-5");
    expect(settings.humanReviewPaths).toEqual(["**/migrations/**"]);
    expect(settings.skills).toEqual({ plan: "acme-plan", implement: "swf-implement", verify: "swf-verify", gate: "acme-gate", pr: "swf-pr" });
    expect(Object.keys(settings.skills)).toEqual(["plan", "implement", "verify", "gate", "pr"]);
    expect(new SwfSettings(settings.toJSON()).isEqualTo(settings)).toBe(true);
  });

  it("rejects skills that leave out an agent step, name a step without an agent or break the name rule", () => {
    const withoutGate: Record<string, string> = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", pr: "swf-pr" };
    expect(() => new SwfSettings({ skills: withoutGate })).toThrow();
    const pollerStepSkills: Record<string, string> = { ...SKILLS, review: "swf-review" };
    expect(() => new SwfSettings({ skills: pollerStepSkills })).toThrow();
    expect(() => new SwfSettings({ skills: { ...SKILLS, gate: "Swf Gate" } })).toThrow(/kebab-case name of a skill/);
  });

  it("rejects a model alias and an invalid glob pattern", () => {
    expect(() => new SwfSettings({ model: "opus", skills: SKILLS })).toThrow(/full ID of a Claude model/);
    expect(() => new SwfSettings({ humanReviewPaths: ["/etc/hosts"], skills: SKILLS })).toThrow(/must be a glob pattern relative to the worktree/);
  });
});
