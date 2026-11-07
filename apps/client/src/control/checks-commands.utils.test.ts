import { describe, expect, it } from "vitest";
import type { CheckRun, ChecksStatus } from "../checks/checks.types";
import { ensureDeclaredCheck, ensureRunningCheck } from "./checks-commands.utils";

function run(name: string, state: CheckRun["state"]): CheckRun {
  return { name, run: 1, state, startedAt: "2026-11-01T10:00:00Z", finishedAt: null, exitCode: null, window: null, error: null };
}

const STATUS: ChecksStatus = {
  definitions: [
    { name: "lint", command: "eslint .", cwd: null },
    { name: "test", command: "vitest", cwd: null },
  ],
  problem: null,
  runs: [run("lint", "running"), run("test", "passed")],
  outdated: [],
};

describe("ensureDeclaredCheck", () => {
  it("accepts a check of hunt.json and names the declared ones otherwise", () => {
    expect(() => ensureDeclaredCheck(STATUS, "test")).not.toThrow();
    expect(() => ensureDeclaredCheck(STATUS, "build")).toThrow("hunt.json declares no check build; its checks are lint, test");
    expect(() => ensureDeclaredCheck({ ...STATUS, definitions: [] }, "build")).toThrow("hunt.json declares no checks");
  });
});

describe("ensureRunningCheck", () => {
  it("accepts only a declared check that runs", () => {
    expect(() => ensureRunningCheck(STATUS, "lint")).not.toThrow();
    expect(() => ensureRunningCheck(STATUS, "test")).toThrow("the check test is not running");
    expect(() => ensureRunningCheck(STATUS, "build")).toThrow("hunt.json declares no check build");
  });
});
