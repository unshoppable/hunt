import { describe, expect, it } from "vitest";
import { isInsideFolder } from "./path";

describe("isInsideFolder", () => {
  it("matches paths below the folder, not the folder itself or a sibling with the same prefix", () => {
    expect(isInsideFolder(".claude/skills/weq/CLAUDE.md", ".claude/skills/weq")).toBe(true);
    expect(isInsideFolder(".claude/skills/weq", ".claude/skills/weq")).toBe(false);
    expect(isInsideFolder(".claude/skills/weq2/CLAUDE.md", ".claude/skills/weq")).toBe(false);
    expect(isInsideFolder("CLAUDE.md", "")).toBe(true);
  });
});
