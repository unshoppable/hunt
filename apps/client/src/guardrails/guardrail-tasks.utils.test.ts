import { describe, expect, it } from "vitest";
import { creationTask, generationTask, guardrailTask } from "./guardrail-tasks.utils";
import { adr, listing } from "./guardrail.fixtures";

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
