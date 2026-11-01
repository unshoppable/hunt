import { describe, expect, it } from "vitest";
import { newFolderProblem, newNameProblem, pathMatches, pathOffsets, renamedTo } from "./path-rename.utils";

describe("pathOffsets", () => {
  it("finds the path as a whole, also as the start of a longer path or the end of an absolute one", () => {
    expect(pathOffsets("see .claude/resources/domain for the concepts", ".claude/resources/domain")).toEqual([4]);
    expect(pathOffsets("`.claude/resources/domain/user.md`", ".claude/resources/domain")).toEqual([1]);
    expect(pathOffsets("/Users/me/repo/.claude/resources/domain", ".claude/resources/domain")).toEqual([15]);
  });

  it("skips the path inside a longer name", () => {
    expect(pathOffsets("src/domains/a.ts", "src/domain")).toEqual([]);
    expect(pathOffsets("my-src/domain", "src/domain")).toEqual([]);
    expect(pathOffsets("src/domain.ts", "src/domain")).toEqual([]);
  });

  it("finds every occurrence on a line", () => {
    expect(pathOffsets("src/a → src/a/b, src/a", "src/a")).toEqual([0, 8, 17]);
  });
});

describe("pathMatches", () => {
  it("lists the matches with their 0-based line", () => {
    expect(pathMatches(["none", "in src/a here", "src/a"], "src/a")).toEqual([
      { line: 1, offset: 3 },
      { line: 2, offset: 0 },
    ]);
  });
});

describe("newNameProblem", () => {
  it("accepts one path segment", () => {
    expect(newNameProblem("model")).toBeNull();
    expect(newNameProblem("user.service.ts")).toBeNull();
  });

  it("rejects an empty name, a slash and the dot names", () => {
    expect(newNameProblem("")).toMatch(/name/);
    expect(newNameProblem("a/b")).toMatch(/slash/);
    expect(newNameProblem("..")).toMatch(/not a name/);
  });
});

describe("renamedTo", () => {
  it("keeps the folder of the path", () => {
    expect(renamedTo("src/domain", "model")).toBe("src/model");
    expect(renamedTo("README.md", "readme.md")).toBe("readme.md");
  });
});

describe("newFolderProblem", () => {
  it("accepts a name and a nested path", () => {
    expect(newFolderProblem("docs")).toBeNull();
    expect(newFolderProblem("docs/adrs")).toBeNull();
  });

  it("rejects empty segments and the dot names", () => {
    expect(newFolderProblem("")).toMatch(/folder name/);
    expect(newFolderProblem("docs//adrs")).toMatch(/folder name/);
    expect(newFolderProblem("../docs")).toMatch(/neither/);
  });
});
