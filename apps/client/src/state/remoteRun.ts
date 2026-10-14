import type { RemoteStep } from "../ipc/types";

/**
 * The steps a remote operation on a session reached and how long it ran. A move to or from the VM keeps one run across
 * its operations (preparing the VM while the agent works, then the handoff); the wait in between does not count.
 * Timestamps are ms since the epoch.
 */
export type RemoteRun = {
  /** The steps in the order they started; a step that runs again is listed again. */
  steps: RemoteStep[];
  /** When the last step started; `null` between two operations of a move. */
  stepStartedAt: number | null;
  /** When the running operation started; `null` between two operations of a move. */
  operationStartedAt: number | null;
  /** How long the finished operations of the move ran. */
  finishedMs: number;
};

/**
 * `run` after the backend reported `step` at `now`: a new step is appended, a log line about the running step (the same
 * step again) changes nothing. The end of an operation (`step` null) ends the run, or pauses it while `isMoving`.
 */
export function advanceRemoteRun(run: RemoteRun | null, step: RemoteStep | null, now: number, isMoving: boolean): RemoteRun | null {
  if (!step) {
    if (!run || !isMoving) return null;
    return { ...run, stepStartedAt: null, operationStartedAt: null, finishedMs: remoteRunMs(run, now) };
  }
  const current = run ?? { steps: [], stepStartedAt: null, operationStartedAt: null, finishedMs: 0 };
  if (current.stepStartedAt !== null && current.steps[current.steps.length - 1] === step) return current;
  return { ...current, steps: [...current.steps, step], stepStartedAt: now, operationStartedAt: current.operationStartedAt ?? now };
}

/** How long the operations of `run` ran until `now`. */
export function remoteRunMs(run: RemoteRun, now: number): number {
  return run.finishedMs + (run.operationStartedAt === null ? 0 : now - run.operationStartedAt);
}
