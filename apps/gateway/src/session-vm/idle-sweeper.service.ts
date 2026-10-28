/**
 * The idle sweeper: suspends session VMs whose session is idle. A session VM cannot suspend itself, so its idle check
 * (`apps/session/vm/hunt-idle-check`) only decides: once a minute this sweeper runs the check with `--dry-run` over SSH
 * on every running session VM and suspends, through the session VM service (`session-vm/session-vm.service.ts`), every
 * VM that reports `idle`. Saved memory costs a fraction of a running VM, and a resume brings the session back in
 * seconds, with its processes. A VM the gateway has not suspended within the check's SUSPEND_WAIT_MINUTES powers itself
 * off instead. `hunt-swf.service` (`swf/swf.main.ts`) calls `cycle()` at every poll; a sweep runs once per
 * IDLE_SWEEP_INTERVAL_MS, the VMs in parallel. A VM that fails (one still booting does not answer over SSH yet, a
 * suspend Compute Engine refuses) is logged once per failure until it passes again.
 */
import type { LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Compute } from "../gcp/compute-engine.client.ts";
import { SESSION_VM_FILTER, SessionVm } from "./session-vm.domain.ts";
import type { SessionVmService } from "./session-vm.service.ts";
import type { SessionVmSsh } from "./session-vm-ssh.client.ts";

export const IDLE_SWEEP_INTERVAL_MS = 60_000;
/** The decision of an idle check that asks for a suspend; the other decisions are `keep:` and `poweroff:`. */
const IDLE_DECISION = "idle:";

export interface IdleSweeperDeps {
  compute: Pick<Compute, "list">;
  sessionVmService: Pick<SessionVmService, "suspend">;
  vm(name: string, zone: string): Pick<SessionVmSsh, "idleDecision">;
  /** The gateway's zone, for a listed VM that names none. */
  zone: string;
  now(): number;
  log(message: string, level?: LogLevel): void;
}

export class IdleSweeper {
  private readonly deps: IdleSweeperDeps;
  private lastSweep: number | null = null;
  /** The last failure of every VM that failed, so that a lasting one is logged once. */
  private readonly failures = new Map<string, string>();

  constructor(deps: IdleSweeperDeps) {
    this.deps = deps;
  }

  /** Sweeps once per IDLE_SWEEP_INTERVAL_MS; a failed listing is logged and retried at the next interval. */
  async cycle(): Promise<void> {
    const now = this.deps.now();
    if (this.lastSweep !== null && now - this.lastSweep < IDLE_SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      await this.sweep();
    } catch (error) {
      this.deps.log(`sweeper: listing the session VMs failed: ${messageOf(error)}`, "error");
    }
  }

  private async sweep(): Promise<void> {
    const instances = await this.deps.compute.list(`${SESSION_VM_FILTER} AND status = RUNNING`);
    const running = instances
      .map((instance) => SessionVm.fromInstance(instance, this.deps.zone))
      .filter((sessionVm) => sessionVm !== null)
      .filter((sessionVm) => sessionVm.isRunning);
    for (const name of this.failures.keys()) {
      if (!running.some((sessionVm) => sessionVm.name === name)) {
        this.failures.delete(name);
      }
    }
    await Promise.all(running.map((sessionVm) => this.check(sessionVm)));
  }

  /** Asks the VM's idle check and suspends the VM when it reports idle. */
  private async check(sessionVm: SessionVm): Promise<void> {
    const { name, zone, sessionId } = sessionVm;
    try {
      if (!sessionId) throw new Error("it names no session");
      const decision = await this.deps.vm(name, zone).idleDecision();
      if (decision.startsWith(IDLE_DECISION)) {
        this.deps.log(`sweeper: suspending ${name} (session ${sessionId.id}): ${decision.slice(IDLE_DECISION.length).trim()}`);
        await this.deps.sessionVmService.suspend(sessionId);
        this.deps.log(`sweeper: suspended ${name}`);
      }
      this.failures.delete(name);
    } catch (error) {
      const message = messageOf(error);
      if (this.failures.get(name) === message) return;
      this.failures.set(name, message);
      this.deps.log(`sweeper: ${name}: ${message}`, "warn");
    }
  }
}
