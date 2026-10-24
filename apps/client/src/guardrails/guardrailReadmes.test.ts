import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDRAIL_DIRS } from "./guardrails";
import { guardrailReadme, needsReadme } from "./guardrailReadmes";

const file = (name: string) => ({ name, isDir: false });
const folder = (name: string) => ({ name, isDir: true });

describe("needsReadme", () => {
  it("is true once the folder holds a guardrail but no README", () => {
    expect(needsReadme("adr", [file("0001-use-postgres.md")])).toBe(true);
    expect(needsReadme("rule", [file("testing.md")])).toBe(true);
  });

  it("counts a subfolder as a guardrail of rules only", () => {
    expect(needsReadme("rule", [folder("frontend")])).toBe(true);
    expect(needsReadme("adr", [folder("assets")])).toBe(false);
  });

  it("is false for an empty folder or one that has a README in any case", () => {
    expect(needsReadme("adr", [])).toBe(false);
    expect(needsReadme("rule", [file("testing.md"), file("readme.md")])).toBe(false);
    expect(needsReadme("adr", [file(".DS_Store")])).toBe(false);
  });
});

describe("guardrailReadme", () => {
  it("fills in the configured folders", () => {
    const dirs = { ...DEFAULT_GUARDRAIL_DIRS, adr: "doc/decisions" };
    const rules = guardrailReadme("rule", dirs);
    expect(rules).toContain('paths: [".claude/rules/**"]');
    expect(rules).toContain("`doc/decisions/`");
    expect(guardrailReadme("adr", dirs)).toContain("`.claude/rules/`");
    expect(rules).not.toContain("{{");
  });
});
