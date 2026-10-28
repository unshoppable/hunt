import { describe, expect, it } from "vitest";
import { relayStatus } from "./relay-status.utils.ts";

/** The `hunt-ctl status` result of a relay whose last turn ended at `lastTurnEndedAt` (null: none ended yet). */
function statusOf(turn: "running" | "idle", lastTurnEndedAt: number | null, clientConnected = false): Record<string, unknown> {
  return { relay: "running", status: { state: "ready", acpSessionId: "acp-9", turn, clientConnected, lastTurnEndedAt }, meta: { worktree: "/home/agent/app" } };
}

describe("relayStatus", () => {
  it("reads the relay's turn and the worktree, and is null without an ACP session or worktree", () => {
    expect(relayStatus(statusOf("idle", 5, true))).toEqual({ acpSessionId: "acp-9", turn: "idle", clientConnected: true, lastTurnEndedAt: 5, worktree: "/home/agent/app" });
    expect(relayStatus({ relay: "stopped", status: {}, meta: { worktree: "/home/agent/app" } })).toBeNull();
    expect(relayStatus({ relay: "running", status: { acpSessionId: "acp-9" }, meta: {} })).toBeNull();
  });
});
