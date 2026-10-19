import { describe, expect, it } from "vitest";
import { isValidBranchName, newBranchProblem } from "./newBranch";

describe("isValidBranchName", () => {
  it("accepts the branch names repositories use", () => {
    for (const name of ["master", "feat/general/abc", "fix/sentry/admin-ui-errors", "release-1.2", "a.b", "x_y"]) {
      expect(isValidBranchName(name), name).toBe(true);
    }
  });

  it("rejects what git check-ref-format refuses", () => {
    const rejected = ["", "-x", "/x", "x/", "x.", "a b", "a..b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a//b", "a/.b", ".x", "a.lock", "a.lock/b", "a@{b", "@", "a\u0007b"];
    for (const name of rejected) {
      expect(isValidBranchName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("newBranchProblem", () => {
  const branches = ["master", "feat/general/taken", "origin/master", "origin/feat/general/pushed"];

  it("accepts a fresh valid name", () => {
    expect(newBranchProblem("feat/general/fresh", branches)).toBeNull();
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
