import { describe, expect, it } from "vitest";
import { adrDirOf, adrNumber, creationTask, DEFAULT_GUARDRAIL_DIRS, expandedForTree, foldersOf, generationTask, guardrailDeleteTarget, guardrailListRows, guardrailPath, guardrailTask, guardrailTemplate, guardrailTreeRows, kindHelp, newGuardrailLocation, nextAdrNumber, normalizeGuardrailDir, ownerFolderOf, slugify, treeFolders, type Guardrail, type GuardrailDirs, type GuardrailListing } from "./guardrails";

const adr = (name: string): Guardrail => ({ kind: "adr", path: `.claude/resources/adrs/${name}.md`, name, folder: "" });
const instruction = (folder: string): Guardrail => ({ kind: "instruction", path: folder ? `${folder}/CLAUDE.md` : "CLAUDE.md", name: "CLAUDE.md", folder: "" });
const rule = (folder: string, name: string): Guardrail => ({ kind: "rule", path: `.claude/rules/${folder ? `${folder}/` : ""}${name}.md`, name, folder });
const skill = (dir: string, name: string): Guardrail => ({ kind: "skill", path: `${dir}/${name}/SKILL.md`, name, folder: "" });
const listing = (adrs: Guardrail[] = [], dirs: Partial<GuardrailDirs> = {}, more: Partial<GuardrailListing> = {}): GuardrailListing => ({
  instruction: [],
  rule: [],
  skill: [],
  agent: [],
  adr: adrs,
  dirs: { ...DEFAULT_GUARDRAIL_DIRS, ...dirs },
  folders: [],
  foundDirs: { rule: [], skill: [] },
  deletedAdrs: [],
  ...more,
});

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
    expect(creationTask("rule", listing(), "", { folder: "api" })).toContain("Put it at `.claude/rules/api/<name>.md`.");
    const nested = creationTask("rule", listing(), "", { dir: "src/api/.claude/rules" });
    expect(nested).toContain("Put it at `src/api/.claude/rules/<name>.md`");
    expect(nested).toContain("The directory belongs to `src/api`");
    expect(creationTask("rule", listing())).not.toContain("The directory belongs to");
    expect(creationTask("instruction", listing(), "", { dir: "src/api" })).toContain("Put it at `src/api/CLAUDE.md`.");
    expect(creationTask("instruction", listing())).toContain("Put it at `CLAUDE.md`.");
    expect(creationTask("adr", listing([adr("0007-use-postgres")]), "", {}, new Date("2026-10-11T12:00:00Z"))).toContain("`.claude/resources/adrs/0008-<name>.md`; the heading starts with the number 8 and the record is dated 2026-10-11");
  });

  it("keeps the name the user typed", () => {
    const task = creationTask("skill", listing(), "Release Notes");
    expect(task).toContain("`.claude/skills/release-notes/SKILL.md`");
    expect(task).toContain("The user chose the name `release-notes`");
    expect(task).not.toContain("<name>");
  });

  it("names the folder a nested CLAUDE.md applies to", () => {
    expect(generationTask("instruction", "src/api/CLAUDE.md")).toContain("below `src/api`");
    expect(generationTask("instruction", "CLAUDE.md")).toContain("root CLAUDE.md");
  });
});

