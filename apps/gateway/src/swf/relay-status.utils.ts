/**
 * The relay's state in a `hunt-ctl status` result of a session VM, free of I/O: the poller (`swf/poller.service.ts`)
 * sends a prompt only to an ACP session whose relay is idle and has no desktop connected.
 */
import type { RelayStatus } from "../../../../libs/domain/src/relay/relay-status.types.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";

/** What the poller reads of `hunt-ctl status`: the relay's status (`status`) while it serves an ACP session, and the session's worktree (`meta`). */
export interface SessionRelayStatus extends Pick<RelayStatus, "clientConnected" | "lastTurnEndedAt"> {
  acpSessionId: NonNullable<RelayStatus["acpSessionId"]>;
  /** Empty when the status reports no turn the relay knows. */
  turn: RelayStatus["turn"] | "";
  worktree: string;
}

/** The relay status of a `hunt-ctl status` result; null while the relay has no ACP session or the worktree is unknown. */
export function relayStatus(result: Record<string, unknown>): SessionRelayStatus | null {
  const status = isRecord(result.status) ? result.status : {};
  const meta = isRecord(result.meta) ? result.meta : {};
  if (typeof status.acpSessionId !== "string" || !status.acpSessionId || typeof meta.worktree !== "string" || !meta.worktree) return null;
  return {
    acpSessionId: status.acpSessionId,
    turn: status.turn === "running" || status.turn === "idle" ? status.turn : "",
    clientConnected: status.clientConnected === true,
    lastTurnEndedAt: typeof status.lastTurnEndedAt === "number" ? status.lastTurnEndedAt : null,
    worktree: meta.worktree,
  };
}
