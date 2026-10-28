import { describe, expect, it } from "vitest";
import type { CheckRun, ChecksStatus } from "./checks.types";
import { checkRows, describeCheck, describeChecks, failureExcerpt, formatDuration, isAnyCheckRunning, type CheckRow } from "./checks.utils";

const START = "2026-10-24T10:00:00.000Z";
const START_TIME = Date.parse(START);

function run(name: string, patch: Partial<CheckRun> = {}): CheckRun {
  return { name, run: 1, state: "passed", startedAt: START, finishedAt: "2026-10-24T10:00:12.000Z", exitCode: 0, ...patch };
}

function row(patch: Partial<CheckRow> = {}): CheckRow {
  return { definition: { name: "lint", command: "npm run lint", cwd: null }, run: run("lint"), isOutdated: false, ...patch };
}

describe("checkRows", () => {
  it("lists the checks in the order of hunt.json with their last runs", () => {
    const status: ChecksStatus = {
      definitions: [
        { name: "build", command: "vite build", cwd: null },
        { name: "lint", command: "eslint .", cwd: "apps/web" },
      ],
      problem: null,
      runs: [run("lint"), run("removed")],
      outdated: ["lint"],
    };
    expect(checkRows(status)).toEqual([
      { definition: status.definitions[0], run: null, isOutdated: false },
      { definition: status.definitions[1], run: run("lint"), isOutdated: true },
    ]);
    expect(checkRows(null)).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("shows tenths below ten seconds, whole seconds below a minute and minutes above", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(12_900)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(-5)).toBe("0.0s");
  });
});

describe("describeCheck", () => {
  it("names each state with its duration and the exit code of a failure", () => {
    expect(describeCheck(row({ run: null }), START_TIME)).toEqual({ text: "Not run yet", tone: "idle" });
    expect(describeCheck(row(), START_TIME)).toEqual({ text: "Passed in 12s", tone: "ok" });
    expect(describeCheck(row({ run: run("lint", { state: "failed", exitCode: 2 }) }), START_TIME)).toEqual({ text: "Failed (exit 2) after 12s", tone: "error" });
    expect(describeCheck(row({ run: run("lint", { state: "failed", exitCode: null }) }), START_TIME)).toEqual({ text: "Failed after 12s", tone: "error" });
    expect(describeCheck(row({ run: run("lint", { state: "cancelled", exitCode: null }) }), START_TIME)).toEqual({ text: "Stopped", tone: "idle" });
  });

  it("counts a running check's time up to now", () => {
    const running = run("lint", { state: "running", finishedAt: null, exitCode: null });
    expect(describeCheck(row({ run: running }), START_TIME + 3_000)).toEqual({ text: "Running · 3.0s", tone: "pending" });
  });

  it("greys out a result that started on another state of the worktree", () => {
    expect(describeCheck(row({ isOutdated: true }), START_TIME)).toEqual({ text: "Passed in 12s, outdated", tone: "idle" });
    expect(describeCheck(row({ isOutdated: true, run: run("lint", { state: "failed", exitCode: 1 }) }), START_TIME).tone).toBe("idle");
  });
});

describe("describeChecks", () => {
  it("sums up passed, failed and running checks", () => {
    expect(describeChecks([])).toEqual({ text: "No checks in hunt.json", tone: "idle" });
    expect(describeChecks([row(), row()])).toEqual({ text: "2 of 2 passed", tone: "ok" });
    expect(describeChecks([row(), row({ run: null })])).toEqual({ text: "1 of 2 passed", tone: "idle" });
    expect(describeChecks([row(), row({ run: run("lint", { state: "running" }) })])).toEqual({ text: "1 of 2 passed, 1 running", tone: "pending" });
    expect(describeChecks([row({ run: run("lint", { state: "failed" }) }), row({ run: run("lint", { state: "running" }) })])).toEqual({
      text: "0 of 2 passed, 1 failed, 1 running",
      tone: "error",
    });
  });
});

describe("isAnyCheckRunning", () => {
  it("is true while one run has not ended", () => {
    const status: ChecksStatus = { definitions: [], problem: null, runs: [run("lint"), run("test", { state: "running" })], outdated: [] };
    expect(isAnyCheckRunning(status)).toBe(true);
    expect(isAnyCheckRunning({ ...status, runs: [run("lint")] })).toBe(false);
    expect(isAnyCheckRunning(null)).toBe(false);
  });
});

describe("failureExcerpt", () => {
  it("removes colors, keeps what a progress line showed last and drops trailing blank lines", () => {
    const output = "\x1b[31merror\x1b[0m TS2322\r\n\x1b]0;title\x07progress 10%\rprogress 100%\r\n\r\n";
    expect(failureExcerpt(output)).toBe("error TS2322\nprogress 100%");
  });

  it("keeps the last 200 lines", () => {
    const output = Array.from({ length: 250 }, (_value, lineNumber) => `line ${lineNumber}`).join("\r\n");
    const excerpt = failureExcerpt(output).split("\n");
    expect(excerpt).toHaveLength(200);
    expect(excerpt[0]).toBe("line 50");
  });

  it("keeps the last 30000 characters", () => {
    expect(failureExcerpt("x".repeat(40_000))).toHaveLength(30_000);
  });
});