describe("guardrailTask", () => {
  it("offers every kind at its configured place and asks back while the kind is unclear", () => {
    const task = guardrailTask(listing([adr("0007-use-postgres")], { rule: "docs/rules" }), new Date("2026-10-11T12:00:00Z"));
    expect(task).toContain("- Instruction: a `CLAUDE.md`");
    expect(task).toContain("`docs/rules/<name>.md`");
    expect(task).toContain("`.claude/skills/<name>/SKILL.md`");
    expect(task).toContain("`.claude/agents/<name>.md`");
    expect(task).toContain("`.claude/resources/adrs/0008-<name>.md`; the heading starts with the number 8 and the record is dated 2026-10-11");
    expect(task).toContain("write nothing yet: ask one short question");
    expect(task).toContain("as short as possible and as long as necessary");
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

describe("ownerFolderOf", () => {
  it("names the folder whose .claude holds the directory", () => {
    expect(ownerFolderOf(".claude/rules", ".claude/rules")).toBe("");
    expect(ownerFolderOf("src/api/.claude/rules", ".claude/rules")).toBe("src/api");
    expect(ownerFolderOf("src/api/rules", ".claude/rules")).toBeNull();
    expect(ownerFolderOf(".claude", ".claude/rules")).toBeNull();
  });
});

describe("newGuardrailLocation", () => {
  const found = listing([], {}, { foundDirs: { rule: [".claude/rules", "src/api/.claude/rules"], skill: [] } });

  it("stays inside the kind directory a folder is or lies in", () => {
    expect(newGuardrailLocation("rule", ".claude/rules", found)).toEqual({ dir: ".claude/rules", folder: "" });
    expect(newGuardrailLocation("rule", ".claude/rules/backend/sql", found)).toEqual({ dir: ".claude/rules", folder: "backend/sql" });
    expect(newGuardrailLocation("rule", "src/api/.claude/rules", found)).toEqual({ dir: "src/api/.claude/rules", folder: "" });
  });

  it("starts a kind directory in any other folder, inside a .claude the one it leads to", () => {
    expect(newGuardrailLocation("rule", "src/ui", found)).toEqual({ dir: "src/ui/.claude/rules", folder: "" });
    expect(newGuardrailLocation("skill", "", found)).toEqual({ dir: ".claude/skills", folder: "" });
    expect(newGuardrailLocation("skill", ".claude", found)).toEqual({ dir: ".claude/skills", folder: "" });
    expect(newGuardrailLocation("skill", "src/api/.claude", found)).toEqual({ dir: "src/api/.claude/skills", folder: "" });
  });
});

describe("treeFolders", () => {
  const folders = [".claude", ".claude/agents", ".claude/rules", ".claude/skills", ".claude/skills/deploy", "src", "src/api", "src/api/.claude", "src/api/.claude/rules", "src/api/.claude/rules/http"];

  it("shows, inside a .claude, only the way to the kind's own directory and adds the way to ignored directories", () => {
    const found = listing([], {}, { folders, foundDirs: { rule: [".claude/rules", "src/api/.claude/rules", "lib/.claude/rules"], skill: [] } });
    expect(treeFolders("rule", found)).toEqual([
      ".claude",
      ".claude/rules",
      "lib",
      "lib/.claude",
      "lib/.claude/rules",
      "src",
      "src/api",
      "src/api/.claude",
      "src/api/.claude/rules",
      "src/api/.claude/rules/http",
    ]);
  });

  it("leaves out a .claude without the kind's directory and the folders of the skills themselves", () => {
    const found = listing([], {}, { folders, foundDirs: { rule: [], skill: [".claude/skills"] } });
    expect(treeFolders("skill", found)).toEqual([".claude", ".claude/skills", "src", "src/api"]);
  });

  it("keeps every worktree folder for instructions", () => {
    expect(treeFolders("instruction", listing([], {}, { folders }))).toEqual(folders);
  });
});

describe("expandedForTree", () => {
  it("opens the root and the folders leading to each entry and directory", () => {
    expect([...expandedForTree([instruction(""), instruction("src/api/v2")])].sort()).toEqual(["", "src", "src/api", "src/api/v2"]);
    expect([...expandedForTree([skill("src/.claude/skills", "deploy")], ["lib/.claude/rules"])].sort()).toEqual(["", "lib", "lib/.claude", "lib/.claude/rules", "src", "src/.claude", "src/.claude/skills"]);
  });
});

describe("guardrailTreeRows", () => {
  const folders = ["docs", "src", "src/api", "src/ui"];
  const label = (row: ReturnType<typeof guardrailTreeRows>[number]) => `${"  ".repeat(row.depth)}${row.type === "folder" ? `${row.name}/${row.hasEntry ? "*" : ""}` : row.entry.path}`;

  it("lists subfolders before a folder's own entries and hides closed folders", () => {
    const rows = guardrailTreeRows(folders, [instruction(""), instruction("src/api")], new Set(["", "src", "src/api"]), "hunt");
    expect(rows.map(label)).toEqual(["hunt/*", "  docs/", "  src/", "    api/*", "      src/api/CLAUDE.md", "    ui/", "  CLAUDE.md"]);
  });

  it("lists rules under their folder and skills under the skills directory", () => {
    const rows = guardrailTreeRows(
      [".claude", ".claude/rules", ".claude/rules/api", ".claude/skills"],
      [rule("", "general"), rule("api", "naming"), skill(".claude/skills", "deploy")],
      new Set(["", ".claude", ".claude/rules", ".claude/rules/api", ".claude/skills"]),
      "hunt",
    );
    expect(rows.map(label)).toEqual(["hunt/", "  .claude/", "    rules/*", "      api/*", "        .claude/rules/api/naming.md", "      .claude/rules/general.md", "    skills/*", "      .claude/skills/deploy/SKILL.md"]);
  });

  it("shows only the root when it is closed", () => {
    expect(guardrailTreeRows(folders, [instruction("")], new Set(), "hunt").map(label)).toEqual(["hunt/*"]);
  });

  it("tells which folders hold entries somewhere below them", () => {
    const rows = guardrailTreeRows(folders, [instruction("src/api")], new Set(["", "src"]), "hunt");
    expect(rows.filter((row) => row.type === "folder").map((row) => `${row.name}${row.holdsEntries ? "+" : "-"}`)).toEqual(["hunt+", "docs-", "src+", "api+", "ui-"]);
  });
});

describe("normalizeGuardrailDir", () => {
  it("strips surrounding whitespace, leading ./ and trailing slashes", () => {
    expect(normalizeGuardrailDir("  ./docs/adr/ ")).toBe("docs/adr");
    expect(normalizeGuardrailDir("docs//decisions")).toBe("docs/decisions");
    expect(normalizeGuardrailDir(".claude\\rules")).toBe(".claude/rules");
  });

  it("rejects empty, absolute and parent-escaping paths", () => {
    expect(normalizeGuardrailDir("   ")).toBeNull();
    expect(normalizeGuardrailDir("./")).toBeNull();
    expect(normalizeGuardrailDir("/etc")).toBeNull();
    expect(normalizeGuardrailDir("../other/docs")).toBeNull();
  });
});

describe("adrDirOf", () => {
  it("reads the ADR folder hunt.json sets as adrDir", () => {
    expect(adrDirOf('{ "version": 3, "adrDir": "./docs/adr/" }')).toBe("docs/adr");
  });

  it("falls back to the default without the file, the field or a usable value", () => {
    for (const huntJson of ["", "{", "null", '{ "version": 3 }', '{ "adrDir": 7 }', '{ "adrDir": "../elsewhere" }', '{ "adrDir": "/etc" }']) {
      expect(adrDirOf(huntJson)).toBe(DEFAULT_GUARDRAIL_DIRS.adr);
    }
  });
});
