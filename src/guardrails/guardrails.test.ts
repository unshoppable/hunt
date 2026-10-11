import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDRAIL_DIRS, type GuardrailDirs } from "../state/settings";
import { adrNumber, creationTask, expandedForInstructions, foldersOf, generationTask, guardrailDeleteTarget, guardrailListRows, guardrailPath, guardrailTemplate, instructionTreeRows, isInsideFolder, kindHelp, nextAdrNumber, slugify, type Guardrail, type GuardrailListing } from "./guardrails";

const adr = (name: string): Guardrail => ({ kind: "adr", path: `docs/adr/${name}.md`, name, folder: "" });
const instruction = (folder: string): Guardrail => ({ kind: "instruction", path: folder ? `${folder}/CLAUDE.md` : "CLAUDE.md", name: "CLAUDE.md", folder: "" });
const rule = (folder: string, name: string): Guardrail => ({ kind: "rule", path: `.claude/rules/${folder ? `${folder}/` : ""}${name}.md`, name, folder });
const listing = (adrs: Guardrail[] = [], dirs: Partial<GuardrailDirs> = {}): GuardrailListing => ({ instruction: [], rule: [], skill: [], agent: [], adr: adrs, dirs: { ...DEFAULT_GUARDRAIL_DIRS, ...dirs }, folders: [] });

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
});

