import type { SessionView } from "../session.types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a remote session stays idle before Hunt asks whether to retrieve or delete it. */
export const STALE_AFTER_MS = 7 * DAY_MS;
/** How long Hunt waits before asking again after the user chose to keep the session for now. */
export const ASK_AGAIN_AFTER_MS = 3 * DAY_MS;

/** When the agent of the remote `session` last worked: its last prompt or turn, else the handoff. */
export function lastRemoteActivity(session: SessionView): number | null {
  if (!session.remote) return null;
  return Date.parse(session.remote.lastActiveAt ?? session.remote.handedOffAt);
}

/**
 * Whether Hunt should ask about the remote `session` at `now`: idle for `STALE_AFTER_MS`, and either never asked or
 * asked at least `ASK_AGAIN_AFTER_MS` ago. A prompt after the last question starts the idle time anew.
 */
export function isStaleRemote(session: SessionView, now: number): boolean {
  const lastActivity = lastRemoteActivity(session);
  if (lastActivity === null || Number.isNaN(lastActivity) || now - lastActivity < STALE_AFTER_MS) return false;
  const askedAt = session.remote?.cleanupAskedAt;
  if (!askedAt) return true;
  return now - Date.parse(askedAt) >= ASK_AGAIN_AFTER_MS;
}

/** Whole days the remote `session` has been idle at `now`. */
export function idleDays(session: SessionView, now: number): number {
  const lastActivity = lastRemoteActivity(session);
  return lastActivity === null ? 0 : Math.floor((now - lastActivity) / DAY_MS);
}
