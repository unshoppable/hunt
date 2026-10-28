import { describe, expect, it } from "vitest";
import {
  adrGuardrails,
  adrNumber,
  agentGuardrails,
  guardrailDeleteTarget,
  guardrailPath,
  guardrailTemplate,
  isGuardrailMarkdown,
  isSkillFolder,
  markdownFileNames,
  nextAdrNumber,
  ruleGuardrail,
  skillGuardrail,
  slugify,
} from "./guardrail-paths.utils";
import { adr, listing, rule } from "./guardrail.fixtures";

describe("slugify", () => {
  it("lowercases, strips accents and joins words with dashes", () => {
    expect(slugify("Use Postgres for Sessions!")).toBe("use-postgres-for-sessions");
    expect(slugify("  Größe & Höhe ")).toBe("grosse-hohe");
  });

  it("is empty when nothing usable is left", () => {
    expect(slugify("???")).toBe("");
  });
});

describe("adrNumber", () => {
  it("reads the leading number of common ADR file names", () => {
    expect(adrNumber("0007-use-postgres")).toBe(7);
    expect(adrNumber("12_record-architecture-decisions")).toBe(12);
    expect(adrNumber("template")).toBeNull();
  });
});

describe("nextAdrNumber", () => {
  it("starts at 1 and continues after the highest existing number", () => {
    expect(nextAdrNumber([])).toBe(1);
    expect(nextAdrNumber([adr("0001-a"), adr("0009-b"), adr("notes")])).toBe(10);
  });

  it("never gives the number of a deleted ADR again", () => {
    expect(nextAdrNumber([adr("0001-a")], ["0003-replaced.md", "README.md"])).toBe(4);
    expect(guardrailPath("adr", "Use Postgres", listing([adr("0001-a")], {}, { deletedAdrs: ["0002-replaced.md"] }))).toBe(".claude/resources/adrs/0003-use-postgres.md");
  });
});

describe("guardrailPath", () => {
  it("places each kind where Claude Code and the ADR convention expect it by default", () => {
    expect(guardrailPath("rule", "No console logs", listing())).toBe(".claude/rules/no-console-logs.md");
    expect(guardrailPath("skill", "Deploy Staging", listing())).toBe(".claude/skills/deploy-staging/SKILL.md");
    expect(guardrailPath("agent", "Code Reviewer", listing())).toBe(".claude/agents/code-reviewer.md");
    expect(guardrailPath("adr", "Use Postgres", listing([adr("0003-x")]))).toBe(".claude/resources/adrs/0004-use-postgres.md");
    expect(guardrailPath("rule", "Naming", listing(), { folder: "api/http" })).toBe(".claude/rules/api/http/naming.md");
    expect(guardrailPath("rule", "Naming", listing(), { dir: "src/api/.claude/rules" })).toBe("src/api/.claude/rules/naming.md");
    expect(guardrailPath("skill", "Deploy", listing(), { dir: "src/api/.claude/skills" })).toBe("src/api/.claude/skills/deploy/SKILL.md");
  });

  it("follows the folders from the settings", () => {
    const custom = listing([adr("0003-x")], { rule: "docs/rules", skill: "tools/skills", agent: "tools/agents", adr: "docs/decisions" });
    expect(guardrailPath("rule", "No console logs", custom)).toBe("docs/rules/no-console-logs.md");
    expect(guardrailPath("skill", "Deploy Staging", custom)).toBe("tools/skills/deploy-staging/SKILL.md");
    expect(guardrailPath("agent", "Code Reviewer", custom)).toBe("tools/agents/code-reviewer.md");
    expect(guardrailPath("adr", "Use Postgres", custom)).toBe("docs/decisions/0004-use-postgres.md");
  });

  it("puts a CLAUDE.md into the folder typed in, or at the root when none is", () => {
    expect(guardrailPath("instruction", "", listing())).toBe("CLAUDE.md");
    expect(guardrailPath("instruction", " ./src/api/ ", listing())).toBe("src/api/CLAUDE.md");
    expect(guardrailPath("instruction", "../outside", listing())).toBeNull();
  });

  it("is null when the title yields no file name", () => {
    expect(guardrailPath("rule", "???", listing())).toBeNull();
    expect(guardrailPath("adr", "", listing())).toBeNull();
  });
});

