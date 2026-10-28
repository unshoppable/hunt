import { describe, expect, it } from "vitest";
import type { ProgressStep } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import type { Transport } from "./relay.client.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import type { Compute, Disk, Instance, InstanceRequest, MetadataItem, OperationError, OperationState } from "../gcp/compute-engine.client.ts";
import {
  CREATE_TIMEOUT_MS,
  INSTANCE_POLL_MS,
  SessionVmService,
  SNAPSHOT_TIMEOUT_MS,
  START_TIMEOUT_MS,
  SUSPEND_TIMEOUT_MS,
  type ProvisionRequest,
  type Reporter,
} from "./session-vm.service.ts";
import type { SessionVmSsh } from "./session-vm-ssh.client.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const OTHER_ID = "ab12cd34-0000-4000-8000-000000000002";
const SESSION_ID = SessionId.of(ID);
const VM = "vm-hunt-s-ab12cd34";
const MOVING = `${VM}-moving`;
const SNAPSHOT = `${VM}-move`;
const BOOT_DISK: Disk = { type: "hyperdisk-balanced", sizeGb: 50 };
const ZONE = "europe-west3-a";
const ZONE_B = "europe-west3-b";
const ZONE_C = "europe-west3-c";
const LOCATION = { project: "medconomy-hunt", zone: ZONE };
const RELEASE = { version: "session@1.4.0", protocol: 1 };
/** The hash of the session release staged on the gateway, which an up-to-date VM reports as installed. */
const STAGED_HASH = "0123456789abcdef";
const SESSION_LABELS = { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop" };
const STOCKOUT: OperationError = {
  code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
  message: "The zone does not have enough resources available to fulfill the request.",
  machineType: "c4d-standard-8",
};

const REQUEST: ProvisionRequest = {
  sessionId: SESSION_ID,
  title: "Fix login",
  repo: Repository.fromSlug("acme/app"),
  branch: BranchName.of("feat/login"),
  issue: null,
  origin: "desktop",
  owner: "jane_doe_example_com",
  template: "tpl-hunt-session",
  machineType: null,
};

function instance(overrides: Partial<Instance> & { sessionId?: string }): Instance {
  const { sessionId, ...rest } = overrides;
  const items: MetadataItem[] = [{ key: "startup-script", value: "#!/bin/sh" }];
  if (sessionId) {
    items.push({ key: "hunt-session-id", value: sessionId });
  }
  return {
    name: VM,
    zone: ZONE,
    status: "RUNNING",
    creationTimestamp: "2026-10-13T08:00:00.000-07:00",
    lastStopTimestamp: "",
    lastSuspendedTimestamp: "",
    labels: SESSION_LABELS,
    metadata: { fingerprint: "fp0", items },
    disks: [{ deviceName: "persistent-disk-0", autoDelete: true, boot: true, source: rest.name ?? VM }],
    machineType: "c4d-standard-8",
    ...rest,
  };
}

/**
 * A Compute Engine with the VMs in `vms`, each in its own zone with its boot disk (`disks`, by `<zone>/<name>`); a call
 * that names another zone than the VM's finds nothing, as the API does. Each `get` of a VM first applies the next
 * status of its queue in `statuses`; insert, start and resume queue the statuses a VM goes through. `insertErrors`
 * makes the insert in a zone fail: an `OperationError` as the operation's error, an `Error` as the API's answer to the
 * call; `failStart` does the same for the start in a zone, `failResume`, `failSuspend` and `failStop` for those calls.
 * Every change is recorded in `calls`.
 */
function fakeCompute(vms: Instance[] = []) {
  const instances = new Map(vms.map((vm) => [vm.name, structuredClone(vm)]));
  const disks = new Map<string, Disk>(vms.flatMap((vm) => vm.disks.filter((disk) => disk.boot).map((disk) => [`${vm.zone}/${disk.source}`, { ...BOOT_DISK }])));
  const snapshots = new Set<string>();
  const statuses = new Map<string, string[]>();
  const operations = new Map<string, OperationState>();
  const calls: string[] = [];
  const inserted: InstanceRequest[] = [];
  const insertedZones: string[] = [];
  const insertErrors = new Map<string, OperationError | Error>();
  const startErrors = new Map<string, OperationError>();
  let resumeError: OperationError | null = null;
  let suspendError: OperationError | null = null;
  let stopError: Error | null = null;
  let snapshotError: OperationError | null = null;
  let renameError: OperationError | null = null;
  let stuckFrom: number | null = null;
  let metadataFailures = 0;

  function find(zone: string, name: string): Instance {
    const vm = instances.get(name);
    if (vm?.zone !== zone) throw new Error(`failed to reach ${name} in ${zone}: HTTP 404 not found`);
    return vm;
  }

  function operation(zone: string | null, error: OperationError | null) {
    const name = `operation-${operations.size + 1}`;
    operations.set(name, { isDone: true, error });
    return { name, zone };
  }

  function gone(what: string): Error {
    return new Error(`failed to delete ${what}: HTTP 404 not found`);
  }

  const compute: Compute = {
    list: async () => [...instances.values()].map((vm) => structuredClone(vm)),
    listByLabel: async (key, value) => [...instances.values()].filter((vm) => vm.labels[key] === value).map((vm) => structuredClone(vm)),
    locate: async (name) => {
      const vm = instances.get(name);
      return vm ? structuredClone(vm) : null;
    },
    get: async (zone, name) => {
      const vm = instances.get(name);
      if (vm?.zone !== zone) return null;
      const next = statuses.get(name)?.shift();
      if (next) {
        vm.status = next;
      }
      return structuredClone(vm);
    },
    insert: async (zone, request) => {
      calls.push(`insert ${request.name} in ${zone}`);
      inserted.push(request);
      insertedZones.push(zone);
      if (request.bootDisk && !snapshots.has(request.bootDisk.snapshot)) throw new Error(`failed to create ${request.name} in ${zone}: HTTP 404 no snapshot ${request.bootDisk.snapshot}`);
      const error = insertErrors.get(zone);
      if (error instanceof Error) throw error;
      if (error) return operation(zone, error);
      const created = instance({ name: request.name, zone, status: "PROVISIONING", labels: request.labels, machineType: request.machineType ?? "c4d-standard-8" });
      if (request.metadata) {
        created.metadata.items = request.metadata;
      }
      disks.set(`${zone}/${request.name}`, request.bootDisk ? { type: request.bootDisk.type, sizeGb: request.bootDisk.sizeGb } : { ...BOOT_DISK });
      instances.set(request.name, created);
      statuses.set(request.name, ["PROVISIONING", "STAGING", "STAGING", "RUNNING"]);
      return operation(zone, null);
    },
    waitOperation: async ({ name }) => {
      const index = Number(name.replace("operation-", ""));
      return stuckFrom !== null && index > stuckFrom ? { isDone: false, error: null } : operations.get(name)!;
    },
    setName: async (zone, name, newName) => {
      calls.push(`setName ${name} ${newName}`);
      const vm = find(zone, name);
      if (renameError) return operation(zone, renameError);
      if (vm.status !== "TERMINATED") throw new Error(`failed to rename ${name}: HTTP 400 the VM is ${vm.status}`);
      if (instances.has(newName)) throw new Error(`failed to rename ${name}: HTTP 409 ${newName} exists`);
      instances.delete(name);
      instances.set(newName, { ...vm, name: newName });
      return operation(zone, null);
    },
    getDisk: async (zone, name) => {
      calls.push(`getDisk ${name} in ${zone}`);
      const disk = disks.get(`${zone}/${name}`);
      if (!disk) throw new Error(`failed to look up the disk ${name} in ${zone}: HTTP 404 not found`);
      return { ...disk };
    },
    createSnapshot: async (zone, disk, snapshot) => {
      calls.push(`createSnapshot ${disk} in ${zone} as ${snapshot}`);
      if (!disks.has(`${zone}/${disk}`)) throw new Error(`failed to snapshot the disk ${disk} in ${zone}: HTTP 404 not found`);
      if (snapshotError) return operation(zone, snapshotError);
      snapshots.add(snapshot);
      return operation(zone, null);
    },
    deleteSnapshot: async (snapshot) => {
      calls.push(`deleteSnapshot ${snapshot}`);
      if (!snapshots.delete(snapshot)) throw gone(`the snapshot ${snapshot}`);
      return operation(null, null);
    },
    setMetadata: async (zone, name, fingerprint, items) => {
      calls.push(`setMetadata ${name} ${fingerprint}`);
      const vm = find(zone, name);
      if (metadataFailures > 0) {
        metadataFailures--;
        throw new Error(`failed to set the metadata of ${name}: HTTP 412 Supplied fingerprint does not match`);
      }
      vm.metadata = { fingerprint: `${fingerprint}+`, items };
    },
    start: async (zone, name) => {
      calls.push(`start ${name}`);
      find(zone, name);
      const error = startErrors.get(zone);
      if (error) return operation(zone, error);
      statuses.set(name, ["TERMINATED", "STAGING", "RUNNING"]);
      return operation(zone, null);
    },
    resume: async (zone, name) => {
      calls.push(`resume ${name}`);
      find(zone, name);
      if (resumeError) return operation(zone, resumeError);
      statuses.set(name, ["RESUMING", "RUNNING"]);
      return operation(zone, null);
    },
    suspend: async (zone, name) => {
      calls.push(`suspend ${name}`);
      find(zone, name);
      if (suspendError) return operation(zone, suspendError);
      statuses.set(name, ["SUSPENDING", "SUSPENDED"]);
      return operation(zone, null);
    },
    stop: async (zone, name) => {
      calls.push(`stop ${name}`);
      find(zone, name);
      if (stopError) throw stopError;
      statuses.set(name, ["STOPPING", "TERMINATED"]);
    },
    setDiskAutoDelete: async (zone, name, deviceName) => {
      calls.push(`setDiskAutoDelete ${name} ${deviceName}`);
      const disk = find(zone, name).disks.find((candidate) => candidate.deviceName === deviceName)!;
      disk.autoDelete = true;
    },
    delete: async (zone, name) => {
      calls.push(`delete ${name}`);
      const vm = find(zone, name);
      for (const disk of vm.disks) {
        if (disk.autoDelete) {
          disks.delete(`${zone}/${disk.source}`);
        }
      }
      instances.delete(name);
    },
  };
  return {
    compute,
    calls,
    inserted,
    insertedZones,
    insertErrors,
    statuses,
    instances,
    disks,
    snapshots,
    failMetadata: (count: number) => {
      metadataFailures = count;
    },
    failStart: (error: OperationError, zone = ZONE) => {
      startErrors.set(zone, error);
    },
    failResume: (error: OperationError) => {
      resumeError = error;
    },
    failSuspend: (error: OperationError) => {
      suspendError = error;
    },
    failStop: (error: Error) => {
      stopError = error;
    },
    failRename: (error: OperationError) => {
      renameError = error;
    },
    failSnapshot: (error: OperationError) => {
      snapshotError = error;
    },
    /** Leaves every operation after the first `after` ones unfinished. */
    stickOperations: (after = 0) => {
      stuckFrom = after;
    },
  };
}

/** The ready check of a VM, which hands it the remote secrets of `createService`. */
const WAIT_READY = `wait until ready <<< {"MED_OPENAI_API_KEY":"sk-1"}`;
/** The call that puts the remote secrets on a VM whose release was too old to take them with the ready check. */
const PUT_SECRETS = `hunt-ctl put-remote-secrets <<< {"MED_OPENAI_API_KEY":"sk-1"}`;
/** The release check of a VM that runs the staged release, and of one without any. */
const KEEP_RELEASE = `ensure release over ${STAGED_HASH}`;
const INSTALL_RELEASE = "ensure release over none";

/**
 * A session VM whose startup script finished unless `isBooting`, that fails a readiness check with `failure` while it
 * boots and reports no installed release when `isOutdated`, so that it needs the staged one and, its release being too
 * old for the command, takes the remote secrets only after the install.
 */
function fakeVm(options: { isBooting?: boolean; failure?: string; isOutdated?: boolean } = {}) {
  const calls: string[] = [];
  const vm: SessionVmSsh = {
    run: async () => "",
    huntCtl: async (args, input) => {
      calls.push(`hunt-ctl ${args.join(" ")} <<< ${String(input)}`);
      return {};
    },
    waitUntilReady: async (_timeoutMs, secrets, onWaiting, onFailure) => {
      calls.push(`wait until ready <<< ${JSON.stringify(secrets)}`);
      if (options.isBooting) {
        onWaiting?.();
        if (options.failure) {
          onFailure?.(options.failure);
        }
      }
      return options.isOutdated ? { installedHash: "", hasSecrets: false } : { installedHash: STAGED_HASH, hasSecrets: true };
    },
    ensureRelease: async (installedHash, onInstall) => {
      calls.push(`ensure release over ${installedHash || "none"}`);
      if (installedHash !== STAGED_HASH) {
        onInstall?.();
      }
      return RELEASE;
    },
    putClaudeFiles: async () => {},
    idleDecision: async () => "keep: a turn is running",
    openRelay: () => ({}) as Transport,
  };
  return { vm, calls };
}

function recorder() {
  const steps: ProgressStep[] = [];
  const logs: string[] = [];
  const reporter: Reporter = { progress: (step) => steps.push(step), log: (message) => logs.push(message) };
  return { reporter, steps, logs };
}

/** A SessionVmService over `compute` whose session VMs are `vm`; `vmZones` records the zone of every VM it reaches. */
function createService(compute: Compute, vm: SessionVmSsh = fakeVm().vm, zones = [ZONE]) {
  let time = 0;
  const vmZones: string[] = [];
  const service = new SessionVmService({
    compute,
    location: LOCATION,
    zones: () => zones,
    vm: (_name, zone) => {
      vmZones.push(zone);
      return vm;
    },
    remoteSecrets: async () => ({ MED_OPENAI_API_KEY: "sk-1" }),
    sleep: async (ms) => {
      time += ms;
      await Promise.resolve();
    },
    now: () => time,
  });
  return { service, elapsed: () => time, vmZones };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("the promise resolved");
}

describe("SessionVmService.provision", () => {
  it("creates a missing VM with its labels, records the session and reports the steps in order", async () => {
    const fake = fakeCompute();
    const { vm, calls } = fakeVm({ isBooting: true, isOutdated: true });
    const { service } = createService(fake.compute, vm);
    const { reporter, steps, logs } = recorder();

    const result = await service.provision({ ...REQUEST, owner: "Jane.Doe@example.com", machineType: "e2-standard-8" }, reporter);

    expect(result).toEqual({ vm: { project: "medconomy-hunt", zone: ZONE, instance: VM }, created: true, release: RELEASE });
    expect(fake.inserted).toEqual([
      {
        name: VM,
        template: "tpl-hunt-session",
        machineType: "e2-standard-8",
        labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop", "hunt-owner": "jane_doe_example_com" },
      },
    ]);
    expect(fake.instances.get(VM)!.metadata.items).toEqual([
      { key: "startup-script", value: "#!/bin/sh" },
      { key: "hunt-session-id", value: ID },
      { key: "hunt-repo", value: "acme/app" },
      { key: "hunt-branch", value: "feat/login" },
      { key: "hunt-title", value: "Fix login" },
    ]);
    expect(steps).toEqual(["creatingVm", "waitingForVm", "vmReady", "installingRuntime"]);
    expect(calls).toEqual([WAIT_READY, INSTALL_RELEASE, PUT_SECRETS]);
    expect(logs[0]).toBe(`creating ${VM} from tpl-hunt-session in ${ZONE}`);
  });

  it("logs why a booting VM does not answer while it waits for it", async () => {
    const { vm } = fakeVm({ isBooting: true, failure: `failed to run a command on ${VM}: exit status 255` });
    const { service } = createService(fakeCompute().compute, vm);
    const { reporter, steps, logs } = recorder();

    await service.provision(REQUEST, reporter);

    expect(steps).toContain("waitingForVm");
    expect(logs).toContain(`${VM} does not answer yet: failed to run a command on ${VM}: exit status 255`);
  });

  it("records the issue of a poller session and labels it without an owner", async () => {
    const fake = fakeCompute();
    const { service } = createService(fake.compute);

    await service.provision({ ...REQUEST, origin: "swf", owner: "", issue: 12 }, recorder().reporter);
    expect(fake.inserted[0].labels).toEqual({ "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" });
    expect(fake.instances.get(VM)!.metadata.items.slice(-2)).toEqual([
      { key: "hunt-issue", value: "12" },
      { key: "hunt-agent", value: "plan" },
    ]);
  });

  it("reuses the session's existing VM, starts it when it is off and leaves metadata that is current alone", async () => {
    const fake = fakeCompute([
      instance({
        status: "TERMINATED",
        metadata: {
          fingerprint: "fp0",
          items: [
            { key: "hunt-session-id", value: ID },
            { key: "hunt-repo", value: "acme/app" },
            { key: "hunt-branch", value: "feat/login" },
            { key: "hunt-title", value: "Fix login" },
          ],
        },
      }),
    ]);
    const { service } = createService(fake.compute);
    const { reporter, steps } = recorder();

    const result = await service.provision(REQUEST, reporter);
    expect(result.created).toBe(false);
    expect(fake.calls).toEqual([`start ${VM}`]);
    expect(steps).toEqual(["startingVm", "vmReady"]);
  });

  it("records the session on a VM a failed attempt left without it, retrying when the metadata changed meanwhile", async () => {
    const fake = fakeCompute([instance({})]);
    fake.failMetadata(1);
    const { service } = createService(fake.compute);

    await service.provision(REQUEST, recorder().reporter);
    expect(fake.calls).toEqual([`setMetadata ${VM} fp0`, `setMetadata ${VM} fp0`]);
    expect(fake.instances.get(VM)!.metadata.items.find((item) => item.key === "hunt-session-id")?.value).toBe(ID);
  });

  it("refuses a VM that holds another session or is no session VM", async () => {
    const taken = fakeCompute([instance({ sessionId: OTHER_ID })]);
    const error = await rejection(createService(taken.compute).service.provision(REQUEST, recorder().reporter));
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(`${VM} holds the session ${OTHER_ID}, not ${ID}`);
    expect(taken.calls).toEqual([]);

    const foreign = fakeCompute([instance({ labels: { "hunt-role": "gateway" } })]);
    expect((await rejection(createService(foreign.compute).service.provision(REQUEST, recorder().reporter))).code).toBe("forbidden");
  });

  it("gives up on a creation Compute Engine does not finish within the creation timeout", async () => {
    const fake = fakeCompute();
    fake.stickOperations();
    const { service, elapsed } = createService(fake.compute);

    const error = await rejection(service.provision(REQUEST, recorder().reporter));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to create ${VM} in ${ZONE}: Compute Engine has not finished after 2 minutes` });
    expect(elapsed()).toBeGreaterThanOrEqual(CREATE_TIMEOUT_MS);
  });

  it("creates the VM in the next zone when a zone has no capacity for it and reaches it there", async () => {
    const fake = fakeCompute();
    fake.insertErrors.set(ZONE, STOCKOUT);
    const { service, vmZones } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, steps, logs } = recorder();

    const result = await service.provision(REQUEST, reporter);
    expect(result).toMatchObject({ vm: { project: "medconomy-hunt", zone: ZONE_B, instance: VM }, created: true });
    expect(fake.insertedZones).toEqual([ZONE, ZONE_B]);
    expect(vmZones).toEqual([ZONE_B]);
    expect(steps).toEqual(["creatingVm", "vmReady"]);
    expect(logs.slice(0, 3)).toEqual([
      `creating ${VM} from tpl-hunt-session in ${ZONE}`,
      `c4d-standard-8 is unavailable in ${ZONE}; trying ${ZONE_B}`,
      `creating ${VM} from tpl-hunt-session in ${ZONE_B}`,
    ]);
    expect(fake.instances.get(VM)!.metadata.items.find((item) => item.key === "hunt-session-id")?.value).toBe(ID);
  });

  it("moves on as well when Compute Engine refuses the creation itself for lack of capacity", async () => {
    const fake = fakeCompute();
    fake.insertErrors.set(ZONE, new Error(`failed to create ${VM} from tpl-hunt-session in ${ZONE}: HTTP 503 {"error":{"errors":[{"reason":"ZONE_RESOURCE_POOL_EXHAUSTED"}]}}`));
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    expect((await service.provision(REQUEST, recorder().reporter)).vm.zone).toBe(ZONE_B);
  });

  it("names the machine type and every zone when none has capacity for the VM", async () => {
    const fake = fakeCompute();
    for (const zone of [ZONE, ZONE_B, ZONE_C]) {
      fake.insertErrors.set(zone, STOCKOUT);
    }
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);

    const error = await rejection(service.provision(REQUEST, recorder().reporter));
    expect(error).toMatchObject({
      code: "unavailable",
      message: `failed to create ${VM}: c4d-standard-8 is unavailable in ${ZONE}, ${ZONE_B} and ${ZONE_C}; try again later or pick another machine type`,
    });
  });

  it("stops at a failure other than a lack of capacity", async () => {
    const fake = fakeCompute();
    fake.insertErrors.set(ZONE, { code: "QUOTA_EXCEEDED", message: "Quota 'C4D_CPUS' exceeded. Limit: 24.0 in region europe-west3.", machineType: null });
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(service.provision(REQUEST, recorder().reporter));
    expect(error.message).toBe(`failed to create ${VM} in ${ZONE}: Quota 'C4D_CPUS' exceeded. Limit: 24.0 in region europe-west3.`);
    expect(fake.insertedZones).toEqual([ZONE]);
  });

  it("reuses the session's VM in another zone than the first and works with it there", async () => {
    const fake = fakeCompute([instance({ zone: ZONE_C, status: "TERMINATED", sessionId: ID })]);
    const { service, vmZones } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);
    const { reporter, logs } = recorder();

    const result = await service.provision(REQUEST, reporter);
    expect(result).toMatchObject({ vm: { zone: ZONE_C }, created: false });
    expect(logs[0]).toBe(`${VM} exists already in ${ZONE_C}`);
    expect(vmZones).toEqual([ZONE_C]);
    await service.stop(SESSION_ID);
    expect(await service.delete(SESSION_ID)).toEqual({ alreadyGone: false });
    expect(fake.calls).toEqual([`setMetadata ${VM} fp0`, `start ${VM}`, `stop ${VM}`, `delete ${VM}`]);
  });
});

describe("SessionVmService.start", () => {
  it("brings a running VM up without starting it", async () => {
    const fake = fakeCompute([instance({ sessionId: ID })]);
    const { vm, calls } = fakeVm();
    const { reporter, steps } = recorder();

    const result = await createService(fake.compute, vm).service.start(SESSION_ID, reporter);
    expect(result).toEqual({ vm: { project: "medconomy-hunt", zone: ZONE, instance: VM }, wasRunning: true, release: RELEASE });
    expect(fake.calls).toEqual([]);
    expect(steps).toEqual(["vmReady"]);
    expect(calls).toEqual([WAIT_READY, KEEP_RELEASE]);
  });

  it("resumes a suspended VM and reads its status right after the operation, without a pause", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "SUSPENDED" })]);
    const { reporter, steps, logs } = recorder();
    const { service, elapsed } = createService(fake.compute);

    const result = await service.start(SESSION_ID, reporter);
    expect(result.wasRunning).toBe(false);
    expect(elapsed()).toBe(INSTANCE_POLL_MS);
    expect(fake.calls).toEqual([`resume ${VM}`]);
    expect(steps).toEqual(["resumingVm", "vmReady"]);
    expect(logs[0]).toBe(`resuming ${VM}`);
  });

  it("waits out a shutdown in progress and then starts the VM once", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "STOPPING" })]);
    fake.statuses.set(VM, ["STOPPING", "STOPPING", "TERMINATED"]);
    const { reporter, steps, logs } = recorder();

    await createService(fake.compute).service.start(SESSION_ID, reporter);
    expect(fake.calls).toEqual([`start ${VM}`]);
    expect(steps).toEqual(["startingVm", "vmReady"]);
    expect(logs.slice(0, 2)).toEqual([`waiting for ${VM} to finish shutting down`, `starting ${VM}`]);
  });

  it("gives up on a VM that does not run within the start timeout", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "STAGING" })]);
    const { service, elapsed } = createService(fake.compute);

    const error = await rejection(service.start(SESSION_ID, recorder().reporter));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to start ${VM}: it is still STAGING after 6 minutes` });
    expect(elapsed()).toBeGreaterThanOrEqual(START_TIMEOUT_MS);
  });

  it("fails at once when Compute Engine refuses to start the VM, without waiting for the start timeout", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "TERMINATED" })]);
    fake.failStart({ ...STOCKOUT, message: `A c4d-standard-8 VM instance is currently unavailable in the ${ZONE} zone.` });
    const { service, elapsed } = createService(fake.compute);

    const error = await rejection(service.start(SESSION_ID, recorder().reporter));
    expect(error).toMatchObject({
      code: "unavailable",
      message: `failed to start ${VM}: A c4d-standard-8 VM instance is currently unavailable in the ${ZONE} zone; its disk stays in ${ZONE}, try again later`,
    });
    expect(elapsed()).toBeLessThan(START_TIMEOUT_MS);
  });

  it("reports a missing VM as notFound", async () => {
    expect((await rejection(createService(fakeCompute().compute).service.start(SESSION_ID, recorder().reporter))).code).toBe("notFound");
  });

  it("lets concurrent calls for one session share one operation and replays its progress to the later ones", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "TERMINATED" })]);
    const { vm, calls } = fakeVm({ isOutdated: true });
    let ready = () => {};
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const waitUntilReady = vm.waitUntilReady;
    vm.waitUntilReady = async (timeoutMs, secrets, onWaiting) => {
      await isReady;
      return waitUntilReady(timeoutMs, secrets, onWaiting);
    };
    const { service } = createService(fake.compute, vm);
    const first = recorder();
    const second = recorder();

    const running = service.start(SESSION_ID, first.reporter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = service.start(SESSION_ID, second.reporter);
    ready();
    const [a, b] = await Promise.all([running, joined]);

    expect(a).toEqual(b);
    expect(a.wasRunning).toBe(false);
    expect(fake.calls).toEqual([`start ${VM}`]);
    expect(calls).toEqual([WAIT_READY, INSTALL_RELEASE, PUT_SECRETS]);
    expect(first.steps).toEqual(["startingVm", "vmReady", "installingRuntime"]);
    expect(second.steps).toEqual(["startingVm", "vmReady", "installingRuntime"]);
  });

  it("runs a different operation for the same session after the first one ended", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "TERMINATED" })]);
    const { vm, calls } = fakeVm();
    const { service } = createService(fake.compute, vm);

    const order: string[] = [];
    const started = service.start(SESSION_ID, recorder().reporter).then(() => order.push("start"));
    const provisioned = service.provision(REQUEST, recorder().reporter).then(() => order.push("provision"));
    await Promise.all([started, provisioned]);

    expect(order).toEqual(["start", "provision"]);
    expect(fake.calls).toEqual([`start ${VM}`, `setMetadata ${VM} fp0`]);
    expect(calls).toEqual([WAIT_READY, KEEP_RELEASE, WAIT_READY, KEEP_RELEASE]);
  });
});

