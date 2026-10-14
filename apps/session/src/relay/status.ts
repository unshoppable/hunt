/**
 * `status.json` in the socket directory (`/run/hunt/status.json` on a session VM), rewritten on every change and as a
 * heartbeat; `hunt-ctl wait` and the VM's idle check read it. Times are Unix milliseconds; a heartbeat older than two
 * minutes means the relay is gone.
 */
import { writeJsonAtomic } from "./files.ts";

export type RelayState = "starting" | "ready" | "failed";
export type TurnState = "running" | "idle";

export interface RelayStatus {
  heartbeatAt: number;
  state: RelayState;
  /** Why the start failed; null unless `state` is `failed`. */
  error: string | null;
  acpSessionId: string | null;
  turn: TurnState;
  clientConnected: boolean;
  lastClientActivityAt: number | null;
  lastTurnEndedAt: number | null;
  /** When the oldest unanswered permission request arrived; null when none is open. */
  pendingPermissionSince: number | null;
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

export function writeStatusFile(path: string, status: RelayStatus): void {
  writeJsonAtomic(path, status);
}