describe("guardrailTemplate", () => {
  it("fills in the title, the skill name and the ADR number and date", () => {
    expect(guardrailTemplate("instruction", "", listing())).toMatch(/^# Project instructions\n/);
    expect(guardrailTemplate("instruction", " ./src/api/ ", listing())).toMatch(/^# Instructions for src\/api\n/);
    expect(guardrailTemplate("rule", "No console logs", listing())).toMatch(/^# No console logs\n/);
    expect(guardrailTemplate("skill", "Deploy Staging", listing())).toContain("name: deploy-staging");
    expect(guardrailTemplate("agent", "Code Reviewer", listing())).toMatch(/^---\nname: code-reviewer\ndescription: \n---\n\n# Code Reviewer\n/);
    const adrText = guardrailTemplate("adr", "Use Postgres", listing([adr("0003-x")]), new Date("2026-10-11T10:00:00Z"));
    expect(adrText).toMatch(/^# 4\. Use Postgres\n\nDate: 2026-10-11\n/);
    expect(adrText).toContain("## Consequences");
    expect(adrText).not.toContain("## Status");
  });
});

describe("guardrailDeleteTarget", () => {
  it("removes a skill's whole folder and any other guardrail's file", () => {
    expect(guardrailDeleteTarget({ kind: "skill", path: ".claude/skills/deploy/SKILL.md", name: "deploy", folder: "" })).toBe(".claude/skills/deploy");
    expect(guardrailDeleteTarget(rule("frontend", "react"))).toBe(".claude/rules/frontend/react.md");
  });
});

describe("markdownFileNames", () => {
  it("keeps the Markdown files of a folder, its README and subfolders excluded", () => {
    const entries = [
      { name: "0001-use-zod.md", isDir: false },
      { name: "README.md", isDir: false },
      { name: "readme.MD", isDir: false },
      { name: "drafts.md", isDir: true },
      { name: "notes.txt", isDir: false },
      { name: "Upper.MD", isDir: false },
    ];
    expect(markdownFileNames(entries)).toEqual(["0001-use-zod.md", "Upper.MD"]);
    expect(isGuardrailMarkdown("guide.md")).toBe(true);
    expect(isGuardrailMarkdown("Readme.md")).toBe(false);
  });
});

describe("ruleGuardrail", () => {
  it("names a rule after its file and groups it by the folders below the rules directory", () => {
    expect(ruleGuardrail(".claude/rules", ".claude/rules/frontend/forms/validation.md")).toEqual(rule("frontend/forms", "validation"));
    expect(ruleGuardrail("src/.claude/rules", "src/.claude/rules/sql.md")).toEqual({ kind: "rule", path: "src/.claude/rules/sql.md", name: "sql", folder: "" });
  });
});

describe("isSkillFolder", () => {
  it("takes a folder with a SKILL.md for a skill", () => {
    expect(isSkillFolder([{ name: "SKILL.md", isDir: false }, { name: "scripts", isDir: true }])).toBe(true);
    expect(isSkillFolder([{ name: "skill.md", isDir: false }])).toBe(false);
    expect(skillGuardrail(".claude/skills", "deploy")).toEqual({ kind: "skill", path: ".claude/skills/deploy/SKILL.md", name: "deploy", folder: "" });
  });
});

describe("agentGuardrails", () => {
  it("names agents after their files, sorted by name", () => {
    expect(agentGuardrails(".claude/agents", ["writer.md", "reviewer.md"]).map((agent) => agent.path)).toEqual([".claude/agents/reviewer.md", ".claude/agents/writer.md"]);
  });
});

describe("adrGuardrails", () => {
  it("lists the highest number first, then ADRs without a number by name", () => {
    const names = ["0002-b.md", "template.md", "0010-c.md", "0001-a.md", "notes.md"];
    expect(adrGuardrails(".claude/resources/adrs", names).map((guardrail) => guardrail.name)).toEqual(["0010-c", "0002-b", "0001-a", "notes", "template"]);
    expect(adrGuardrails(".claude/resources/adrs", ["0001-a.md"])).toEqual([adr("0001-a")]);
  });
});