describe("SessionVmService.start moving the VM", () => {
  const SESSION_ITEMS: MetadataItem[] = [
    { key: "startup-script", value: "#!/bin/sh" },
    { key: "hunt-session-id", value: ID },
    { key: "hunt-repo", value: "acme/app" },
    { key: "hunt-title", value: "Fix login" },
  ];
  const stoppedVm = () =>
    instance({ status: "TERMINATED", labels: { ...SESSION_LABELS, "hunt-owner": "jane_doe_example_com" }, metadata: { fingerprint: "fp0", items: SESSION_ITEMS } });
  const unavailable = `A c4d-standard-8 VM instance is currently unavailable in the ${ZONE} zone.`;

  it("moves a stopped VM whose zone has no capacity to the next zone, with its disk, labels, machine type and metadata", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart({ ...STOCKOUT, message: unavailable });
    const { service, vmZones } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, steps, logs } = recorder();

    const result = await service.start(SESSION_ID, reporter);
    expect(result).toEqual({ vm: { project: "medconomy-hunt", zone: ZONE_B, instance: VM }, wasRunning: false, release: RELEASE });
    expect(fake.calls).toEqual([
      `start ${VM}`,
      `deleteSnapshot ${SNAPSHOT}`,
      `getDisk ${VM} in ${ZONE}`,
      `createSnapshot ${VM} in ${ZONE} as ${SNAPSHOT}`,
      `setName ${VM} ${MOVING}`,
      `insert ${VM} in ${ZONE_B}`,
      `delete ${MOVING}`,
      `deleteSnapshot ${SNAPSHOT}`,
    ]);
    expect(fake.inserted).toEqual([
      {
        name: VM,
        template: "tpl-hunt-session",
        labels: { ...SESSION_LABELS, "hunt-owner": "jane_doe_example_com" },
        machineType: "c4d-standard-8",
        metadata: SESSION_ITEMS,
        bootDisk: { snapshot: SNAPSHOT, type: "hyperdisk-balanced", sizeGb: 50 },
      },
    ]);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE_B, status: "RUNNING", metadata: { items: SESSION_ITEMS } });
    expect(fake.instances.has(MOVING)).toBe(false);
    expect([...fake.disks.keys()]).toEqual([`${ZONE_B}/${VM}`]);
    expect(fake.disks.get(`${ZONE_B}/${VM}`)).toEqual(BOOT_DISK);
    expect(fake.snapshots.size).toBe(0);
    expect(steps).toEqual(["startingVm", "movingVm", "vmReady"]);
    expect(vmZones).toEqual([ZONE_B]);
    expect(logs).toEqual([
      `starting ${VM}`,
      `c4d-standard-8 is unavailable in ${ZONE}; moving ${VM} to another zone`,
      `snapshotting the disk ${VM} of ${VM} in ${ZONE} as ${SNAPSHOT}`,
      `creating ${VM} from tpl-hunt-session in ${ZONE_B} with a disk from ${SNAPSHOT}`,
      `moved ${VM} from ${ZONE} to ${ZONE_B}; deleting the VM it replaced and the snapshot`,
      `${VM} is ready; checking its release`,
      `put the remote secrets on ${VM} (1)`,
    ]);
  });

  it("skips a zone without capacity for the new VM, where nothing stays behind, and lands in the next", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.insertErrors.set(ZONE_B, STOCKOUT);
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, logs } = recorder();

    expect((await service.start(SESSION_ID, reporter)).vm.zone).toBe(ZONE_C);
    expect(fake.calls.slice(5, 7)).toEqual([`insert ${VM} in ${ZONE_B}`, `insert ${VM} in ${ZONE_C}`]);
    expect(logs).toContain(`c4d-standard-8 is unavailable in ${ZONE_B}; trying ${ZONE_C}`);
    expect([...fake.disks.keys()]).toEqual([`${ZONE_C}/${VM}`]);
  });

  it("skips a zone as well when Compute Engine refuses the creation itself for lack of capacity", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.insertErrors.set(ZONE_B, new Error(`failed to create ${VM} from tpl-hunt-session in ${ZONE_B}: HTTP 503 {"error":{"errors":[{"reason":"ZONE_RESOURCE_POOL_EXHAUSTED"}]}}`));
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);

    expect((await service.start(SESSION_ID, reporter())).vm.zone).toBe(ZONE_C);
    expect(fake.insertedZones).toEqual([ZONE_B, ZONE_C]);
  });

  it("gives the VM its name back and names every zone when none has capacity", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.insertErrors.set(ZONE_B, STOCKOUT);
    fake.insertErrors.set(ZONE_C, STOCKOUT);
    const { service, elapsed } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, logs } = recorder();

    const error = await rejection(service.start(SESSION_ID, reporter));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to start ${VM}: c4d-standard-8 is unavailable in ${ZONE}, ${ZONE_B} and ${ZONE_C}; try again later` });
    expect(fake.calls.slice(-2)).toEqual([`setName ${MOVING} ${VM}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE, status: "TERMINATED" });
    expect(fake.instances.has(MOVING)).toBe(false);
    expect([...fake.disks.keys()]).toEqual([`${ZONE}/${VM}`]);
    expect(fake.snapshots.size).toBe(0);
    expect(logs).toContain(`${VM} stays in ${ZONE}`);
    expect(elapsed()).toBeLessThan(START_TIMEOUT_MS);
  });

  it("rolls the move back at a failure other than a lack of capacity", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.insertErrors.set(ZONE_B, { code: "QUOTA_EXCEEDED", message: "Quota 'C4D_CPUS' exceeded.", machineType: null });
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);

    const error = await rejection(service.start(SESSION_ID, reporter()));
    expect(error.message).toBe(`failed to create ${VM} in ${ZONE_B}: Quota 'C4D_CPUS' exceeded.`);
    expect(fake.insertedZones).toEqual([ZONE_B]);
    expect(fake.calls.slice(-2)).toEqual([`setName ${MOVING} ${VM}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE });
  });

  it("deletes the snapshot and leaves the VM where it is when it cannot be renamed", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.failRename({ code: "RESOURCE_NOT_READY", message: `The resource '${VM}' is not ready`, machineType: null });
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(service.start(SESSION_ID, reporter()));
    expect(error.message).toBe(`failed to rename ${VM} to ${MOVING}: The resource '${VM}' is not ready`);
    expect(fake.calls.slice(-2)).toEqual([`setName ${VM} ${MOVING}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.insertedZones).toEqual([]);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE, status: "TERMINATED" });
    expect(fake.snapshots.size).toBe(0);
  });

  it("leaves the VM untouched when its disk cannot be snapshotted", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.failSnapshot({ code: "RESOURCE_NOT_READY", message: "The disk is not ready.", machineType: null });
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(service.start(SESSION_ID, reporter()));
    expect(error.message).toBe(`failed to move ${VM}: snapshotting its disk failed: The disk is not ready.`);
    expect(fake.calls).not.toContain(`setName ${VM} ${MOVING}`);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE, status: "TERMINATED" });
  });

  it("gives up on a snapshot Compute Engine does not finish within the snapshot timeout", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.stickOperations(1);
    const { service, elapsed } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(service.start(SESSION_ID, reporter()));
    expect(error.message).toBe(`failed to snapshot the disk of ${VM}: Compute Engine has not finished after 10 minutes`);
    expect(elapsed()).toBeGreaterThanOrEqual(SNAPSHOT_TIMEOUT_MS);
    expect(fake.calls).not.toContain(`setName ${VM} ${MOVING}`);
  });

  it("stops a suspended VM whose zone has no capacity for its resume and moves it once it is off", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "SUSPENDED" })]);
    fake.failResume(STOCKOUT);
    fake.failStart(STOCKOUT);
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);
    const { reporter: hearer, steps, logs } = recorder();

    const result = await service.start(SESSION_ID, hearer);
    expect(result.vm.zone).toBe(ZONE_B);
    expect(fake.calls.slice(0, 4)).toEqual([`resume ${VM}`, `stop ${VM}`, `start ${VM}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.calls.slice(-3)).toEqual([`insert ${VM} in ${ZONE_B}`, `delete ${MOVING}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(steps).toEqual(["resumingVm", "startingVm", "movingVm", "vmReady"]);
    expect(logs.slice(0, 4)).toEqual([
      `resuming ${VM}`,
      `c4d-standard-8 is unavailable in ${ZONE}; stopping ${VM} to move it`,
      `starting ${VM}`,
      `c4d-standard-8 is unavailable in ${ZONE}; moving ${VM} to another zone`,
    ]);
  });

  it("fails the resume of a suspended VM without capacity when it cannot be stopped, or when no other zone exists", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "SUSPENDED" })]);
    fake.failResume(STOCKOUT);
    fake.failStop(new Error(`failed to stop ${VM}: HTTP 400 the VM is SUSPENDED`));
    const error = await rejection(createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]).service.start(SESSION_ID, reporter()));
    expect(error.message).toBe(
      `failed to resume ${VM}: The zone does not have enough resources available to fulfill the request; stopping it to move it failed: failed to stop ${VM}: HTTP 400 the VM is SUSPENDED`,
    );
    expect(fake.calls).toEqual([`resume ${VM}`, `stop ${VM}`]);

    const alone = fakeCompute([instance({ sessionId: ID, status: "SUSPENDED" })]);
    alone.failResume(STOCKOUT);
    const aloneError = await rejection(createService(alone.compute, fakeVm().vm, [ZONE]).service.start(SESSION_ID, reporter()));
    expect(aloneError.message).toBe(`failed to resume ${VM}: The zone does not have enough resources available to fulfill the request; its disk stays in ${ZONE}, try again later`);
    expect(alone.calls).toEqual([`resume ${VM}`]);
  });

  it("finishes an interrupted move that created no VM: the VM gets its name back and the snapshot goes", async () => {
    const fake = fakeCompute([instance({ name: MOVING, status: "TERMINATED", sessionId: ID })]);
    fake.snapshots.add(SNAPSHOT);
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, logs } = recorder();

    const result = await service.start(SESSION_ID, reporter);
    expect(result.vm.zone).toBe(ZONE);
    expect(fake.calls).toEqual([`setName ${MOVING} ${VM}`, `deleteSnapshot ${SNAPSHOT}`, `start ${VM}`]);
    expect([...fake.disks.keys()]).toEqual([`${ZONE}/${MOVING}`]);
    expect(fake.snapshots.size).toBe(0);
    expect(logs[0]).toBe(`finishing an interrupted move of ${VM}: it stays in ${ZONE}`);
  });

  it("finishes an interrupted move whose new VM exists: the replaced VM and the snapshot go", async () => {
    const fake = fakeCompute([instance({ zone: ZONE_B, sessionId: ID }), instance({ name: MOVING, status: "TERMINATED", sessionId: ID })]);
    fake.snapshots.add(SNAPSHOT);
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const result = await service.start(SESSION_ID, reporter());
    expect(result).toMatchObject({ vm: { zone: ZONE_B }, wasRunning: true });
    expect(fake.calls).toEqual([`delete ${MOVING}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.instances.has(MOVING)).toBe(false);
  });

  it("moves a stopped VM a provision reuses as well", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    const { service } = createService(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const result = await service.provision(REQUEST, reporter());
    expect(result).toMatchObject({ vm: { zone: ZONE_B }, created: false });
  });

  it("deletes a VM still under its moving name with the session, and reports it as existing", async () => {
    const fake = fakeCompute([instance({ name: MOVING, status: "TERMINATED", sessionId: ID })]);
    fake.snapshots.add(SNAPSHOT);
    const { service } = createService(fake.compute);

    expect(await service.get(SESSION_ID)).toEqual({ exists: true, name: VM, status: "TERMINATED" });
    await service.stop(SESSION_ID);
    expect(await service.delete(SESSION_ID)).toEqual({ alreadyGone: false });
    expect(fake.calls).toEqual([`delete ${MOVING}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.snapshots.size).toBe(0);
  });

  function reporter(): Reporter {
    return recorder().reporter;
  }
});

