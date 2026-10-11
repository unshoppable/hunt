import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "./glob";

describe("matchesGlob", () => {
  it("matches a glob without a slash against the file name in any folder", () => {
    expect(matchesGlob("*.spec.ts", "user.spec.ts")).toBe(true);
    expect(matchesGlob("*.spec.ts", "apps/api/src/user.spec.ts")).toBe(true);
    expect(matchesGlob("*.spec.ts", "apps/api/src/user.spec.tsx")).toBe(false);
    expect(matchesGlob("*.ts", "apps/api/src/user.spec.ts")).toBe(true);
  });

  it("keeps * and ? within one path segment", () => {
    expect(matchesGlob("apps/*/src/main.ts", "apps/api/src/main.ts")).toBe(true);
    expect(matchesGlob("apps/*/src/main.ts", "apps/api/lib/src/main.ts")).toBe(false);
    expect(matchesGlob("apps/api/main.?s", "apps/api/main.ts")).toBe(true);
    expect(matchesGlob("apps/api/main.?s", "apps/api/main.tsx")).toBe(false);
  });

  it("spans folders with ** and matches the folder itself with a trailing /**", () => {
    expect(matchesGlob("**/backend/**", "backend/src/user.service.ts")).toBe(true);
    expect(matchesGlob("**/backend/**", "apps/backend/src/user.service.ts")).toBe(true);
    expect(matchesGlob("**/backend/**", "apps/backend")).toBe(true);
    expect(matchesGlob("**/backend/**", "apps/my-backend/user.service.ts")).toBe(false);
    expect(matchesGlob("apps/**/main.ts", "apps/main.ts")).toBe(true);
    expect(matchesGlob("apps/**/main.ts", "apps/api/src/main.ts")).toBe(true);
    expect(matchesGlob("src/**", "lib/src/index.ts")).toBe(false);
  });

  it("lists alternatives in braces, slashes and wildcards included", () => {
    const glob = "**/{backend,*-api,apps/api}/**";
    expect(matchesGlob(glob, "backend/main.ts")).toBe(true);
    expect(matchesGlob(glob, "libs/shop-api/main.ts")).toBe(true);
    expect(matchesGlob(glob, "apps/api/main.ts")).toBe(true);
    expect(matchesGlob(glob, "apps/web/main.ts")).toBe(false);
    expect(matchesGlob("*.{controller,gateway}.ts", "user.gateway.ts")).toBe(true);
    expect(matchesGlob("*.{controller,gateway}.ts", "user.service.ts")).toBe(false);
    expect(matchesGlob("*.{a,{b,c}}.ts", "x.c.ts")).toBe(true);
  });

  it("takes unbalanced braces and RegExp characters literally", () => {
    expect(matchesGlob("src/{weird.ts", "src/{weird.ts")).toBe(true);
    expect(matchesGlob("src/weird}.ts", "src/weird}.ts")).toBe(true);
    expect(matchesGlob("src/a+b(c).ts", "src/a+b(c).ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/aXts")).toBe(false);
  });

  it("ignores case and a leading ./ or / on either side", () => {
    expect(matchesGlob("**/Backend/**", "apps/BACKEND/Main.TS")).toBe(true);
    expect(matchesGlob("./src/**", "/src/main.ts")).toBe(true);
    expect(matchesGlob("   ", "main.ts")).toBe(false);
  });

  it("compiles to an anchored case-insensitive RegExp", () => {
    expect(globToRegExp("*.ts").flags).toBe("i");
    expect(globToRegExp("*.ts").source.startsWith("^")).toBe(true);
    expect(globToRegExp("*.ts").source.endsWith("$")).toBe(true);
  });
});
