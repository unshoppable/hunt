import { describe, expect, it } from "vitest";
import { ancestorsOf, childOf, foldersOf, isAtOrBelow, isIgnoreFile, isSkipped, nameOf, parentOf, splitNul } from "./worktree-paths.utils.ts";

describe("paths", () => {
  it("splits and joins worktree-relative paths", () => {
    expect(parentOf("a/b/c.txt")).toBe("a/b");
    expect(parentOf("c.txt")).toBe("");
    expect(nameOf("a/b/c.txt")).toBe("c.txt");
    expect(childOf("", "a")).toBe("a");
    expect(childOf("a/b", "c")).toBe("a/b/c");
    expect(ancestorsOf("a/b/c.txt")).toEqual(["a/b", "a"]);
    expect(ancestorsOf("c.txt")).toEqual([]);
  });

  it("tells whether a path lies at or below a folder", () => {
    expect(isAtOrBelow("a/b", "a")).toBe(true);
    expect(isAtOrBelow("a", "a")).toBe(true);
    expect(isAtOrBelow("ab/c", "a")).toBe(false);
    expect(isAtOrBelow("x", "")).toBe(true);
  });
});

describe("foldersOf", () => {
  it("holds the worktree and every folder leading to a listed file", () => {
    expect([...foldersOf(["README.md", "src/a/b.ts", "src/a/c.ts", "src/d.ts", "lib/e/f/g.ts"])].sort()).toEqual([
      "",
      "lib",
      "lib/e",
      "lib/e/f",
      "src",
      "src/a",
    ]);
  });
});

describe("isSkipped", () => {
  it("skips Git's folder and Hunt's folder at the top only", () => {
    expect(isSkipped(".git")).toBe(true);
    expect(isSkipped(".git/index")).toBe(true);
    expect(isSkipped(".hunt")).toBe(true);
    expect(isSkipped(".hunt/graph.json")).toBe(true);
    expect(isSkipped(".github/workflows/ci.yml")).toBe(false);
    expect(isSkipped("a/.git")).toBe(false);
    expect(isSkipped(".gitignore")).toBe(false);
  });
});

describe("isIgnoreFile", () => {
  it("matches every .gitignore", () => {
    expect(isIgnoreFile(".gitignore")).toBe(true);
    expect(isIgnoreFile("a/b/.gitignore")).toBe(true);
    expect(isIgnoreFile("a/.gitignore.bak")).toBe(false);
  });
});

describe("splitNul", () => {
  it("drops the trailing empty entry", () => {
    expect(splitNul("a\0b c\0")).toEqual(["a", "b c"]);
    expect(splitNul("")).toEqual([]);
  });
});
