import { describe, expect, it } from "vitest";
import {
  directoriesOfKind,
  expandedForTree,
  foldersOf,
  guardrailListRows,
  guardrailTreeRows,
  instructionGuardrails,
  newGuardrailLocation,
  ownerFolderOf,
  treeFolders,
} from "./guardrail-tree.utils";
import { instruction, listing, rule, skill } from "./guardrail.fixtures";

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

describe("foldersOf", () => {
  it("collects every folder on the way to each file, sorted, without the root", () => {
    expect(foldersOf(["CLAUDE.md", "src/api/users.ts", "src/index.ts", "docs/adr/0001.md"])).toEqual(["docs", "docs/adr", "src", "src/api"]);
  });
});

describe("directoriesOfKind", () => {
  it("reads the configured directory at the root and every folder that ends in it", () => {
    const folders = [".claude", ".claude/rules", "src", "src/api", "src/api/.claude", "src/api/.claude/rules", "src/my.claude/rules"];
    expect(directoriesOfKind(".claude/rules", folders)).toEqual([".claude/rules", "src/api/.claude/rules"]);
  });

  it("keeps the root directory although no project file reveals it", () => {
    expect(directoriesOfKind(".claude/skills", ["src"])).toEqual([".claude/skills"]);
  });
});

describe("instructionGuardrails", () => {
  it("lists the CLAUDE.md files, shallow ones first and then by path", () => {
    const files = ["src/b/CLAUDE.md", "README.md", "src/a/CLAUDE.md", "docs/CLAUDE.md", "CLAUDE.md", "src/NOT_CLAUDE.md"];
    expect(instructionGuardrails(files).map((guardrail) => guardrail.path)).toEqual(["CLAUDE.md", "docs/CLAUDE.md", "src/a/CLAUDE.md", "src/b/CLAUDE.md"]);
  });

  it("names each after the instruction file and groups it by its folder", () => {
    expect(instructionGuardrails(["src/api/CLAUDE.md"])).toEqual([{ kind: "instruction", path: "src/api/CLAUDE.md", name: "CLAUDE.md", folder: "src/api" }]);
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
