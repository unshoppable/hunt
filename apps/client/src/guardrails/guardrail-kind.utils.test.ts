import { describe, expect, it } from "vitest";
import { kindHelp } from "./guardrail-kind.utils";

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
