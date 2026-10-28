import { describe, expect, it } from "vitest";
import { BranchName } from "./branch-name.value-object.ts";

describe("BranchName", () => {
  it("accepts what git check-ref-format --branch accepts", () => {
    expect(["main", "fix/general/12-fix-login", "feat/ä-umlaut", "release-1.2", "a+b@c"].every((name) => BranchName.isValid(name))).toBe(true);
    expect(BranchName.of("fix/general/12-fix-login").name).toBe("fix/general/12-fix-login");
  });

  it("rejects the names git rejects and names over 250 characters", () => {
    const invalid = ["", "@", "-x", "/x", "x/", "x.", "a..b", "a//b", "a@{b", ".hidden", "x.lock", "a/.b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\u0007b", "a\u007fb"];
    expect(invalid.filter((name) => BranchName.isValid(name))).toEqual([]);
    expect(BranchName.isValid("x".repeat(251))).toBe(false);
    expect(() => BranchName.of("a..b")).toThrow(/check-ref-format/);
  });
});
