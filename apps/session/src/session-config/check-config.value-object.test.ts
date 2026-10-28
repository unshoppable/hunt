import { describe, expect, it } from "vitest";
import { CheckConfig } from "./check-config.value-object.ts";

describe("CheckConfig", () => {
  it("runs in the worktree unless it names a folder", () => {
    expect(new CheckConfig({ name: "lint", command: "npm run lint" }).toJSON()).toEqual({ name: "lint", command: "npm run lint", cwd: null });
    expect(new CheckConfig({ name: "test", command: "npm test", cwd: "apps/web" }).cwd).toBe("apps/web");
  });

  it("rejects an invalid name, command line or folder", () => {
    expect(() => new CheckConfig({ name: "Lint", command: "npm run lint" })).toThrow(/invalid name/);
    expect(() => new CheckConfig({ name: "lint", command: " " })).toThrow(/must be a non-empty string/);
    expect(() => new CheckConfig({ name: "lint", command: "npm run lint", cwd: "../web" })).toThrow(/must be a folder relative to the worktree/);
  });
});
