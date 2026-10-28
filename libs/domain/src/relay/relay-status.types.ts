/**
 * `status.json` in the relay's socket directory (`/run/hunt/status.json` on a session VM), rewritten on every change and
 * as a heartbeat; `hunt-ctl wait` and the VM's idle check read it, and `hunt-ctl status` reports it as `status`. Times
 * are Unix milliseconds; a heartbeat older than two minutes means the relay is gone. The relay writes it through
 * `apps/session/src/relay/relay-status.utils.ts`; the gateway's poller reads it through
 * `apps/gateway/src/swf/relay-status.utils.ts`.
 */

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
  /**
   * Whether the agent waits for the user's answer: the relay serves the session, no turn runs, no permission request
   * is open and the conversation ends with a reply that asks a question (`apps/session/src/relay/trailing-reply.domain.ts`).
   */
  question: boolean;
}
