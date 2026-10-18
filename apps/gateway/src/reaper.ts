/**
 * Deletes session VMs that have been suspended or stopped for longer than RETENTION_DAYS, with their disks. The idle
 * sweeper (`idle.ts`) suspends a session VM half an hour after its last activity, so a VM off that long belongs to a
 * session nobody came back to; Hunt continues such a session on the Mac with what the file sync and the transcript
 * backup left there.
 * `hunt-swf.service` (`swf.ts`) calls `cycle()` at every poll; a sweep runs once per SWEEP_INTERVAL_MS.
 */
import type { LogLevel } from "../../../libs/domain/src/journal.ts";
import { messageOf } from "../../../libs/domain/src/errors.ts";
import type { Compute, Instance } from "./gcp.ts";
import { ROLE_LABEL, SESSION_ROLE, sessionSummary, type Orchestrator } from "./orchestrator.ts";
import { STOPPED_STATUSES } from "./swfPlan.ts";

/** How long a session VM may stay stopped before it is deleted. */
export const RETENTION_DAYS = 7;
export const SWEEP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface ReaperDeps {
  compute: Pick<Compute, "list" | "get">;
  orchestrator: Pick<Orchestrator, "delete">;
  /** The gateway's zone, for a listed VM that names none. */
  zone: string;
  now(): number;
  log(message: string, level?: LogLevel): void;
}

/** When `instance` went off: its last stop or suspension; null while it runs or when Compute Engine records no time. */
export function offSince(instance: Instance): number | null {
  const time = STOPPED_STATUSES.has(instance.status) ? instance.lastStopTimestamp : instance.status === "SUSPENDED" ? instance.lastSuspendedTimestamp : "";
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? null : parsed;
}

export class Reaper {
  private readonly deps: ReaperDeps;
  private lastSweep: number | null = null;

  constructor(deps: ReaperDeps) {
    this.deps = deps;
  }

  /** Sweeps once per SWEEP_INTERVAL_MS; a failed sweep is logged and retried at the next interval. */
  async cycle(): Promise<void> {
    const now = this.deps.now();
    if (this.lastSweep !== null && now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      await this.sweep(now);
    } catch (error) {
      this.deps.log(`reaper: listing the session VMs failed: ${messageOf(error)}`, "error");
    }
  }

  private async sweep(now: number): Promise<void> {
    const instances = await this.deps.compute.list(`labels.${ROLE_LABEL} = "${SESSION_ROLE}"`);
    for (const instance of instances) {
      if (instance.labels[ROLE_LABEL] !== SESSION_ROLE) continue;
      const since = offSince(instance);
      if (since === null || now - since < RETENTION_DAYS * DAY_MS) continue;
      await this.reap(instance, now - since);
    }
  }

  /**
   * Deletes `instance` unless it is running again: hunt-api is another process and may have started it since the
   * listing. A VM that names no session cannot be deleted through the orchestrator and is reported instead.
   */
  private async reap(instance: Instance, offFor: number): Promise<void> {
    const zone = instance.zone || this.deps.zone;
    const session = sessionSummary(instance, zone);
    const days = Math.floor(offFor / DAY_MS);
    if (!session) {
      this.deps.log(`reaper: ${instance.name} has been off for ${days} days but names no session; delete it by hand`, "warn");
      return;
    }
    try {
      const current = await this.deps.compute.get(zone, instance.name);
      if (!current) {
        this.deps.log(`reaper: ${instance.name} is already gone`);
        return;
      }
      if (offSince(current) === null) {
        this.deps.log(`reaper: keeping ${instance.name}: it is ${current.status}`);
        return;
      }
      this.deps.log(`reaper: deleting ${instance.name} (session ${session.id}, origin ${session.origin || "unknown"}, off for ${days} days)`);
      await this.deps.orchestrator.delete(session.id);
    } catch (error) {
      this.deps.log(`reaper: deleting ${instance.name} failed: ${messageOf(error)}`, "error");
    }
  }
}
