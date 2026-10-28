/**
 * The session VM service: the control plane of the session VMs (`session-vm/session-vm.domain.ts`), shared by the gateway
 * API (`gateway-api/gateway-api.service.ts`) and the poller (`swf/poller.service.ts`). It provisions, starts, suspends,
 * stops and deletes the VM of a session, `vm-hunt-s-<short id>` (`<short id>`: the first 8 hex digits of the session
 * ID), and lists the sessions the VMs hold. A new VM is created from an instance template with the labels
 * `hunt-role=session`, `hunt-session=<short id>`, `hunt-origin=desktop|swf` and, for a person's session,
 * `hunt-owner=<OS Login user>`; provisioning records the session in its metadata and, for a poller session, the first
 * state of its agent.
 *
 * A new VM goes into the first of the session zones (`shared/session-zones.utils.ts`) that has capacity for its machine type: when
 * Compute Engine answers a zone with a stockout, the next zone is tried. An existing VM whose own zone has no capacity
 * for its start moves to the first other session zone that has, in list order: its boot disk is snapshotted
 * (`vm-hunt-s-<short id>-move`), the VM is renamed to `vm-hunt-s-<short id>-moving`, a VM from the template with a boot
 * disk from the snapshot and the old VM's labels, machine type and metadata is created in the new zone, and the old VM
 * and the snapshot are deleted. Compute Engine creates the disk with the VM, so a creation a stockout refuses leaves no
 * disk behind. When every zone is out, the VM gets its name back. A move an earlier call left unfinished is finished or
 * rolled back before the VM is used again. hunt-api starts existing VMs for the desktops and hunt-swf (`swf/poller.service.ts`) the
 * stopped VM of an agent whose question got its answer; the two processes share no lock, so a start of one VM from
 * both at once is not guarded. A suspended VM whose zone has no capacity for its resume is stopped first, which
 * discards its saved memory, and then moved like a stopped one.
 *
 * Bringing a VM up starts a stopped one, resumes a suspended one and waits out a shutdown in progress, then waits until
 * it answers over SSH (`session-vm/session-vm-ssh.client.ts`) and its startup script finished, which puts the remote
 * secrets on it in the same command (`hunt-ctl put-remote-secrets`, which `hunt-ctl session-config` gives the services),
 * and hands it the staged session release; a VM whose release is too old to take the secrets with the check gets them
 * after. Calls that bring up the VM of one session share one operation: a second identical call joins the first and
 * hears its progress from the start, a different one waits until the first ended. `createSessionVmService` wires the
 * service to the gateway's project for hunt-api and hunt-swf.
 */
