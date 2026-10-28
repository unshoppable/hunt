import { describe, expect, it } from "vitest";
import { HEARTBEAT_MAX_AGE_MS, reportOf } from "./status-report.utils.ts";

const NOW = 1_800_000_000_000;
const STARTED_AT = NOW - 10 * 60_000;
const NOT_SERVING = { t: "status", turn: null, question: null, lastTurnEndedAt: null };

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

describe("reportOf", () => {
  it("reports a running and an idle turn with the time the last turn ended", () => {
    expect(reportOf(statusText({ turn: "running" }), NOW, STARTED_AT)).toEqual({ t: "status", turn: "running", question: false, lastTurnEndedAt: NOW - 30_000 });
    expect(reportOf(statusText({ lastTurnEndedAt: null }), NOW, STARTED_AT)).toEqual({ t: "status", turn: "idle", question: false, lastTurnEndedAt: null });
  });

  it("reports whether the last turn ended with a question, and null for a relay that does not say", () => {
    expect(reportOf(statusText({ question: true }), NOW, STARTED_AT)).toMatchObject({ turn: "idle", question: true });
    expect(reportOf(statusText({ question: undefined }), NOW, STARTED_AT)).toMatchObject({ turn: "idle", question: null });
  });

  it("reports no turn without a status file or with one it cannot read", () => {
    expect(reportOf(null, NOW, STARTED_AT)).toEqual(NOT_SERVING);
    expect(reportOf("", NOW, STARTED_AT)).toEqual(NOT_SERVING);
    expect(reportOf('{"heartbeatAt": 1', NOW, STARTED_AT)).toEqual(NOT_SERVING);
    expect(reportOf("[]", NOW, STARTED_AT)).toEqual(NOT_SERVING);
    expect(reportOf(statusText({ turn: "busy" }), NOW, STARTED_AT)).toEqual(NOT_SERVING);
  });

  it("reports no turn while the relay starts or after it failed", () => {
    expect(reportOf(statusText({ state: "starting", acpSessionId: null }), NOW, STARTED_AT)).toEqual(NOT_SERVING);
    expect(reportOf(statusText({ state: "failed", error: "no token", question: true }), NOW, STARTED_AT)).toEqual(NOT_SERVING);
  });

  it("reports no turn once the heartbeat is stale", () => {
    const heartbeatAt = NOW - HEARTBEAT_MAX_AGE_MS;
    expect(reportOf(statusText({ heartbeatAt }), NOW, STARTED_AT)).toMatchObject({ turn: "idle" });
    expect(reportOf(statusText({ heartbeatAt: heartbeatAt - 1, turn: "running" }), NOW, STARTED_AT)).toEqual(NOT_SERVING);
    expect(reportOf(statusText({ heartbeatAt: undefined }), NOW, STARTED_AT)).toEqual(NOT_SERVING);
  });

  it("gives the relay of a resumed VM the heartbeat limit from the helper's start to write a new heartbeat", () => {
    const beforeSuspend = statusText({ heartbeatAt: NOW - 3 * 60 * 60_000, turn: "running" });

    expect(reportOf(beforeSuspend, NOW, NOW - 1_000)).toMatchObject({ turn: "running" });
    expect(reportOf(beforeSuspend, NOW, NOW - HEARTBEAT_MAX_AGE_MS - 1)).toEqual(NOT_SERVING);
  });
});
