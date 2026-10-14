/**
 * The control plane of the session VMs, shared by the gateway API (`api.ts`) and the poller (`swf.ts`). A session's VM
 * is `vm-hunt-s-<short id>` (`<short id>`: the first 8 hex digits of the session ID), created from an instance template
 * with the labels `hunt-role=session`, `hunt-session=<short id>`, `hunt-origin=desktop|swf` and, for a person's session,
 * `hunt-owner=<OS Login user>`; its metadata records the session (`hunt-session-id`, `hunt-repo`, `hunt-branch`,
 * `hunt-title`, `hunt-issue`). These labels and metadata are the directory of remote sessions.
 *
 * Bringing a VM up starts a stopped one, resumes a suspended one and waits out a shutdown in progress, then waits until
 * it answers over SSH and its startup script finished, and hands it the staged session release. Calls that bring up the
 * VM of one session share one operation: a second identical call joins the first and hears its progress from the
 * start, a different one waits until the first ended.
 */
import type { ProgressStep, ReleaseInfo, SessionSummary, VmRef } from "../../../libs/domain/src/gatewayApi.ts";
import { messageOf } from "../../../libs/domain/src/errors.ts";
import { ApiError, SESSION_ID } from "./apiProtocol.ts";
import { mergeMetadataItems, metadataValue, type Compute, type Instance } from "./gcp.ts";
import type { SessionVm, VmLocation } from "./sessionVm.ts";
import { sessionNames } from "./swfPlan.ts";

export const ROLE_LABEL = "hunt-role";
export const SESSION_LABEL = "hunt-session";
export const ORIGIN_LABEL = "hunt-origin";
export const OWNER_LABEL = "hunt-owner";
export const SESSION_ROLE = "session";
export const SESSION_VM_PREFIX = "vm-hunt-s-";
/** The instance template session VMs are created from. */
export const DEFAULT_TEMPLATE = "tpl-hunt-session";

export const CREATE_TIMEOUT_MS = 2 * 60_000;
export const START_TIMEOUT_MS = 6 * 60_000;
export const READY_TIMEOUT_MS = 15 * 60_000;
export const DISK_TIMEOUT_MS = 2 * 60_000;
export const INSTANCE_POLL_MS = 3_000;
const METADATA_ATTEMPTS = 3;
const OFF_STATUSES = new Set(["TERMINATED", "STOPPED", "SUSPENDED"]);
const SHUTDOWN_STATUSES = new Set(["STOPPING", "SUSPENDING"]);

export type Origin = "desktop" | "swf";

/** Hears what a running operation does: the progress steps of the API contract and log lines. */
export interface Reporter {
  progress(step: ProgressStep): void;
  log(message: string): void;
}

export const SILENT: Reporter = { progress: () => {}, log: () => {} };

