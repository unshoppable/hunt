import { describe, expect, it } from "vitest";
import { HEARTBEAT_MAX_AGE_MS, relaySessionStatusOf } from "./relay-status-file.utils.ts";

const NOW = 1_800_000_000_000;

function status(fields: Record<string, unknown>): string {
  return JSON.stringify({ heartbeatAt: NOW, state: "ready", acpSessionId: "acp-1", turn: "idle", clientConnected: false, lastTurnEndedAt: null, ...fields });
}

describe("relaySessionStatusOf", () => {
  it("reads the session, the turn, the connected desktop and the last turn end of a ready relay", () => {
    expect(relaySessionStatusOf(status({ turn: "running", clientConnected: true, lastTurnEndedAt: 5 }), NOW)).toEqual({
      acpSessionId: "acp-1",
      turn: "running",
      clientConnected: true,
      lastTurnEndedAt: 5,
    });
    expect(relaySessionStatusOf(status({}), NOW)).toEqual({ acpSessionId: "acp-1", turn: "idle", clientConnected: false, lastTurnEndedAt: null });
  });

  it("is null without a file, for a relay that is starting or failed, without a session and for a stale heartbeat", () => {
    expect(relaySessionStatusOf(null, NOW)).toBeNull();
    expect(relaySessionStatusOf("", NOW)).toBeNull();
    expect(relaySessionStatusOf("not json", NOW)).toBeNull();
    expect(relaySessionStatusOf(status({ state: "starting" }), NOW)).toBeNull();
    expect(relaySessionStatusOf(status({ state: "failed", error: "boom" }), NOW)).toBeNull();
    expect(relaySessionStatusOf(status({ acpSessionId: null }), NOW)).toBeNull();
    expect(relaySessionStatusOf(status({ heartbeatAt: NOW - HEARTBEAT_MAX_AGE_MS - 1 }), NOW)).toBeNull();
    expect(relaySessionStatusOf(status({ heartbeatAt: NOW - HEARTBEAT_MAX_AGE_MS }), NOW)).not.toBeNull();
  });
});
