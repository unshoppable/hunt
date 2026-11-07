/**
 * What the runner (`swf-runner.service.ts`) reads from the relay's `status.json` (`libs/domain/src/relay/relay-status.types.ts`),
 * free of I/O: the session the relay serves, whether a turn runs, when the last turn ended and whether it took a slash
 * command. `hunt-ctl clear` prints the same status once the fresh conversation is ready.
 */
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { parseLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";

/** A heartbeat older than this means the relay is gone; `hunt-ctl` and `hunt-idle-check` use the same limit. */
export const HEARTBEAT_MAX_AGE_MS = 120_000;

export interface RelaySessionStatus {
  acpSessionId: string;
  turn: "running" | "idle";
  /** Null until a turn ended since the relay started. */
  lastTurnEndedAt: number | null;
  /** Whether the turn that ended last took a slash command such as `/compact`; false from a relay too old to report it. */
  lastTurnTookCommand: boolean;
}

/**
 * The status in `text`, the content of `status.json` or the output of `hunt-ctl clear`, at `now`; null while the relay
 * serves no session: the text holds none, the relay is starting or failed, or its heartbeat is older than
 * HEARTBEAT_MAX_AGE_MS (after a suspend the file holds the heartbeat from before it until the relay writes the next).
 */
export function relaySessionStatusOf(text: string | null, now: number): RelaySessionStatus | null {
  if (!text) return null;
  const status = parseLine(text);
  if (!isRecord(status) || status.state !== "ready") return null;
  const { acpSessionId, turn, heartbeatAt, lastTurnEndedAt, lastTurnTookCommand } = status;
  if (typeof acpSessionId !== "string" || !acpSessionId) return null;
  if (turn !== "running" && turn !== "idle") return null;
  if ((typeof heartbeatAt === "number" ? heartbeatAt : 0) < now - HEARTBEAT_MAX_AGE_MS) return null;
  return {
    acpSessionId,
    turn,
    lastTurnEndedAt: typeof lastTurnEndedAt === "number" ? lastTurnEndedAt : null,
    lastTurnTookCommand: lastTurnTookCommand === true,
  };
}
