import { describe, expect, it } from "vitest";
import { newBranchProblem } from "./new-branch.utils";

describe("newBranchProblem", () => {
  const branches = ["master", "feat/general/taken", "origin/master", "origin/feat/general/pushed"];

  it("accepts a fresh valid name", () => {
    expect(newBranchProblem("feat/general/fresh", branches)).toBeNull();
  });

  it("accepts the branch names repositories use", () => {
    for (const name of ["main", "feat/general/abc", "fix/sentry/admin-ui-errors", "release-1.2", "a.b", "x_y"]) {
      expect(newBranchProblem(name, branches), name).toBeNull();
    }
  });

  it("names what git check-ref-format refuses and a name over 250 characters as invalid", () => {
    const rejected = ["-x", "/x", "x/", "x.", "a b", "a..b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a//b", "a/.b", ".x", "a.lock", "a.lock/b", "a@{b", "@", "a\u0007b", "x".repeat(251)];
    for (const name of rejected) {
      expect(newBranchProblem(name, branches), JSON.stringify(name)).toBe(`"${name}" is not a valid branch name`);
    }
  });

  it("has no message for an empty name", () => {
    expect(newBranchProblem("", branches)).toBe("");
  });

  it("names a branch that exists locally or on a remote", () => {
    expect(newBranchProblem("feat/general/taken", branches)).toBe("Branch feat/general/taken exists already");
    expect(newBranchProblem("feat/general/pushed", branches)).toBe("Branch feat/general/pushed exists on a remote already");
    expect(newBranchProblem("general/pushed", branches)).toBeNull();
  });

  it("names an invalid branch name", () => {
    expect(newBranchProblem("feat general", branches)).toBe('"feat general" is not a valid branch name');
  });
});
