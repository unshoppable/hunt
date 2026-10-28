import { describe, expect, it } from "vitest";
import { globToRegExp, matchingFiles } from "./glob.utils.ts";

describe("globs", () => {
  it("matches like worktreeInclude: ** crosses folders, * stays within one", () => {
    expect(globToRegExp("**/migrations/**").test("apps/med/backend/src/migrations/Migration1.ts")).toBe(true);
    expect(globToRegExp("**/migrations/**").test("migrations/x.ts")).toBe(true);
    expect(globToRegExp("apps/*/backend/src/migrations/**").test("apps/med/backend/src/migrations/a/b.ts")).toBe(true);
    expect(globToRegExp("apps/*/backend/src/migrations/**").test("apps/med/x/backend/src/migrations/b.ts")).toBe(false);
    expect(globToRegExp("**/*authoriz*").test("libs/shared/backend/src/lib/authorization.decorator.ts")).toBe(true);
    expect(globToRegExp("hunt.json").test("hunt.json")).toBe(true);
    expect(globToRegExp("hunt.json").test("apps/hunt.json")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(matchingFiles(["README.md", ".github/workflows/ci.yml"], [".github/**"])).toEqual([".github/workflows/ci.yml"]);
  });
});