export interface ProvisionRequest {
  id: string;
  title: string;
  repo: string;
  branch: string;
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

export interface OrchestratorDeps {
  compute: Compute;
  /** The gateway's project and zone, where the session VMs live. */
  location: VmLocation;
  vm(name: string): SessionVm;
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

/** `text` as a label value: lowercase letters, digits, `_` and `-`, at most 63 characters. */
export function labelValue(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
}

/** The session a VM's labels and metadata describe; null for a VM that names no session or another VM's session. */
export function sessionSummary(instance: Instance, fallbackZone: string): SessionSummary | null {
  const id = metadataValue(instance, "hunt-session-id") ?? "";
  if (!SESSION_ID.test(id) || sessionNames(id).vm !== instance.name) return null;
  const issue = metadataValue(instance, "hunt-issue") ?? "";
  return {
    id,
    vm: instance.name,
    zone: instance.zone || fallbackZone,
    status: instance.status,
    origin: instance.labels[ORIGIN_LABEL] ?? "",
    owner: instance.labels[OWNER_LABEL] ?? "",
    repo: metadataValue(instance, "hunt-repo") ?? "",
    branch: metadataValue(instance, "hunt-branch") ?? "",
    title: metadataValue(instance, "hunt-title") ?? "",
    issue: /^[1-9][0-9]{0,9}$/.test(issue) ? Number(issue) : null,
    createdAt: instance.creationTimestamp,
  };
}

/** Refuses a VM that is no session VM or that holds another session than `id`. */
function checkSession(instance: Instance, id: string): void {
  if (instance.labels[ROLE_LABEL] !== SESSION_ROLE) {
    throw new ApiError("forbidden", `${instance.name} is no session VM: it lacks the label ${ROLE_LABEL}=${SESSION_ROLE}`);
  }
  const holder = metadataValue(instance, "hunt-session-id");
  if (holder && holder !== id) throw new ApiError("conflict", `${instance.name} holds the session ${holder}, not ${id}`);
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  /** The operation that brings a session's VM up, by session ID. */
  private readonly operations = new Map<string, Operation>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Creates the session's VM unless it exists, records the session in its metadata, brings it up and hands it the
   * staged session release. `creatingVm` means Compute Engine accepted the new VM. A conflict when the VM holds
   * another session.
   */
  provision(request: ProvisionRequest, reporter: Reporter): Promise<ProvisionResult> {
    return this.exclusive(request.id, `provision ${JSON.stringify(request)}`, reporter, (shared) => this.runProvision(request, shared));
  }

  /** Brings the session's VM up; see the module comment. */
  start(id: string, reporter: Reporter): Promise<StartResult> {
    return this.exclusive(id, "start", reporter, async (shared) => {
      const name = sessionNames(id).vm;
      const instance = await this.deps.compute.get(name);
      if (!instance) throw new ApiError("notFound", `the session ${id} has no VM ${name}`);
      checkSession(instance, id);
      const { wasRunning, release, zone } = await this.bringUp(name, shared);
      return { vm: this.ref(name, zone), wasRunning, release };
    });
  }

  /** Stops the session's VM unless it is off or shuts down already. */
  async stop(id: string): Promise<void> {
    const name = sessionNames(id).vm;
    const instance = await this.deps.compute.get(name);
    if (!instance) throw new ApiError("notFound", `the session ${id} has no VM ${name}`);
    checkSession(instance, id);
    if (instance.status === "TERMINATED" || instance.status === "STOPPED" || instance.status === "STOPPING") return;
    await this.deps.compute.stop(name);
  }

  /** Deletes the session's VM with all its disks; returns once Compute Engine accepted the deletion. */
  async delete(id: string): Promise<{ alreadyGone: boolean }> {
    const name = sessionNames(id).vm;
    if (!name.startsWith(SESSION_VM_PREFIX)) throw new ApiError("forbidden", `${name} is no session VM`);
    const instance = await this.deps.compute.get(name);
    if (!instance) return { alreadyGone: true };
    checkSession(instance, id);
    const kept = instance.disks.filter((disk) => !disk.autoDelete);
    for (const disk of kept) {
      await this.deps.compute.setDiskAutoDelete(name, disk.deviceName);
    }
    if (kept.length > 0) {
      await this.waitFor(name, (found) => !found || found.disks.every((disk) => disk.autoDelete), DISK_TIMEOUT_MS, () => "mark its disks for deletion");
    }
    try {
      await this.deps.compute.delete(name);
    } catch (error) {
      if (messageOf(error).includes("HTTP 404")) return { alreadyGone: true };
      throw error;
    }
    return { alreadyGone: false };
  }

  async get(id: string): Promise<{ exists: boolean; name: string; status: string | null }> {
    const name = sessionNames(id).vm;
    const instance = await this.deps.compute.get(name);
    return { exists: instance !== null, name, status: instance?.status ?? null };
  }

  /** The session VMs of every zone of the gateway's project, oldest first. */
  async listSessions(): Promise<SessionSummary[]> {
    const instances = await this.deps.compute.list(`labels.${ROLE_LABEL} = "${SESSION_ROLE}"`);
    const sessions = instances
      .filter((instance) => instance.labels[ROLE_LABEL] === SESSION_ROLE)
      .map((instance) => sessionSummary(instance, this.deps.location.zone))
      .filter((session) => session !== null);
    return sessions.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  }

  private async runProvision(request: ProvisionRequest, reporter: Reporter): Promise<ProvisionResult> {
    const names = sessionNames(request.id);
    const existing = await this.deps.compute.get(names.vm);
    if (existing) {
      checkSession(existing, request.id);
      reporter.log(`${names.vm} exists already`);
    } else {
      const labels: Record<string, string> = { [ROLE_LABEL]: SESSION_ROLE, [SESSION_LABEL]: names.short, [ORIGIN_LABEL]: request.origin };
      if (request.owner) {
        labels[OWNER_LABEL] = labelValue(request.owner);
      }
      await this.deps.compute.insert({ name: names.vm, template: request.template, machineType: request.machineType, labels });
      reporter.progress("creatingVm");
      reporter.log(`creating ${names.vm} from ${request.template}`);
      await this.waitFor(names.vm, (found) => found !== null, CREATE_TIMEOUT_MS, (found) => `create ${names.vm}: it is still ${found?.status ?? "missing"}`);
    }
    const entries: Record<string, string> = {
      "hunt-session-id": request.id,
      "hunt-repo": request.repo,
      "hunt-branch": request.branch,
      "hunt-title": request.title,
    };
    if (request.issue !== null) {
      entries["hunt-issue"] = String(request.issue);
    }
    await this.recordSession(names.vm, request.id, entries);
    const { release, zone } = await this.bringUp(names.vm, reporter);
    return { vm: this.ref(names.vm, zone), created: !existing, release };
  }

  /** Adds `entries` to the VM's metadata, keeping the template's keys; retries when the metadata changed meanwhile. */
  private async recordSession(name: string, id: string, entries: Record<string, string>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const instance = await this.deps.compute.get(name);
      if (!instance) throw new ApiError("notFound", `failed to record the session in ${name}: it does not exist`);
      checkSession(instance, id);
      if (Object.entries(entries).every(([key, value]) => metadataValue(instance, key) === value)) return;
      try {
        await this.deps.compute.setMetadata(name, instance.metadata.fingerprint, mergeMetadataItems(instance.metadata.items, entries));
        return;
      } catch (error) {
        if (attempt >= METADATA_ATTEMPTS || !messageOf(error).includes("HTTP 412")) throw error;
      }
    }
  }