describe("guardrailPath", () => {
  it("places each kind where Claude Code and the ADR convention expect it by default", () => {
    expect(guardrailPath("rule", "No console logs", listing())).toBe(".claude/rules/no-console-logs.md");
    expect(guardrailPath("skill", "Deploy Staging", listing())).toBe(".claude/skills/deploy-staging/SKILL.md");
    expect(guardrailPath("agent", "Code Reviewer", listing())).toBe(".claude/agents/code-reviewer.md");
    expect(guardrailPath("adr", "Use Postgres", listing([adr("0003-x")]))).toBe("docs/adr/0004-use-postgres.md");
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

describe("guardrailListRows", () => {
  it("groups entries under sorted folders, placed before the loose entries of their level", () => {
    const rows = guardrailListRows([rule("", "zeta"), rule("frontend", "react"), rule("backend", "sql"), rule("frontend/forms", "validation"), rule("", "alpha")]);
    expect(rows.map((row) => (row.type === "folder" ? `${"  ".repeat(row.depth)}${row.name}/` : `${"  ".repeat(row.depth)}${row.entry.name}`))).toEqual([
      "backend/",
      "  sql",
      "frontend/",
      "  forms/",
      "    validation",
      "  react",
      "zeta",
      "alpha",
    ]);
  });

  it("leaves out everything below a collapsed folder", () => {
    const rows = guardrailListRows([rule("frontend", "react"), rule("frontend/forms", "validation"), rule("", "alpha")], new Set(["frontend"]));
    expect(rows.map((row) => (row.type === "folder" ? row.folder : row.entry.name))).toEqual(["frontend", "alpha"]);
  });
});

describe("guardrailDeleteTarget", () => {
  it("removes a skill's whole folder and any other guardrail's file", () => {
    expect(guardrailDeleteTarget({ kind: "skill", path: ".claude/skills/deploy/SKILL.md", name: "deploy", folder: "" })).toBe(".claude/skills/deploy");
    expect(guardrailDeleteTarget(rule("frontend", "react"))).toBe(".claude/rules/frontend/react.md");
  });
});

describe("isInsideFolder", () => {
  it("matches paths below the folder, not the folder itself or a sibling with the same prefix", () => {
    expect(isInsideFolder(".claude/skills/weq/CLAUDE.md", ".claude/skills/weq")).toBe(true);
    expect(isInsideFolder(".claude/skills/weq", ".claude/skills/weq")).toBe(false);
    expect(isInsideFolder(".claude/skills/weq2/CLAUDE.md", ".claude/skills/weq")).toBe(false);
    expect(isInsideFolder("CLAUDE.md", "")).toBe(true);
  });
});

describe("generationTask", () => {
  const kinds = ["instruction", "rule", "skill", "agent", "adr"] as const;

  it("asks every kind for the shortest file that still says what is needed", () => {
    for (const kind of kinds) {
      const task = generationTask(kind, "some/file.md");
      expect(task).toContain("as short as possible and as long as necessary");
      expect(task).toContain("`some/file.md`");
    }
  });

  it("makes the rule front matter optional and leaves Status out of the ADR sections", () => {
    expect(generationTask("rule", ".claude/rules/api.md")).toContain("Without a front matter it is loaded on every turn");
    expect(generationTask("adr", "docs/adr/0001-x.md")).toContain("sections Context, Decision and Consequences");
    expect(generationTask("adr", "docs/adr/0001-x.md")).not.toContain("Status");
  });

  it("lets the agent choose the name of a new file inside the kind's folder", () => {
    const task = creationTask("rule", listing([], { rule: "docs/rules" }));
    expect(task).toContain("`docs/rules/<name>.md`");
    expect(task).toContain("Choose <name> yourself");
    expect(task).toContain("as short as possible and as long as necessary");
    expect(creationTask("skill", listing())).toContain("`.claude/skills/<name>/SKILL.md`");
    expect(creationTask("adr", listing([adr("0007-use-postgres")]), new Date("2026-10-11T12:00:00Z"))).toContain("`docs/adr/0008-<name>.md`; the heading starts with the number 8 and the record is dated 2026-10-11");
  });

  it("names the folder a nested CLAUDE.md applies to", () => {
    expect(generationTask("instruction", "src/api/CLAUDE.md")).toContain("below `src/api`");
    expect(generationTask("instruction", "CLAUDE.md")).toContain("root CLAUDE.md");
  });
});

describe("kindHelp", () => {
  it("says when each kind is loaded and when to use it, without naming folders", () => {
    for (const kind of ["instruction", "rule", "skill", "agent", "adr"] as const) {
      const { what, loading, use } = kindHelp(kind);
      expect(what.length).toBeGreaterThan(0);
      expect(loading).toMatch(/load|read|available/);
      expect(use).toMatch(/^(Use|Write) /);
      expect(`${what} ${loading} ${use}`).not.toContain(".claude/");
    }
    expect(kindHelp("instruction").loading).toContain("subfolder");
  });
});

describe("foldersOf", () => {
  it("collects every folder on the way to each file, sorted, without the root", () => {
    expect(foldersOf(["CLAUDE.md", "src/api/users.ts", "src/index.ts", "docs/adr/0001.md"])).toEqual(["docs", "docs/adr", "src", "src/api"]);
  });
});

describe("expandedForInstructions", () => {
  it("opens the root and the folders leading to each CLAUDE.md", () => {
    expect([...expandedForInstructions([instruction(""), instruction("src/api/v2")])].sort()).toEqual(["", "src", "src/api", "src/api/v2"]);
  });
});

describe("instructionTreeRows", () => {
  const folders = ["docs", "src", "src/api", "src/ui"];
  const label = (row: ReturnType<typeof instructionTreeRows>[number]) => `${"  ".repeat(row.depth)}${row.type === "folder" ? `${row.name}/${row.hasInstruction ? "*" : ""}` : row.entry.path}`;

  it("lists subfolders before a folder's own CLAUDE.md and hides closed folders", () => {
    const rows = instructionTreeRows(folders, [instruction(""), instruction("src/api")], new Set(["", "src", "src/api"]), "harness");
    expect(rows.map(label)).toEqual(["harness/*", "  docs/", "  src/", "    api/*", "      src/api/CLAUDE.md", "    ui/", "  CLAUDE.md"]);
  });

  it("shows only the root when it is closed", () => {
    expect(instructionTreeRows(folders, [instruction("")], new Set(), "harness").map(label)).toEqual(["harness/*"]);
  });
});