describe("SessionVmService.suspend, stop, delete and get", () => {
  it("suspends a running VM, waits for it, and leaves one that is not running alone", async () => {
    const fake = fakeCompute([instance({ sessionId: ID })]);
    const { service } = createService(fake.compute);

    await service.suspend(SESSION_ID);
    expect(fake.calls).toEqual([`suspend ${VM}`]);
    fake.instances.get(VM)!.status = "SUSPENDED";
    await service.suspend(SESSION_ID);
    fake.instances.get(VM)!.status = "STOPPING";
    await service.suspend(SESSION_ID);
    expect(fake.calls).toEqual([`suspend ${VM}`]);
    expect((await rejection(service.suspend(SessionId.of(OTHER_ID.replace("ab12cd34", "00000000"))))).code).toBe("notFound");
    expect((await rejection(createService(fakeCompute([instance({ sessionId: OTHER_ID })]).compute).service.suspend(SESSION_ID))).code).toBe("conflict");
  });

  it("fails a suspend Compute Engine refuses or does not finish in time", async () => {
    const refused = fakeCompute([instance({ sessionId: ID })]);
    refused.failSuspend({ code: "UNSUPPORTED_OPERATION", message: "Suspend is not supported for this machine type.", machineType: null });
    const error = await rejection(createService(refused.compute).service.suspend(SESSION_ID));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to suspend ${VM}: Suspend is not supported for this machine type` });

    const stuck = fakeCompute([instance({ sessionId: ID })]);
    stuck.stickOperations();
    const { service, elapsed } = createService(stuck.compute);
    expect((await rejection(service.suspend(SESSION_ID))).message).toBe(`failed to suspend ${VM}: Compute Engine has not finished after 10 minutes`);
    expect(elapsed()).toBeGreaterThanOrEqual(SUSPEND_TIMEOUT_MS);
  });

  it("stops a running VM and leaves one that is off alone", async () => {
    const fake = fakeCompute([instance({ sessionId: ID })]);
    const { service } = createService(fake.compute);

    await service.stop(SESSION_ID);
    fake.instances.get(VM)!.status = "TERMINATED";
    await service.stop(SESSION_ID);
    expect(fake.calls).toEqual([`stop ${VM}`]);
    expect((await rejection(service.stop(SessionId.of(OTHER_ID.replace("ab12cd34", "00000000"))))).code).toBe("notFound");
  });

  it("deletes the VM with every disk and counts a missing one as gone", async () => {
    const fake = fakeCompute([
      instance({
        sessionId: ID,
        disks: [
          { deviceName: "persistent-disk-0", autoDelete: true, boot: true, source: VM },
          { deviceName: "data", autoDelete: false, boot: false, source: "data" },
        ],
      }),
    ]);
    const { service } = createService(fake.compute);

    expect(await service.delete(SESSION_ID)).toEqual({ alreadyGone: false });
    expect(fake.calls).toEqual([`setDiskAutoDelete ${VM} data`, `delete ${VM}`]);
    expect(await service.delete(SESSION_ID)).toEqual({ alreadyGone: true });
  });

  it("refuses to delete a VM that holds another session", async () => {
    const fake = fakeCompute([instance({ sessionId: OTHER_ID })]);
    expect((await rejection(createService(fake.compute).service.delete(SESSION_ID))).code).toBe("conflict");
    expect(fake.calls).toEqual([]);
  });

  it("reports whether the session's VM exists and its status", async () => {
    const { service } = createService(fakeCompute([instance({ status: "SUSPENDED" })]).compute);
    expect(await service.get(SESSION_ID)).toEqual({ exists: true, name: VM, status: "SUSPENDED" });
    expect(await service.get(SessionId.of("00000000-0000-4000-8000-000000000000"))).toEqual({ exists: false, name: "vm-hunt-s-00000000", status: null });
  });
});

describe("SessionVmService.listSessions", () => {
  it("lists the session VMs of every zone that name their session, oldest first", async () => {
    const swfId = "00000001-0000-4000-8000-000000000000";
    const fake = fakeCompute([
      instance({
        sessionId: ID,
        labels: { ...SESSION_LABELS, "hunt-owner": "jane_doe_example_com" },
        creationTimestamp: "2026-10-13T09:00:00.000-07:00",
        metadata: {
          fingerprint: "",
          items: [
            { key: "hunt-session-id", value: ID },
            { key: "hunt-repo", value: "acme/app" },
            { key: "hunt-branch", value: "feat/login" },
            { key: "hunt-title", value: "Fix login" },
          ],
        },
      }),
      instance({
        name: "vm-hunt-s-00000001",
        zone: "us-central1-a",
        status: "TERMINATED",
        labels: { "hunt-role": "session", "hunt-session": "00000001", "hunt-origin": "swf" },
        creationTimestamp: "2026-10-12T09:00:00.000-07:00",
        metadata: { fingerprint: "", items: [{ key: "hunt-session-id", value: swfId }, { key: "hunt-issue", value: "42" }] },
      }),
      instance({ name: "vm-hunt-s-00000002" }),
      instance({ name: "vm-hunt-s-00000003", sessionId: ID }),
      instance({ name: MOVING, zone: ZONE_B, status: "TERMINATED", sessionId: ID }),
      instance({ name: "vm-hunt-medc", labels: { "hunt-role": "gateway" } }),
    ]);

    expect(await createService(fake.compute).service.listSessions()).toEqual([
      {
        id: swfId,
        vm: "vm-hunt-s-00000001",
        zone: "us-central1-a",
        status: "TERMINATED",
        origin: "swf",
        owner: "",
        repo: "",
        branch: "",
        title: "",
        issue: 42,
        agent: "",
        createdAt: "2026-10-12T09:00:00.000-07:00",
      },
      {
        id: ID,
        vm: VM,
        zone: ZONE,
        status: "RUNNING",
        origin: "desktop",
        owner: "jane_doe_example_com",
        repo: "acme/app",
        branch: "feat/login",
        title: "Fix login",
        issue: null,
        agent: "",
        createdAt: "2026-10-13T09:00:00.000-07:00",
      },
    ]);
  });
});
