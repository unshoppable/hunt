/**
 * The Compute Engine statuses of a session VM that the gateway tells apart: a stopped VM (whose `lastStopTimestamp` says
 * since when), an off VM (stopped or suspended: it does not count towards the session limit, the poller starts it for
 * an answer and the reaper deletes it once it stays off) and a VM that is shutting down.
 */
const STOPPED_STATUSES = new Set(["TERMINATED", "STOPPED"]);
const OFF_STATUSES = new Set([...STOPPED_STATUSES, "SUSPENDED"]);
const SHUTDOWN_STATUSES = new Set(["STOPPING", "SUSPENDING"]);

export function isStoppedStatus(status: string): boolean {
  return STOPPED_STATUSES.has(status);
}

export function isOffStatus(status: string): boolean {
  return OFF_STATUSES.has(status);
}

export function isShuttingDownStatus(status: string): boolean {
  return SHUTDOWN_STATUSES.has(status);
}
