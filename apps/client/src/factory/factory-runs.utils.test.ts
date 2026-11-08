import { describe, expect, it } from "vitest";
import { modelText, openableRuns, runModelWindows, shownRun, sumTokens, tokensTitle, totalTokens } from "./factory-runs.utils";

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

  it("shows the selected running run before it wrote a step result or a transcript, but never by default", () => {
    expect(shownRun(4, openable, 4)).toBe(4);
    expect(shownRun(null, openable, 4)).toBe(3);
  });

  it("shows none while no run can be opened", () => {
    expect(shownRun(2, new Set())).toBeNull();
  });
});

describe("totalTokens and tokensTitle", () => {
  const tokens = { n: 2, input: 1022, cacheWrite: 1_361_148, cacheRead: 215_148_637, output: 475_378 };

  it("sums every kind of token the run used", () => {
    expect(totalTokens(tokens)).toBe(216_986_185);
  });

  it("names each kind with its count", () => {
    expect(tokensTitle(tokens)).toBe("Input 1k · cache write 1.4M · cache read 215M · output 475k");
  });
});

describe("sumTokens", () => {
  it("adds up each kind of token over the runs", () => {
    const runs = [
      { n: 1, input: 1, cacheWrite: 10, cacheRead: 100, output: 1000 },
      { n: 2, input: 2, cacheWrite: 20, cacheRead: 200, output: 2000 },
    ];
    expect(sumTokens(runs)).toEqual({ input: 3, cacheWrite: 30, cacheRead: 300, output: 3000 });
    expect(sumTokens([])).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});

describe("modelText", () => {
  it("names the model without its claude- prefix and the effort", () => {
    expect(modelText({ model: "claude-opus-5-5", effort: "high" })).toBe("opus-5-5 · high");
  });

  it("says default for what Claude Code picks itself and nothing for a step without a setting", () => {
    expect(modelText({ model: null, effort: null })).toBe("default · default");
    expect(modelText(undefined)).toBeNull();
  });
});

describe("runModelWindows", () => {
  const windows = [
    { label: "5h", utilization: 10, resetsAt: null },
    { label: "Week", utilization: 20, resetsAt: null },
    { label: "Fable", utilization: 30, resetsAt: null },
    { label: "Opus", utilization: 40, resetsAt: null },
  ];

  it("shows the weekly limit of each model the runs used", () => {
    expect(runModelWindows(windows, ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5-5"]).map((window) => window.label)).toEqual(["Fable", "Opus"]);
  });

  it("shows the weekly limit of all models for a model without a limit of its own and for the default model", () => {
    expect(runModelWindows(windows, ["claude-sonnet-5-5"]).map((window) => window.label)).toEqual(["Week"]);
    expect(runModelWindows(windows, [null, "fable"]).map((window) => window.label)).toEqual(["Week", "Fable"]);
  });

  it("shows nothing before the first run", () => {
    expect(runModelWindows(windows, [])).toEqual([]);
  });
});