  /** Starts or resumes the VM unless it runs, waits until it is ready and hands it the staged session release. */
  private async bringUp(name: string, reporter: Reporter): Promise<{ wasRunning: boolean; release: ReleaseInfo; zone: string }> {
    const deadline = this.deps.now() + START_TIMEOUT_MS;
    let wasRunning: boolean | null = null;
    let isStarting = false;
    let isReported = false;
    let zone = "";
    for (;;) {
      const instance = await this.deps.compute.get(name);
      if (!instance) throw new ApiError("notFound", `${name} does not exist`);
      zone = instance.zone;
      wasRunning ??= instance.status === "RUNNING";
      if (instance.status === "RUNNING") break;
      if (OFF_STATUSES.has(instance.status) && !isStarting) {
        const verb = instance.status === "SUSPENDED" ? "resume" : "start";
        if (!isReported) {
          reporter.progress("startingVm");
          isReported = true;
        }
        await this.deps.compute[verb](name);
        reporter.log(`${verb === "start" ? "starting" : "resuming"} ${name}`);
        isStarting = true;
      } else if (SHUTDOWN_STATUSES.has(instance.status)) {
        if (!isReported) {
          reporter.progress("startingVm");
          reporter.log(`waiting for ${name} to finish shutting down`);
          isReported = true;
        }
        isStarting = false;
      }
      if (this.deps.now() >= deadline) {
        throw new ApiError("unavailable", `failed to start ${name}: it is still ${instance.status} after ${minutes(START_TIMEOUT_MS)}`);
      }
      await this.deps.sleep(INSTANCE_POLL_MS);
    }

    const vm = this.deps.vm(name);
    await vm.waitUntilReady(READY_TIMEOUT_MS, () => reporter.progress("waitingForVm"));
    reporter.log(`${name} is ready; checking its release`);
    const release = await vm.ensureRelease(() => {
      reporter.progress("installingRuntime");
      reporter.log(`installing the staged session release on ${name}`);
    });
    return { wasRunning, release, zone };
  }

  private async waitFor(
    name: string,
    isDone: (instance: Instance | null) => boolean,
    timeoutMs: number,
    failure: (instance: Instance | null) => string,
  ): Promise<void> {
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const instance = await this.deps.compute.get(name);
      if (isDone(instance)) return;
      if (this.deps.now() >= deadline) throw new ApiError("unavailable", `failed to ${failure(instance)} after ${minutes(timeoutMs)}`);
      await this.deps.sleep(INSTANCE_POLL_MS);
    }
  }

  private ref(name: string, zone: string): VmRef {
    return { project: this.deps.location.project, zone: zone || this.deps.location.zone, instance: name };
  }

  /** Runs `run` as the operation `key` of session `id`, or joins it; see the module comment. */
  private async exclusive<T>(id: string, key: string, reporter: Reporter, run: (shared: Reporter) => Promise<T>): Promise<T> {
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
