import { describe, expect, it } from "vitest";
import type { LoadedContextFile } from "./loaded-context.types";
import { contextFileLabel, contextSections } from "./loaded-context.utils";

const file = (kind: LoadedContextFile["kind"], path: string): LoadedContextFile => ({ kind, trigger: "start", path, isInWorktree: true });

describe("contextSections", () => {
  it("groups the files in the fixed section order, keeps the load order within a section and leaves out empty sections", () => {
    const files = [file("rule", ".claude/rules/b.md"), file("skill", ".claude/skills/spec/SKILL.md"), file("instructions", "CLAUDE.md"), file("rule", ".claude/rules/a.md")];
    expect(contextSections(files).map((section) => [section.title, section.files.map((entry) => entry.path)])).toEqual([
      ["Instruction files", ["CLAUDE.md"]],
      ["Rules", [".claude/rules/b.md", ".claude/rules/a.md"]],
      ["Skills", [".claude/skills/spec/SKILL.md"]],
    ]);
  });
});

describe("contextFileLabel", () => {
  it("names a file by its file name and a skill by its folder", () => {
    expect(contextFileLabel(file("rule", ".claude/rules/git.md"))).toEqual({ name: "git.md", folder: ".claude/rules" });
    expect(contextFileLabel(file("skill", ".claude/skills/spec/SKILL.md"))).toEqual({ name: "spec", folder: ".claude/skills" });
    expect(contextFileLabel(file("instructions", "CLAUDE.md"))).toEqual({ name: "CLAUDE.md", folder: "" });
  });
});
