import { describe, expect, it } from "vitest";
import { HEARTBEAT_MAX_AGE_MS, reportOf } from "./status-report.utils.ts";

const NOW = 1_800_000_000_000;
const STARTED_AT = NOW - 10 * 60_000;
const RECORD_AT = NOW - 20_000;
const NOT_SERVING = { t: "status", turn: null, question: null, lastTurnEndedAt: null, swfRecordAt: RECORD_AT };

/** The content of a ready relay's `status.json` with a fresh heartbeat, changed by `changes`. */
function statusText(changes: Record<string, unknown> = {}): string {
  const status = {
    heartbeatAt: NOW - 5_000,
    state: "ready",
    error: null,
    acpSessionId: "acp-1",
    turn: "idle",
    clientConnected: true,
    lastClientActivityAt: NOW - 60_000,
    lastTurnEndedAt: NOW - 30_000,
    pendingPermissionSince: null,
    question: false,
    ...changes,
  };
  return `${JSON.stringify(status, null, 2)}\n`;
}

/** `reportOf` with the worktree's pipeline record written at `RECORD_AT`. */
function report(text: string | null, now = NOW, startedAt = STARTED_AT) {
  return reportOf(text, now, startedAt, RECORD_AT);
}

describe("reportOf", () => {
  it("reports a running and an idle turn with the time the last turn ended", () => {
    expect(report(statusText({ turn: "running" }))).toEqual({ t: "status", turn: "running", question: false, lastTurnEndedAt: NOW - 30_000, swfRecordAt: RECORD_AT });
    expect(report(statusText({ lastTurnEndedAt: null }))).toEqual({ t: "status", turn: "idle", question: false, lastTurnEndedAt: null, swfRecordAt: RECORD_AT });
  });

  it("reports whether the last turn ended with a question, and null for a relay that does not say", () => {
    expect(report(statusText({ question: true }))).toMatchObject({ turn: "idle", question: true });
    expect(report(statusText({ question: undefined }))).toMatchObject({ turn: "idle", question: null });
  });

  it("reports no turn without a status file or with one it cannot read", () => {
    expect(report(null)).toEqual(NOT_SERVING);
    expect(report("")).toEqual(NOT_SERVING);
    expect(report('{"heartbeatAt": 1')).toEqual(NOT_SERVING);
    expect(report("[]")).toEqual(NOT_SERVING);
    expect(report(statusText({ turn: "busy" }))).toEqual(NOT_SERVING);
  });

  it("reports no turn while the relay starts or after it failed", () => {
    expect(report(statusText({ state: "starting", acpSessionId: null }))).toEqual(NOT_SERVING);
    expect(report(statusText({ state: "failed", error: "no token", question: true }))).toEqual(NOT_SERVING);
  });

  it("reports no turn once the heartbeat is stale", () => {
    const heartbeatAt = NOW - HEARTBEAT_MAX_AGE_MS;
    expect(report(statusText({ heartbeatAt }))).toMatchObject({ turn: "idle" });
    expect(report(statusText({ heartbeatAt: heartbeatAt - 1, turn: "running" }))).toEqual(NOT_SERVING);
    expect(report(statusText({ heartbeatAt: undefined }))).toEqual(NOT_SERVING);
  });

  it("gives the relay of a resumed VM the heartbeat limit from the helper's start to write a new heartbeat", () => {
    const beforeSuspend = statusText({ heartbeatAt: NOW - 3 * 60 * 60_000, turn: "running" });

    expect(report(beforeSuspend, NOW, NOW - 1_000)).toMatchObject({ turn: "running" });
    expect(report(beforeSuspend, NOW, NOW - HEARTBEAT_MAX_AGE_MS - 1)).toEqual(NOT_SERVING);
  });

  it("carries the time of the pipeline record whether or not the relay serves, and null without a record", () => {
    expect(reportOf(statusText(), NOW, STARTED_AT, null)).toMatchObject({ turn: "idle", swfRecordAt: null });
    expect(reportOf(null, NOW, STARTED_AT, RECORD_AT)).toMatchObject({ turn: null, swfRecordAt: RECORD_AT });
  });
});
