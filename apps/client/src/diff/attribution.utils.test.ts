import { describe, expect, it } from "vitest";
import { countByScope, isInScope, otherTouchers, scopeOwnerIds } from "./attribution.utils";

const file = (touchedBy: string[]) => ({ path: "a.ts", status: "M", touchedBy });

describe("isInScope", () => {
  it("lists a file the session touched in every scope, whoever else did", () => {
    expect(isInScope(file(["s1"]), "own", "s1", "p", "worktree")).toBe(true);
    expect(isInScope(file(["s2", "s1"]), "own", "s1", null, "worktree")).toBe(true);
    expect(isInScope(file(["s2", "s1"]), "own", "s1", null, "checkout")).toBe(true);
    expect(isInScope(file(["s1"]), "downstream", "s1", "p", "worktree")).toBe(true);
  });

  it("lists a file only a sibling or another session touched only in all", () => {
    expect(isInScope(file(["s2"]), "own", "s1", null, "worktree")).toBe(false);
    expect(isInScope(file(["s2"]), "own", "s1", "p", "worktree")).toBe(false);
    expect(isInScope(file(["s2"]), "downstream", "s1", "p", "worktree")).toBe(false);
    expect(isInScope(file(["s2"]), "downstream", "s1", "p", "checkout")).toBe(false);
    expect(isInScope(file(["s2"]), "all", "s1", "p", "worktree")).toBe(true);
  });

  it("lists a file the parent touched in downstream only", () => {
    expect(isInScope(file(["p"]), "own", "s1", "p", "worktree")).toBe(false);
    expect(isInScope(file(["p"]), "downstream", "s1", "p", "worktree")).toBe(true);
    expect(isInScope(file(["p"]), "downstream", "s1", "p", "checkout")).toBe(true);
    expect(isInScope(file(["p"]), "downstream", "s1", null, "worktree")).toBe(false);
  });

  it("gives unattributed changes of a Hunt-owned worktree to its top-level session", () => {
    expect(isInScope(file([]), "own", "s1", null, "worktree")).toBe(true);
    expect(isInScope(file([]), "own", "s1", "p", "worktree")).toBe(false);
    expect(isInScope(file([]), "downstream", "s1", "p", "worktree")).toBe(true);
  });

  it("gives unattributed changes of the repository's own checkout to no session", () => {
    expect(isInScope(file([]), "own", "s1", null, "checkout")).toBe(false);
    expect(isInScope(file([]), "downstream", "s1", "p", "checkout")).toBe(false);
    expect(isInScope(file([]), "all", "s1", "p", "checkout")).toBe(true);
  });
});

describe("countByScope", () => {
  it("counts the files each scope of a sub session lists", () => {
    const files = [file(["s1"]), file(["p"]), file(["s2"]), file([])];
    expect(countByScope(files, "s1", "p", "worktree")).toEqual({ own: 1, downstream: 3, all: 4 });
  });
});

describe("scopeOwnerIds", () => {
  it("adds the parent session in downstream only", () => {
    expect(scopeOwnerIds("own", "s1", "p")).toEqual(["s1"]);
    expect(scopeOwnerIds("downstream", "s1", "p")).toEqual(["s1", "p"]);
    expect(scopeOwnerIds("all", "s1", "p")).toEqual(["s1"]);
    expect(scopeOwnerIds("downstream", "s1", null)).toEqual(["s1"]);
  });
});

describe("otherTouchers", () => {
  it("leaves the owner sessions out", () => {
    expect(otherTouchers(file(["s1", "s2", "s3"]), ["s2"])).toEqual(["s1", "s3"]);
    expect(otherTouchers(file(["p", "s2", "s3"]), ["s2"])).toEqual(["p", "s3"]);
    expect(otherTouchers(file(["p", "s2", "s3"]), ["s2", "p"])).toEqual(["s3"]);
    expect(otherTouchers(file([]), ["s1"])).toEqual([]);
  });
});
