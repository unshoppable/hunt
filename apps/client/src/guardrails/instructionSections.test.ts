import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDRAIL_DIRS } from "./guardrails";
import { adrSection, guardrailsSection, hasAdrInstruction, hasGuardrailsInstruction, missingSections, withSections } from "./instructionSections";

describe("hasAdrInstruction", () => {
  it("recognizes the section heading", () => {
    expect(hasAdrInstruction("# Project\n\n## Architectural decisions\n\nSee docs.", "docs/adr")).toBe(true);
  });

  it("recognizes an existing reference to the ADR folder", () => {
    expect(hasAdrInstruction("Decisions live in `doc/decisions/`.", "doc/decisions")).toBe(true);
  });

  it("is false for an instruction file that never mentions ADRs", () => {
    expect(hasAdrInstruction("# Project\n\nRun `npm test`.", "docs/adr")).toBe(false);
    expect(hasAdrInstruction("", "docs/adr")).toBe(false);
  });
});

describe("hasGuardrailsInstruction", () => {
  it("recognizes the section heading only", () => {
    expect(hasGuardrailsInstruction("# Project\n\n## Guardrails\n\nRead them.")).toBe(true);
    expect(hasGuardrailsInstruction("# Project\n\nRules live in `.claude/rules/`.")).toBe(false);
  });
});

describe("missingSections", () => {
  it("lists the guardrails section before the ADR section", () => {
    const missing = missingSections("# Project", DEFAULT_GUARDRAIL_DIRS);
    expect(missing.map((section) => section.build(DEFAULT_GUARDRAIL_DIRS))).toEqual([
      guardrailsSection(DEFAULT_GUARDRAIL_DIRS),
      adrSection(DEFAULT_GUARDRAIL_DIRS.adr),
    ]);
  });

  it("leaves out the sections the file already holds", () => {
    const missing = missingSections(`# Project\n\n${adrSection(DEFAULT_GUARDRAIL_DIRS.adr)}`, DEFAULT_GUARDRAIL_DIRS);
    expect(missing.map((section) => section.build(DEFAULT_GUARDRAIL_DIRS))).toEqual([guardrailsSection(DEFAULT_GUARDRAIL_DIRS)]);
  });

  it("is empty once every missing section is appended", () => {
    const completed = withSections("# Project", missingSections("# Project", DEFAULT_GUARDRAIL_DIRS), DEFAULT_GUARDRAIL_DIRS);
    expect(missingSections(completed, DEFAULT_GUARDRAIL_DIRS)).toEqual([]);
  });
});

describe("withSections", () => {
  it("appends each section after one blank line and keeps the existing content", () => {
    const missing = missingSections("", DEFAULT_GUARDRAIL_DIRS);
    const result = withSections("# Project\n\nRun `npm test`.\n\n\n", missing, DEFAULT_GUARDRAIL_DIRS);
    expect(result).toBe(`# Project\n\nRun \`npm test\`.\n\n${guardrailsSection(DEFAULT_GUARDRAIL_DIRS)}\n\n${adrSection(DEFAULT_GUARDRAIL_DIRS.adr)}\n`);
  });

  it("holds the sections alone for a missing or empty file", () => {
    const missing = missingSections("", DEFAULT_GUARDRAIL_DIRS);
    expect(withSections("", missing, DEFAULT_GUARDRAIL_DIRS)).toBe(`${guardrailsSection(DEFAULT_GUARDRAIL_DIRS)}\n\n${adrSection(DEFAULT_GUARDRAIL_DIRS.adr)}\n`);
  });

  it("names the configured folders", () => {
    const dirs = { rule: "config/rules", skill: "config/skills", agent: "config/agents", adr: "doc/decisions" };
    const guardrails = guardrailsSection(dirs);
    expect(guardrails).toContain("`config/rules/*.md`");
    expect(guardrails).toContain("`config/skills/<name>/SKILL.md`");
    expect(guardrails).toContain("`config/agents/<name>.md`");
    expect(guardrails).toContain("`doc/decisions/NNNN-title.md`");
    const adr = adrSection("doc/decisions");
    expect(adr).toContain("`ls doc/decisions/`");
    expect(adr).toContain("`grep -ril <topic> doc/decisions/`");
    expect(adr).toContain("`doc/decisions/NNNN-title.md`");
  });
});
