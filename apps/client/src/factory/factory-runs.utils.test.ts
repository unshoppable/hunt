import { describe, expect, it } from "vitest";
import { openableRuns, shownRun } from "./factory-runs.utils";

describe("openableRuns", () => {
  it("collects the runs with a step result or a transcript", () => {
    expect(openableRuns([{ n: 1, step: "plan" }], [{ n: 1, step: "plan" }, { n: 2, step: "implement" }])).toEqual(new Set([1, 2]));
  });
});

describe("shownRun", () => {
  const openable = new Set([1, 3]);

  it("shows the selected run while it can be opened", () => {
    expect(shownRun(1, openable)).toBe(1);
  });

  it("falls back to the latest run that can be opened", () => {
    expect(shownRun(null, openable)).toBe(3);
    expect(shownRun(2, openable)).toBe(3);
  });

  it("shows none while no run can be opened", () => {
    expect(shownRun(2, new Set())).toBeNull();
  });
});
