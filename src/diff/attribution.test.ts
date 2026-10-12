import { describe, expect, it } from "vitest";
import { isOwnChange, otherTouchers } from "./attribution";

const file = (touchedBy: string[]) => ({ path: "a.ts", status: "M", touchedBy });

describe("isOwnChange", () => {
  it("is true for a file the session touched, whoever else did", () => {
    expect(isOwnChange(file(["s1"]), "s1", "p", "worktree")).toBe(true);
    expect(isOwnChange(file(["s2", "s1"]), "s1", null, "worktree")).toBe(true);
    expect(isOwnChange(file(["s2", "s1"]), "s1", null, "checkout")).toBe(true);
  });

  it("is false for a file only another session touched", () => {
    expect(isOwnChange(file(["s2"]), "s1", null, "worktree")).toBe(false);
    expect(isOwnChange(file(["s2"]), "s1", "p", "worktree")).toBe(false);
    expect(isOwnChange(file(["s2"]), "s1", "p", "checkout")).toBe(false);
  });

  it("gives a sub session the files its parent touched", () => {
    expect(isOwnChange(file(["p"]), "s1", "p", "worktree")).toBe(true);
    expect(isOwnChange(file(["p"]), "s1", "p", "checkout")).toBe(true);
    expect(isOwnChange(file(["p"]), "s1", null, "worktree")).toBe(false);
  });

  it("gives unattributed changes to every session of a Hunt-owned worktree", () => {
    expect(isOwnChange(file([]), "s1", null, "worktree")).toBe(true);
    expect(isOwnChange(file([]), "s1", "p", "worktree")).toBe(true);
  });

  it("gives unattributed changes of the repository's own checkout to no session", () => {
    expect(isOwnChange(file([]), "s1", null, "checkout")).toBe(false);
    expect(isOwnChange(file([]), "s1", "p", "checkout")).toBe(false);
  });
});

describe("otherTouchers", () => {
  it("leaves the session itself and its parent out", () => {
    expect(otherTouchers(file(["s1", "s2", "s3"]), "s2", null)).toEqual(["s1", "s3"]);
    expect(otherTouchers(file(["p", "s2", "s3"]), "s2", "p")).toEqual(["s3"]);
    expect(otherTouchers(file([]), "s1", null)).toEqual([]);
  });
});
