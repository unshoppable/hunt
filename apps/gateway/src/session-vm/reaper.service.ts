/**
 * The reaper: deletes session VMs that have been suspended or stopped for longer than RETENTION_DAYS, with their disks,
 * through the session VM service (`session-vm/session-vm.service.ts`). The idle sweeper
 * (`session-vm/idle-sweeper.service.ts`) suspends a session VM half an hour after its last activity, so a VM off that
 * long belongs to a session nobody came back to; Hunt continues such a session on the Mac with what the file sync and
 * the transcript backup left there. `hunt-swf.service` (`swf/swf.main.ts`) calls `cycle()` at every poll; a sweep
 * runs once per REAP_INTERVAL_MS.
 */
import type { LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Compute } from "../gcp/compute-engine.client.ts";
import { SESSION_VM_FILTER, SessionVm } from "./session-vm.domain.ts";
import type { SessionVmService } from "./session-vm.service.ts";

/** How long a session VM may stay stopped before it is deleted. */
export const RETENTION_DAYS = 7;
export const REAP_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface ReaperDeps {
  compute: Pick<Compute, "list" | "get">;
  sessionVmService: Pick<SessionVmService, "delete">;
  /** The gateway's zone, for a listed VM that names none. */
  zone: string;
  now(): number;
  log(message: string, level?: LogLevel): void;
}

export class Reaper {
  private readonly deps: ReaperDeps;
  private lastSweep: number | null = null;

  constructor(deps: ReaperDeps) {
    this.deps = deps;
  }

  /** Sweeps once per REAP_INTERVAL_MS; a failed sweep is logged and retried at the next interval. */
  async cycle(): Promise<void> {
    const now = this.deps.now();
    if (this.lastSweep !== null && now - this.lastSweep < REAP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      await this.sweep(now);
    } catch (error) {
      this.deps.log(`reaper: listing the session VMs failed: ${messageOf(error)}`, "error");
    }
  }

  private async sweep(now: number): Promise<void> {
    const instances = await this.deps.compute.list(SESSION_VM_FILTER);
    for (const instance of instances) {
      const sessionVm = SessionVm.fromInstance(instance, this.deps.zone);
      if (!sessionVm) continue;
      const since = sessionVm.offSince;
      if (since === null || now - since < RETENTION_DAYS * DAY_MS) continue;
      await this.reap(sessionVm, now - since);
    }
  }

  /**
   * Deletes the VM unless it is running again: hunt-api is another process and may have started it since the listing.
   * A VM that names no session cannot be deleted through the session VM service and is reported instead.
   */
  private async reap(sessionVm: SessionVm, offFor: number): Promise<void> {
    const { name, zone, sessionId } = sessionVm;
    const days = Math.floor(offFor / DAY_MS);
    if (!sessionId) {
      this.deps.log(`reaper: ${name} has been off for ${days} days but names no session; delete it by hand`, "warn");
      return;
    }
    try {
      const current = await this.deps.compute.get(zone, name);
      if (!current) {
        this.deps.log(`reaper: ${name} is already gone`);
        return;
      }
      const currentVm = SessionVm.fromInstance(current, zone);
      if (!currentVm || currentVm.offSince === null) {
        this.deps.log(`reaper: keeping ${name}: it is ${current.status}`);
        return;
      }
      this.deps.log(`reaper: deleting ${name} (session ${sessionId.id}, origin ${sessionVm.origin || "unknown"}, off for ${days} days)`);
      await this.deps.sessionVmService.delete(sessionId);
    } catch (error) {
      this.deps.log(`reaper: deleting ${name} failed: ${messageOf(error)}`, "error");
    }
  }
}
