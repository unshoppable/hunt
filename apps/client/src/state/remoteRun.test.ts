import { describe, expect, it } from "vitest";
import { advanceRemoteRun, remoteRunMs } from "./remoteRun";

describe("advanceRemoteRun", () => {
  it("starts a run with the first step and appends the next ones", () => {
    const started = advanceRemoteRun(null, "connecting", 1_000, false);
    expect(started).toEqual({ steps: ["connecting"], stepStartedAt: 1_000, operationStartedAt: 1_000, finishedMs: 0 });
    const next = advanceRemoteRun(started, "creatingVm", 3_000, false);
    expect(next).toEqual({ steps: ["connecting", "creatingVm"], stepStartedAt: 3_000, operationStartedAt: 1_000, finishedMs: 0 });
  });

  it("keeps the step's start for a log line about it", () => {
    const run = advanceRemoteRun(null, "waitingForVm", 1_000, false);
    expect(advanceRemoteRun(run, "waitingForVm", 9_000, false)).toBe(run);
  });

  it("ends with its operation unless a move continues it", () => {
    const run = advanceRemoteRun(null, "connecting", 1_000, false);
    expect(advanceRemoteRun(run, null, 2_000, false)).toBeNull();
    expect(advanceRemoteRun(null, null, 2_000, true)).toBeNull();
  });

  it("pauses between the operations of a move and counts only their run time", () => {
    const prepared = advanceRemoteRun(advanceRemoteRun(null, "installingRuntime", 1_000, true), null, 5_000, true);
    expect(prepared).toEqual({ steps: ["installingRuntime"], stepStartedAt: null, operationStartedAt: null, finishedMs: 4_000 });
    expect(remoteRunMs(prepared!, 60_000)).toBe(4_000);

    const handingOff = advanceRemoteRun(prepared, "installingRuntime", 60_000, true);
    expect(handingOff).toEqual({ steps: ["installingRuntime", "installingRuntime"], stepStartedAt: 60_000, operationStartedAt: 60_000, finishedMs: 4_000 });
    expect(remoteRunMs(handingOff!, 62_000)).toBe(6_000);
  });
});
