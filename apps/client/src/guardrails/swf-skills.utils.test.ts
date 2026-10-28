import { describe, expect, it } from "vitest";
import type { SwfStepEntry } from "./guardrail.types";
import { missingSwfSkills, swfSkillFile, swfSkillName, swfSkillsQuestion, type SwfSkillGap } from "./swf-skills.utils";

const CONFIGURED: SwfStepEntry[] = [
  { step: "plan", name: "swf-plan" },
  { step: "implement", name: "swf-implement" },
  { step: "verify", name: "swf-verify" },
  { step: "gate", name: "acme-gate" },
  { step: "pr", name: "swf-pr" },
];
const ALL_FILES = new Set(CONFIGURED.map(swfSkillName));

describe("swfSkillName", () => {
  it("is the name the entry sets, else the proposed one", () => {
    expect(swfSkillName({ step: "gate", name: "acme-gate" })).toBe("acme-gate");
    expect(swfSkillName({ step: "gate", name: null })).toBe("swf-gate");
  });
});

describe("missingSwfSkills", () => {
  it("is empty once every step has its entry and its file", () => {
    expect(missingSwfSkills(CONFIGURED, ALL_FILES)).toEqual([]);
  });

  it("lists a step without an entry under the proposed name, also when that file exists", () => {
    const entries: SwfStepEntry[] = [...CONFIGURED];
    entries[0] = { step: "plan", name: null };
    expect(missingSwfSkills(entries, new Set([...ALL_FILES, "swf-plan"]))).toEqual([{ step: "plan", name: "swf-plan", addEntry: true, missingFile: false }]);
  });

  it("lists every step whose skill file is missing, in the order of the steps", () => {
    expect(missingSwfSkills(CONFIGURED, new Set(["swf-implement", "swf-pr", "guardrail"]))).toEqual([
      { step: "plan", name: "swf-plan", addEntry: false, missingFile: true },
      { step: "verify", name: "swf-verify", addEntry: false, missingFile: true },
      { step: "gate", name: "acme-gate", addEntry: false, missingFile: true },
    ]);
  });

  it("lists a step that lacks both its entry and the file of the proposed name", () => {
    const entries: SwfStepEntry[] = [...CONFIGURED];
    entries[4] = { step: "pr", name: null };
    expect(missingSwfSkills(entries, new Set(["swf-plan", "swf-implement", "swf-verify", "acme-gate"]))).toEqual([
      { step: "pr", name: "swf-pr", addEntry: true, missingFile: true },
    ]);
  });

  it("lists a missing file several steps share once, under the first of them", () => {
    const shared: SwfStepEntry[] = [
      { step: "plan", name: "team-flow" },
      { step: "implement", name: "team-flow" },
      { step: "gate", name: "swf-gate" },
    ];
    expect(missingSwfSkills(shared, new Set())).toEqual([
      { step: "plan", name: "team-flow", addEntry: false, missingFile: true },
      { step: "gate", name: "swf-gate", addEntry: false, missingFile: true },
    ]);
  });
});

describe("swfSkillsQuestion", () => {
  const entryGap: SwfSkillGap = { step: "plan", name: "swf-plan", addEntry: true, missingFile: false };
  const fileGap: SwfSkillGap = { step: "gate", name: "acme-gate", addEntry: false, missingFile: true };
  const bothGap: SwfSkillGap = { step: "pr", name: "swf-pr", addEntry: true, missingFile: true };

  it("names each step with what it lacks and asks for both the entries and the files", () => {
    expect(swfSkillsQuestion([entryGap, fileGap, bothGap])).toBe(
      "This repository uses Hunt's software factory (the swf section of its hunt.json), but not every agent step has its skill:\n\n" +
        "• plan: no entry swf.skills.plan in hunt.json (proposed: swf-plan)\n" +
        "• gate: no skill file .claude/skills/acme-gate/SKILL.md\n" +
        "• pr: no entry swf.skills.pr in hunt.json (proposed: swf-pr) and no skill file .claude/skills/swf-pr/SKILL.md\n\n" +
        "Add the missing entries to hunt.json and create the missing skills from Hunt's templates? " +
        "Each template is for the repository to fill in; existing entries and skill files are kept.",
    );
  });

  it("asks only for the entries when every file exists", () => {
    expect(swfSkillsQuestion([entryGap])).toContain("(proposed: swf-plan)\n\nAdd the missing entries to hunt.json? Existing entries and skill files are kept.");
  });

  it("asks only for the files when every entry exists", () => {
    expect(swfSkillsQuestion([fileGap])).toContain(
      "SKILL.md\n\nCreate the missing skills from Hunt's templates? Each template is for the repository to fill in; existing entries and skill files are kept.",
    );
  });
});

describe("swfSkillFile", () => {
  it("lies in the skills directory Claude Code reads", () => {
    expect(swfSkillFile("swf-verify")).toBe(".claude/skills/swf-verify/SKILL.md");
  });
});
