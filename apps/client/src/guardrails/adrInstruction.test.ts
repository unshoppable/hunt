import { describe, expect, it } from "vitest";
import { adrSection, hasAdrInstruction, withAdrSection } from "./adrInstruction";

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

describe("withAdrSection", () => {
  it("appends the section after one blank line and keeps the existing content", () => {
    const result = withAdrSection("# Project\n\nRun `npm test`.\n\n\n", "docs/adr");
    expect(result).toBe(`# Project\n\nRun \`npm test\`.\n\n${adrSection("docs/adr")}`);
    expect(result.endsWith("\n")).toBe(true);
  });

  it("holds the section alone for a missing or empty file", () => {
    expect(withAdrSection("", "docs/adr")).toBe(adrSection("docs/adr"));
  });

  it("names the configured ADR folder in every command", () => {
    const section = adrSection("doc/decisions");
    expect(section).toContain("`ls doc/decisions/`");
    expect(section).toContain("`grep -ril <topic> doc/decisions/`");
    expect(section).toContain("`doc/decisions/NNNN-title.md`");
  });
});
