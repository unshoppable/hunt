/**
 * Suspends session VMs whose session is idle. A session VM cannot suspend itself, so its idle check
 * (`apps/session/vm/hunt-idle-check`) only decides: once a minute this sweeper runs the check with `--dry-run` over SSH
 * on every running session VM and suspends, through the Compute Engine API, every VM that reports `idle`. Saved memory
 * costs a fraction of a running VM, and a resume brings the session back in seconds, with its processes. A VM the
 * gateway has not suspended within the check's SUSPEND_WAIT_MINUTES powers itself off instead. `hunt-swf.service`
 * (`swf.ts`) calls `cycle()` at every poll; a sweep runs once per SWEEP_INTERVAL_MS, the VMs in parallel. A VM that
 * fails (one still booting does not answer over SSH yet, a suspend Compute Engine refuses) is logged once per failure
 * until it passes again.
 */
import type { LogLevel } from "../../../libs/domain/src/journal.ts";
import { messageOf } from "../../../libs/domain/src/errors.ts";
import type { Compute, Instance } from "./gcp.ts";
import { ROLE_LABEL, SESSION_ROLE, sessionSummary, type Orchestrator } from "./orchestrator.ts";
import type { SessionVm } from "./sessionVm.ts";

export const SWEEP_INTERVAL_MS = 60_000;
/** The decision of an idle check that asks for a suspend; the other decisions are `keep:` and `poweroff:`. */
const IDLE_DECISION = "idle:";

export interface IdleSweeperDeps {
  compute: Pick<Compute, "list">;
  orchestrator: Pick<Orchestrator, "suspend">;
  vm(name: string, zone: string): Pick<SessionVm, "idleDecision">;
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

  /** Sweeps once per SWEEP_INTERVAL_MS; a failed listing is logged and retried at the next interval. */
  async cycle(): Promise<void> {
    const now = this.deps.now();
    if (this.lastSweep !== null && now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    try {
      await this.sweep();
    } catch (error) {
      this.deps.log(`sweeper: listing the session VMs failed: ${messageOf(error)}`, "error");
    }
  }

  private async sweep(): Promise<void> {
    const instances = await this.deps.compute.list(`labels.${ROLE_LABEL} = "${SESSION_ROLE}" AND status = RUNNING`);
    const running = instances.filter((instance) => instance.labels[ROLE_LABEL] === SESSION_ROLE && instance.status === "RUNNING");
    for (const name of this.failures.keys()) {
      if (!running.some((instance) => instance.name === name)) {
        this.failures.delete(name);
      }
    }
    await Promise.all(running.map((instance) => this.check(instance)));
  }

  /** Asks the VM's idle check and suspends the VM when it reports idle. */
  private async check(instance: Instance): Promise<void> {
    const zone = instance.zone || this.deps.zone;
    const session = sessionSummary(instance, zone);
    try {
      if (!session) throw new Error("it names no session");
      const decision = await this.deps.vm(instance.name, zone).idleDecision();
      if (decision.startsWith(IDLE_DECISION)) {
        this.deps.log(`sweeper: suspending ${instance.name} (session ${session.id}): ${decision.slice(IDLE_DECISION.length).trim()}`);
        await this.deps.orchestrator.suspend(session.id);
        this.deps.log(`sweeper: suspended ${instance.name}`);
      }
      this.failures.delete(instance.name);
    } catch (error) {
      const message = messageOf(error);
      if (this.failures.get(instance.name) === message) return;
      this.failures.set(instance.name, message);
      this.deps.log(`sweeper: ${instance.name}: ${message}`, "warn");
    }
  }
}