import type { ProgressStep, ReleaseInfo, SessionSummary, VmRef } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Log } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import type { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { isOffStatus, isShuttingDownStatus } from "../../../../libs/domain/src/session/vm-status.utils.ts";
import {
  isStockout,
  mergeMetadataItems,
  type Compute,
  type Disk,
  type Instance,
  type Operation as ComputeOperation,
  type OperationError,
} from "../gcp/compute-engine.client.ts";
import type { Metadata } from "../gcp/metadata-server.client.ts";
import { remoteSecretStore, type RemoteSecretStore } from "../remote-secrets/remote-secrets.service.ts";
import { readSessionZones } from "../shared/session-zones.utils.ts";
import {
  AGENT_METADATA,
  BRANCH_METADATA,
  ISSUE_METADATA,
  labelValue,
  ORIGIN_LABEL,
  OWNER_LABEL,
  REPO_METADATA,
  ROLE_LABEL,
  SESSION_ID_METADATA,
  SESSION_LABEL,
  SESSION_ROLE,
  SESSION_VM_FILTER,
  SessionVm,
  TITLE_METADATA,
} from "./session-vm.domain.ts";
import { createSessionVmSsh, type SessionVmSsh, type VmLocation } from "./session-vm-ssh.client.ts";

/** The instance template session VMs are created from. */
export const DEFAULT_TEMPLATE = "tpl-hunt-session";

export const CREATE_TIMEOUT_MS = 2 * 60_000;
export const START_TIMEOUT_MS = 6 * 60_000;
export const READY_TIMEOUT_MS = 15 * 60_000;
export const DISK_TIMEOUT_MS = 2 * 60_000;
export const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
/** Compute Engine writes the VM's memory to storage; 31 GB take a minute or two. */
export const SUSPEND_TIMEOUT_MS = 10 * 60_000;
/** How often the status of a VM is read while it changes, and the pause after an operation wait that passed its deadline. */
export const INSTANCE_POLL_MS = 1_000;
const METADATA_ATTEMPTS = 3;

export type Origin = "desktop" | "swf";

/** Hears what a running operation does: the progress steps of the API contract and log lines. */
export interface Reporter {
  progress(step: ProgressStep): void;
  log(message: string): void;
}

export const SILENT: Reporter = { progress: () => {}, log: () => {} };

export interface ProvisionRequest {
  sessionId: SessionId;
  title: string;
  repo: Repository;
  branch: BranchName;
  /** The GitHub issue of a poller session; null for a person's session. */
  issue: number | null;
  origin: Origin;
  /** The OS Login user who asked for the session; empty for the poller. */
  owner: string;
  template: string;
  /** A machine type other than the template's; null keeps the template's. */
  machineType: string | null;
}

export interface ProvisionResult {
  vm: VmRef;
  created: boolean;
  release: ReleaseInfo;
}

export interface StartResult {
  vm: VmRef;
  wasRunning: boolean;
  release: ReleaseInfo;
}

export interface SessionVmServiceDeps {
  compute: Compute;
  /** The gateway's project, where the session VMs live, and its zone. */
  location: VmLocation;
  /** The zones a new session VM may go into, in order of preference. */
  zones(): string[];
  vm(name: string, zone: string): SessionVmSsh;
  /** Every remote secret by name (`remote-secrets/remote-secrets.service.ts`), which each VM gets when it is brought up. */
  remoteSecrets(): Promise<Record<string, string>>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

type Event = { type: "progress"; step: ProgressStep } | { type: "log"; message: string };

interface Operation {
  /** What the operation does; a call with the same key joins it. */
  key: string;
  promise: Promise<unknown>;
  events: Event[];
  reporters: Set<Reporter>;
}

/** Whether `error` says the resource is gone already. */
function isGone(error: unknown): boolean {
  return messageOf(error).includes("HTTP 404");
}

/** `instance` as a session VM; refuses a VM that is no session VM or that holds another session than `sessionId`. */
function checkSession(instance: Instance, sessionId: SessionId): SessionVm {
  const sessionVm = SessionVm.fromInstance(instance);
  if (!sessionVm) throw new ApiError("forbidden", `${instance.name} is no session VM: it lacks the label ${ROLE_LABEL}=${SESSION_ROLE}`);
  sessionVm.assertHoldsSession(sessionId);
  return sessionVm;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}

/** `items` as an English list: `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export class SessionVmService {
  private readonly deps: SessionVmServiceDeps;
  /** The operation that brings a session's VM up, by session ID. */
  private readonly operations = new Map<string, Operation>();

  constructor(deps: SessionVmServiceDeps) {
    this.deps = deps;
  }

  /**
   * Creates the session's VM unless it exists, records the session in its metadata, brings it up and hands it the
   * staged session release. `creatingVm` means Compute Engine accepted the new VM. A conflict when the VM holds
   * another session.
   */
  provision(request: ProvisionRequest, reporter: Reporter): Promise<ProvisionResult> {
    return this.exclusive(request.sessionId, `provision ${JSON.stringify(request)}`, reporter, (shared) => this.runProvision(request, shared));
  }

  /** Brings the session's VM up; see the module comment. */
  start(sessionId: SessionId, reporter: Reporter): Promise<StartResult> {
    return this.exclusive(sessionId, "start", reporter, async (shared) => {
      const instance = await this.recover(sessionId, shared);
      if (!instance) throw new ApiError("notFound", `the session ${sessionId.id} has no VM ${sessionId.vm.name}`);
      checkSession(instance, sessionId);
      const { zone, wasRunning, release } = await this.bringUp(instance.zone, sessionId, shared);
      return { vm: this.ref(sessionId.vm.name, zone), wasRunning, release };
    });
  }

  /**
   * Suspends the session's VM unless it is not running, and waits until Compute Engine has done it; a VM still under its
   * moving name is off. The idle sweeper (`session-vm/idle-sweeper.service.ts`) calls this for a VM whose session is idle.
   */
  async suspend(sessionId: SessionId): Promise<void> {
    const { vm, moving } = await this.locateSession(sessionId);
    if (!vm && !moving) throw new ApiError("notFound", `the session ${sessionId.id} has no VM ${sessionId.vm.name}`);
    if (!vm) return;
    const sessionVm = checkSession(vm, sessionId);
    if (!sessionVm.isRunning) return;
    const operation = await this.deps.compute.suspend(vm.zone, sessionId.vm.name);
    const error = await this.waitForOperation(operation, SUSPEND_TIMEOUT_MS, `suspend ${sessionId.vm.name}`);
    if (error) throw new ApiError("unavailable", `failed to suspend ${sessionId.vm.name}: ${(error.message || error.code).replace(/\.$/, "")}`);
  }

  /** Stops the session's VM unless it is off or shuts down already; a VM still under its moving name is off. */
  async stop(sessionId: SessionId): Promise<void> {
    const { vm, moving } = await this.locateSession(sessionId);
    if (!vm && !moving) throw new ApiError("notFound", `the session ${sessionId.id} has no VM ${sessionId.vm.name}`);
    if (!vm) return;
    const sessionVm = checkSession(vm, sessionId);
    if (sessionVm.isStoppedOrStopping) return;
    await this.deps.compute.stop(vm.zone, sessionId.vm.name);
  }

  /**
   * Deletes the session's VM with all its disks, and with it whatever an unfinished move left (the VM under its moving
   * name, the snapshot); returns once Compute Engine accepted the deletion.
   */
  async delete(sessionId: SessionId): Promise<{ alreadyGone: boolean }> {
    const { vm, moving } = await this.locateSession(sessionId);
    let isDeleted = false;
    for (const instance of [vm, moving]) {
      if (!instance) continue;
      checkSession(instance, sessionId);
      try {
        await this.deleteInstance(instance);
        isDeleted = true;
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    }
    if (moving) {
      await this.discardSnapshot(sessionId.vm.snapshotName, SILENT);
    }
    return { alreadyGone: !isDeleted };
  }

  async get(sessionId: SessionId): Promise<{ exists: boolean; name: string; status: string | null }> {
    const { vm, moving } = await this.locateSession(sessionId);
    const instance = vm ?? moving;
    return { exists: instance !== null, name: sessionId.vm.name, status: instance?.status ?? null };
  }

  /** The session VMs of every zone of the gateway's project, oldest first. */
  async listSessions(): Promise<SessionSummary[]> {
    const instances = await this.deps.compute.list(SESSION_VM_FILTER);
    const sessions = instances
      .map((instance) => SessionVm.fromInstance(instance, this.deps.location.zone)?.summary ?? null)
      .filter((session) => session !== null);
    return sessions.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  }

  private async runProvision(request: ProvisionRequest, reporter: Reporter): Promise<ProvisionResult> {
    const { sessionId } = request;
    const existing = await this.recover(sessionId, reporter);
    let zone: string;
    if (existing) {
      checkSession(existing, sessionId);
      reporter.log(`${sessionId.vm.name} exists already in ${existing.zone}`);
      zone = existing.zone;
    } else {
      zone = await this.create(sessionId, request, reporter);
    }
    const entries: Record<string, string> = {
      [SESSION_ID_METADATA]: sessionId.id,
      [REPO_METADATA]: request.repo.slug,
      [BRANCH_METADATA]: request.branch.name,
      [TITLE_METADATA]: request.title,
    };
    if (request.issue !== null) {
      entries[ISSUE_METADATA] = String(request.issue);
    }
    if (request.origin === "swf") {
      entries[AGENT_METADATA] = "plan";
    }
    await this.recordSession(zone, sessionId, entries);
    const broughtUp = await this.bringUp(zone, sessionId, reporter);
    return { vm: this.ref(sessionId.vm.name, broughtUp.zone), created: !existing, release: broughtUp.release };
  }

  /**
   * Creates the session's VM in the first session zone with capacity for it and returns that zone. Only a stockout moves
   * on to the next zone; any other failure ends the provision.
   */
  private async create(sessionId: SessionId, request: ProvisionRequest, reporter: Reporter): Promise<string> {
    const labels: Record<string, string> = { [ROLE_LABEL]: SESSION_ROLE, [SESSION_LABEL]: sessionId.short, [ORIGIN_LABEL]: request.origin };
    if (request.owner) {
      labels[OWNER_LABEL] = labelValue(request.owner);
    }
    const zones = this.deps.zones();
    let machineType = request.machineType;
    let isReported = false;
    for (const [index, zone] of zones.entries()) {
      let error: OperationError | null;
      try {
        const instanceRequest = { name: sessionId.vm.name, template: request.template, machineType: request.machineType, labels };
        const operation = await this.deps.compute.insert(zone, instanceRequest);
        if (!isReported) {
          reporter.progress("creatingVm");
          isReported = true;
        }
        reporter.log(`creating ${sessionId.vm.name} from ${request.template} in ${zone}`);
        error = await this.waitForOperation(operation, CREATE_TIMEOUT_MS, `create ${sessionId.vm.name} in ${zone}`);
      } catch (thrown) {
        if (!isStockout(messageOf(thrown))) throw thrown;
        error = { code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: messageOf(thrown), machineType: null };
      }
      if (!error) return zone;
      if (!isStockout(error.code)) throw new ApiError("unavailable", `failed to create ${sessionId.vm.name} in ${zone}: ${error.message || error.code}`);
      machineType = error.machineType ?? machineType;
      const next = zones[index + 1];
      reporter.log(`${machineType ?? "its machine type"} is unavailable in ${zone}${next ? `; trying ${next}` : ""}`);
    }
    const type = machineType ?? "its machine type";
    throw new ApiError(
      "unavailable",
      `failed to create ${sessionId.vm.name}: ${type} is unavailable in ${listed(zones)}; try again later or pick another machine type`,
    );
  }

  /**
   * Adds `entries` to the metadata of the session's VM in `zone`, keeping the template's keys and the entries it has;
   * retries when the metadata changed meanwhile. Nothing is written when the VM has the entries already.
   */
  async recordSession(zone: string, sessionId: SessionId, entries: Record<string, string>): Promise<void> {
    const name = sessionId.vm.name;
    for (let attempt = 1; ; attempt++) {
      const instance = await this.deps.compute.get(zone, name);
      if (!instance) throw new ApiError("notFound", `failed to record the session in ${name}: it does not exist`);
      if (checkSession(instance, sessionId).hasMetadataEntries(entries)) return;
      try {
        await this.deps.compute.setMetadata(zone, name, instance.metadata.fingerprint, mergeMetadataItems(instance.metadata.items, entries));
        return;
      } catch (error) {
        if (attempt >= METADATA_ATTEMPTS || !messageOf(error).includes("HTTP 412")) throw error;
      }
    }
  }

  /**
   * Starts or resumes the session's VM in `initialZone` unless it runs, waits until it is ready and hands it the staged
   * session release. A stopped VM whose zone has no capacity for its start moves to the next session zone that has
   * (`move`); a suspended one whose zone has no capacity for its resume is stopped and, once it is off, started and so
   * moved the same way; any other start Compute Engine refuses fails at once. Returns the zone the VM runs in.
   */
  private async bringUp(initialZone: string, sessionId: SessionId, reporter: Reporter): Promise<{ zone: string; wasRunning: boolean; release: ReleaseInfo }> {
    const name = sessionId.vm.name;
    let zone = initialZone;
    let deadline = this.deps.now() + START_TIMEOUT_MS;
    let wasRunning: boolean | null = null;
    let isStarting = false;
    let isStopping = false;
    let reported: ProgressStep | null = null;
    const report = (step: ProgressStep) => {
      if (reported === step) return;
      reporter.progress(step);
      reported = step;
    };
    for (;;) {
      const instance = await this.deps.compute.get(zone, name);
      if (!instance) throw new ApiError("notFound", `${name} does not exist`);
      wasRunning ??= instance.status === "RUNNING";
      if (instance.status === "RUNNING") break;
      if (isStopping && instance.status !== "SUSPENDED" && !isShuttingDownStatus(instance.status)) {
        isStopping = false;
      }
      if (isOffStatus(instance.status) && !isStarting && !isStopping) {
        const verb = instance.status === "SUSPENDED" ? "resume" : "start";
        report(verb === "resume" ? "resumingVm" : "startingVm");
        const operation = await this.deps.compute[verb](zone, name);
        reporter.log(`${verb === "start" ? "starting" : "resuming"} ${name}`);
        isStarting = true;
        const error = await this.waitForOperation(operation, Math.max(deadline - this.deps.now(), 0), `${verb} ${name}`);
        // A finished operation left the VM running, or about to be: read its status right away.
        if (!error) continue;
        const others = this.deps.zones().filter((candidate) => candidate !== zone);
        if (isStockout(error.code) && others.length > 0) {
          if (verb === "start") {
            zone = await this.move(instance, sessionId, error.machineType, others, reporter);
            deadline = this.deps.now() + START_TIMEOUT_MS;
            continue;
          }
          reporter.log(`${error.machineType ?? "its machine type"} is unavailable in ${zone}; stopping ${name} to move it`);
          await this.stopForMove(zone, name, error);
          isStarting = false;
          isStopping = true;
        } else {
          const reason = (error.message || error.code).replace(/\.$/, "");
          const stays = isStockout(error.code) ? `; its disk stays in ${zone}, try again later` : "";
          throw new ApiError("unavailable", `failed to ${verb} ${name}: ${reason}${stays}`);
        }
      } else if (isShuttingDownStatus(instance.status) || isStopping) {
        if (!reported) {
          report("startingVm");
          reporter.log(`waiting for ${name} to finish shutting down`);
        }
        isStarting = false;
      }
      if (this.deps.now() >= deadline) {
        throw new ApiError("unavailable", `failed to start ${name}: it is still ${instance.status} after ${minutes(START_TIMEOUT_MS)}`);
      }
      await this.deps.sleep(INSTANCE_POLL_MS);
    }

    const vm = this.deps.vm(name, zone);
    const secrets = await this.deps.remoteSecrets();
    const ready = await vm.waitUntilReady(
      READY_TIMEOUT_MS,
      secrets,
      () => reporter.progress("waitingForVm"),
      (reason) => reporter.log(`${name} does not answer yet: ${reason}`),
    );
    reporter.progress("vmReady");
    reporter.log(`${name} is ready; checking its release`);
    const release = await vm.ensureRelease(ready.installedHash, () => {
      reporter.progress("installingRuntime");
      reporter.log(`installing the staged session release on ${name}`);
    });
    if (!ready.hasSecrets) {
      await vm.huntCtl(["put-remote-secrets"], JSON.stringify(secrets));
    }
    reporter.log(`put the remote secrets on ${name} (${Object.keys(secrets).length})`);
    return { zone, wasRunning, release };
  }

  /**
   * Stops the suspended VM `name` in `zone`, whose resume `stockout` refused, so that it can be moved; when Compute
   * Engine refuses the stop, the resume fails with both messages.
   */
  private async stopForMove(zone: string, name: string, stockout: OperationError): Promise<void> {
    try {
      await this.deps.compute.stop(zone, name);
    } catch (error) {
      const reason = (stockout.message || stockout.code).replace(/\.$/, "");
      throw new ApiError("unavailable", `failed to resume ${name}: ${reason}; stopping it to move it failed: ${messageOf(error)}`);
    }
  }

  /**
   * Moves the session's VM `instance`, which is off in a zone without capacity for its machine type (`machineType`
   * when the stockout named it), to the first of `zones` with capacity, and returns that zone; see the module comment.
   * Nothing changes the VM before its disk is snapshotted; when every zone is out, it gets its name back and the start
   * fails with the zones tried.
   */
  private async move(instance: Instance, sessionId: SessionId, machineType: string | null, zones: string[], reporter: Reporter): Promise<string> {
    const oldZone = instance.zone;
    const moving = sessionId.vm.movingName;
    const snapshot = sessionId.vm.snapshotName;
    let type = machineType ?? (instance.machineType || "its machine type");
    reporter.progress("movingVm");
    reporter.log(`${type} is unavailable in ${oldZone}; moving ${sessionId.vm.name} to another zone`);
    const bootDisk = instance.disks.find((disk) => disk.boot);
    if (!bootDisk) throw new ApiError("unavailable", `failed to move ${sessionId.vm.name}: it has no boot disk`);
    const diskName = bootDisk.source || sessionId.vm.name;
    await this.discardSnapshot(snapshot, reporter, true);
    const disk = await this.deps.compute.getDisk(oldZone, diskName);
    reporter.log(`snapshotting the disk ${diskName} of ${sessionId.vm.name} in ${oldZone} as ${snapshot}`);
    const snapshotOperation = await this.deps.compute.createSnapshot(oldZone, diskName, snapshot);
    const snapshotError = await this.waitForOperation(snapshotOperation, SNAPSHOT_TIMEOUT_MS, `snapshot the disk of ${sessionId.vm.name}`);
    if (snapshotError) {
      throw new ApiError("unavailable", `failed to move ${sessionId.vm.name}: snapshotting its disk failed: ${snapshotError.message || snapshotError.code}`);
    }
    try {
      await this.rename(oldZone, sessionId.vm.name, moving);
    } catch (error) {
      await this.discardSnapshot(snapshot, reporter);
      throw error;
    }
    try {
      for (const [index, zone] of zones.entries()) {
        const stockout = await this.createMovedVm(zone, instance, sessionId, snapshot, disk, reporter);
        if (!stockout) {
          reporter.log(`moved ${sessionId.vm.name} from ${oldZone} to ${zone}; deleting the VM it replaced and the snapshot`);
          await this.discard(this.deleteInstance({ ...instance, name: moving }), reporter, `delete ${moving}`);
          await this.discardSnapshot(snapshot, reporter);
          return zone;
        }
        type = stockout.machineType ?? type;
        const next = zones[index + 1];
        reporter.log(`${type} is unavailable in ${zone}${next ? `; trying ${next}` : ""}`);
      }
    } catch (error) {
      await this.rollBackMove(oldZone, sessionId, reporter);
      throw error;
    }
    await this.rollBackMove(oldZone, sessionId, reporter);
    throw new ApiError("unavailable", `failed to start ${sessionId.vm.name}: ${type} is unavailable in ${listed([oldZone, ...zones])}; try again later`);
  }

  /**
   * Creates the session's VM in `zone` from the template with a boot disk Compute Engine makes from `snapshot` (of the
   * type and size of `disk`) and the labels, machine type and metadata of `instance`, the VM it replaces. Returns the
   * stockout that prevented it, which leaves nothing behind in `zone`; any other failure throws.
   */
  private async createMovedVm(
    zone: string,
    instance: Instance,
    sessionId: SessionId,
    snapshot: string,
    disk: Disk,
    reporter: Reporter,
  ): Promise<OperationError | null> {
    const request = {
      name: sessionId.vm.name,
      template: DEFAULT_TEMPLATE,
      labels: instance.labels,
      machineType: instance.machineType || null,
      metadata: instance.metadata.items,
      bootDisk: { snapshot, type: disk.type, sizeGb: disk.sizeGb },
    };
    let error: OperationError | null;
    try {
      const operation = await this.deps.compute.insert(zone, request);
      reporter.log(`creating ${sessionId.vm.name} from ${DEFAULT_TEMPLATE} in ${zone} with a disk from ${snapshot}`);
      error = await this.waitForOperation(operation, CREATE_TIMEOUT_MS, `create ${sessionId.vm.name} in ${zone}`);
    } catch (thrown) {
      if (!isStockout(messageOf(thrown))) throw thrown;
      return { code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: messageOf(thrown), machineType: null };
    }
    if (!error) return null;
    if (!isStockout(error.code)) throw new ApiError("unavailable", `failed to create ${sessionId.vm.name} in ${zone}: ${error.message || error.code}`);
    return error;
  }

  /** Gives the VM in `zone` its name back after a move that created no VM, and drops the snapshot; failures are logged. */
  private async rollBackMove(zone: string, sessionId: SessionId, reporter: Reporter): Promise<void> {
    reporter.log(`${sessionId.vm.name} stays in ${zone}`);
    const renameBack = this.rename(zone, sessionId.vm.movingName, sessionId.vm.name);
    await this.discard(renameBack, reporter, `rename ${sessionId.vm.movingName} back to ${sessionId.vm.name}`);
    await this.discardSnapshot(sessionId.vm.snapshotName, reporter);
  }

  /** Renames the VM `from` in `zone` to `to` and waits until it is done. */
  private async rename(zone: string, from: string, to: string): Promise<void> {
    const operation = await this.deps.compute.setName(zone, from, to);
    const error = await this.waitForOperation(operation, DISK_TIMEOUT_MS, `rename ${from} to ${to}`);
    if (error) throw new ApiError("unavailable", `failed to rename ${from} to ${to}: ${error.message || error.code}`);
  }

  /**
   * Finishes a move of the session's VM that an earlier call left behind, before the VM is used again, and returns the
   * VM under its name (null when the session has none): a VM still under its moving name without a successor gets its
   * name back and the move's snapshot is deleted; one whose successor exists is deleted with the snapshot.
   */
  private async recover(sessionId: SessionId, reporter: Reporter): Promise<Instance | null> {
    const { vm, moving } = await this.locateSession(sessionId);
    if (!moving) return vm;
    checkSession(moving, sessionId);
    if (vm) {
      reporter.log(`finishing an interrupted move of ${sessionId.vm.name}: deleting the VM it replaced in ${moving.zone}`);
      await this.discard(this.deleteInstance(moving), reporter, `delete ${moving.name}`);
      await this.discardSnapshot(sessionId.vm.snapshotName, reporter);
      return vm;
    }
    reporter.log(`finishing an interrupted move of ${sessionId.vm.name}: it stays in ${moving.zone}`);
    await this.rename(moving.zone, moving.name, sessionId.vm.name);
    await this.discardSnapshot(sessionId.vm.snapshotName, reporter);
    return this.deps.compute.get(moving.zone, sessionId.vm.name);
  }

  /** The session's VM under its name and under its moving name; null for each that does not exist. */
  private async locateSession(sessionId: SessionId): Promise<{ vm: Instance | null; moving: Instance | null }> {
    const [vm, moving] = await Promise.all([this.deps.compute.locate(sessionId.vm.name), this.deps.compute.locate(sessionId.vm.movingName)]);
    return { vm, moving };
  }

  /** Deletes `instance` with all its disks; returns once Compute Engine accepted the deletion. */
  private async deleteInstance(instance: Instance): Promise<void> {
    const { zone, name } = instance;
    const kept = instance.disks.filter((disk) => !disk.autoDelete);
    for (const disk of kept) {
      await this.deps.compute.setDiskAutoDelete(zone, name, disk.deviceName);
    }
    if (kept.length > 0) {
      await this.waitFor(zone, name, (found) => !found || found.disks.every((disk) => disk.autoDelete), DISK_TIMEOUT_MS, () => "mark its disks for deletion");
    }
    await this.deps.compute.delete(zone, name);
  }

  /**
   * Deletes the snapshot unless it is gone already; a failure is logged, not thrown, unless `isAwaited`, which waits
   * until the snapshot is deleted so that a new one can take its name.
   */
  private async discardSnapshot(snapshot: string, reporter: Reporter, isAwaited = false): Promise<void> {
    let operation: ComputeOperation;
    try {
      operation = await this.deps.compute.deleteSnapshot(snapshot);
    } catch (error) {
      if (isGone(error)) return;
      if (isAwaited) throw error;
      reporter.log(`failed to delete the snapshot ${snapshot}: ${messageOf(error)}`);
      return;
    }
    if (!isAwaited) return;
    const error = await this.waitForOperation(operation, DISK_TIMEOUT_MS, `delete the snapshot ${snapshot} of an earlier move`);
    if (error) throw new ApiError("unavailable", `failed to delete the snapshot ${snapshot} of an earlier move: ${error.message || error.code}`);
  }

  /** Awaits a cleanup `call` whose failure must not fail the operation: a resource that is gone already is no failure, any other is logged. */
  private async discard(call: Promise<unknown>, reporter: Reporter, what: string): Promise<void> {
    try {
      await call;
    } catch (error) {
      if (isGone(error)) return;
      reporter.log(`failed to ${what}: ${messageOf(error)}`);
    }
  }

  private async waitFor(
    zone: string,
    name: string,
    isDone: (instance: Instance | null) => boolean,
    timeoutMs: number,
    failure: (instance: Instance | null) => string,
  ): Promise<void> {
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const instance = await this.deps.compute.get(zone, name);
      if (isDone(instance)) return;
      if (this.deps.now() >= deadline) throw new ApiError("unavailable", `failed to ${failure(instance)} after ${minutes(timeoutMs)}`);
      await this.deps.sleep(INSTANCE_POLL_MS);
    }
  }

  /**
   * Waits until `operation` is done and returns its error; null when it succeeded. `what` names it in a timeout. Each
   * wait blocks on Compute Engine's side for up to about two minutes; the pause after one that passed its deadline
   * guards against an API that answers at once.
   */
  private async waitForOperation(operation: ComputeOperation, timeoutMs: number, what: string): Promise<OperationError | null> {
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const state = await this.deps.compute.waitOperation(operation);
      if (state.isDone) return state.error;
      if (this.deps.now() >= deadline) throw new ApiError("unavailable", `failed to ${what}: Compute Engine has not finished after ${minutes(timeoutMs)}`);
      await this.deps.sleep(INSTANCE_POLL_MS);
    }
  }

  private ref(name: string, zone: string): VmRef {
    return { project: this.deps.location.project, zone, instance: name };
  }

  /** Runs `run` as the operation `key` of the session, or joins it; see the module comment. */
  private async exclusive<T>(sessionId: SessionId, key: string, reporter: Reporter, run: (shared: Reporter) => Promise<T>): Promise<T> {
    const id = sessionId.id;
    for (let current = this.operations.get(id); current; current = this.operations.get(id)) {
      if (current.key === key) return this.join(current, reporter) as Promise<T>;
      await current.promise.catch(() => {});
    }
    const operation: Operation = { key, promise: Promise.resolve(), events: [], reporters: new Set([reporter]) };
    this.operations.set(id, operation);
    const shared: Reporter = {
      progress: (step) => this.publish(operation, { type: "progress", step }),
      log: (message) => this.publish(operation, { type: "log", message }),
    };
    const promise = run(shared).finally(() => {
      if (this.operations.get(id) === operation) {
        this.operations.delete(id);
      }
    });
    operation.promise = promise;
    return promise;
  }

  private join(operation: Operation, reporter: Reporter): Promise<unknown> {
    for (const event of operation.events) {
      deliver(reporter, event);
    }
    operation.reporters.add(reporter);
    return operation.promise.finally(() => operation.reporters.delete(reporter));
  }

  private publish(operation: Operation, event: Event): void {
    operation.events.push(event);
    for (const reporter of operation.reporters) {
      deliver(reporter, event);
    }
  }
}

/** Passes `event` to `reporter`; a reporter that throws, such as one whose client left, does not stop the operation. */
function deliver(reporter: Reporter, event: Event): void {
  try {
    if (event.type === "progress") {
      reporter.progress(event.step);
    } else {
      reporter.log(event.message);
    }
  } catch {
    // The reporter's client is gone; the operation runs on for the others.
  }
}

/**
 * The service over the session VMs of the gateway's project (from the metadata server) as hunt-api and hunt-swf run it:
 * Compute Engine through `compute`, the VMs over SSH and the remote secrets of Secret Manager, through `remoteSecrets`
 * when the caller holds the store already; `log` hears every command run on a VM.
 */
export async function createSessionVmService(
  metadata: Metadata,
  compute: Compute,
  log: Log,
  remoteSecrets: Pick<RemoteSecretStore, "all"> = remoteSecretStore(metadata, log),
): Promise<SessionVmService> {
  const location = { project: await metadata.project(), zone: await metadata.zone() };
  return new SessionVmService({
    compute,
    location,
    zones: () => readSessionZones(location.zone),
    vm: (name, zone) => createSessionVmSsh(name, { project: location.project, zone }, log),
    remoteSecrets: () => remoteSecrets.all(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
}
