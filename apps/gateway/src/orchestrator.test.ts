import { describe, expect, it } from "vitest";
import type { ProgressStep } from "../../../libs/domain/src/gatewayApi.ts";
import type { Transport } from "./acpClient.ts";
import { ApiError } from "./apiProtocol.ts";
import type { Compute, Disk, Instance, InstanceRequest, MetadataItem, OperationError, OperationState } from "./gcp.ts";
import { CREATE_TIMEOUT_MS, labelValue, Orchestrator, SNAPSHOT_TIMEOUT_MS, START_TIMEOUT_MS, type ProvisionRequest, type Reporter } from "./orchestrator.ts";
import type { SessionVm } from "./sessionVm.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const OTHER_ID = "ab12cd34-0000-4000-8000-000000000002";
const VM = "vm-hunt-s-ab12cd34";
const MOVING = `${VM}-moving`;
const SNAPSHOT = `${VM}-move`;
const BOOT_DISK: Disk = { type: "hyperdisk-balanced", sizeGb: 50 };
const ZONE = "europe-west3-a";
const ZONE_B = "europe-west3-b";
const ZONE_C = "europe-west3-c";
const LOCATION = { project: "medconomy-hunt", zone: ZONE };
const RELEASE = { version: "session@1.4.0", protocol: 1 };
const SESSION_LABELS = { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop" };
const STOCKOUT: OperationError = {
  code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
  message: "The zone does not have enough resources available to fulfill the request.",
  machineType: "c4d-standard-8",
};

const REQUEST: ProvisionRequest = {
  id: ID,
  title: "Fix login",
  repo: "acme/app",
  branch: "feat/login",
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
 * call; `failStart` does the same for the start in a zone. Every change is recorded in `calls`.
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
    operation: async ({ name }) => {
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
    stop: async (zone, name) => {
      calls.push(`stop ${name}`);
      find(zone, name);
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

/** The call that puts the remote secrets of `createOrchestrator` on a VM. */
const PUT_SECRETS = `hunt-ctl put-remote-secrets <<< {"MED_OPENAI_API_KEY":"sk-1"}`;

/**
 * A session VM whose startup script finished unless `isBooting`, that fails a readiness check with `failure` while it
 * boots and needs the staged release when `isOutdated`.
 */
function fakeVm(options: { isBooting?: boolean; failure?: string; isOutdated?: boolean } = {}) {
  const calls: string[] = [];
  const vm: SessionVm = {
    run: async () => "",
    huntCtl: async (args, input) => {
      calls.push(`hunt-ctl ${args.join(" ")} <<< ${String(input)}`);
      return {};
    },
    waitUntilReady: async (_timeoutMs, onWaiting, onFailure) => {
      calls.push("wait until ready");
      if (options.isBooting) {
        onWaiting?.();
        if (options.failure) {
          onFailure?.(options.failure);
        }
      }
    },
    ensureRelease: async (onInstall) => {
      calls.push("ensure release");
      if (options.isOutdated) {
        onInstall?.();
      }
      return RELEASE;
    },
    putClaudeFiles: async () => {},
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

/** An Orchestrator over `compute` whose session VMs are `vm`; `vmZones` records the zone of every VM it reaches. */
function createOrchestrator(compute: Compute, vm: SessionVm = fakeVm().vm, zones = [ZONE]) {
  let time = 0;
  const vmZones: string[] = [];
  const orchestrator = new Orchestrator({
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
  return { orchestrator, elapsed: () => time, vmZones };
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

describe("Orchestrator.provision", () => {
  it("creates a missing VM with its labels, records the session and reports the steps in order", async () => {
    const fake = fakeCompute();
    const { vm, calls } = fakeVm({ isBooting: true, isOutdated: true });
    const { orchestrator } = createOrchestrator(fake.compute, vm);
    const { reporter, steps, logs } = recorder();

    const result = await orchestrator.provision({ ...REQUEST, owner: "Jane.Doe@example.com", machineType: "e2-standard-8" }, reporter);

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
    expect(steps).toEqual(["creatingVm", "waitingForVm", "installingRuntime"]);
    expect(calls).toEqual(["wait until ready", "ensure release", PUT_SECRETS]);
    expect(logs[0]).toBe(`creating ${VM} from tpl-hunt-session in ${ZONE}`);
  });

  it("logs why a booting VM does not answer while it waits for it", async () => {
    const { vm } = fakeVm({ isBooting: true, failure: `failed to run a command on ${VM}: exit status 255` });
    const { orchestrator } = createOrchestrator(fakeCompute().compute, vm);
    const { reporter, steps, logs } = recorder();

    await orchestrator.provision(REQUEST, reporter);

    expect(steps).toContain("waitingForVm");
    expect(logs).toContain(`${VM} does not answer yet: failed to run a command on ${VM}: exit status 255`);
  });

  it("records the issue of a poller session and labels it without an owner", async () => {
    const fake = fakeCompute();
    const { orchestrator } = createOrchestrator(fake.compute);

    await orchestrator.provision({ ...REQUEST, origin: "swf", owner: "", issue: 12 }, recorder().reporter);
    expect(fake.inserted[0].labels).toEqual({ "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" });
    expect(fake.instances.get(VM)!.metadata.items.slice(-2)).toEqual([
      { key: "hunt-issue", value: "12" },
      { key: "hunt-agent", value: "running" },
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
    const { orchestrator } = createOrchestrator(fake.compute);
    const { reporter, steps } = recorder();

    const result = await orchestrator.provision(REQUEST, reporter);
    expect(result.created).toBe(false);
    expect(fake.calls).toEqual([`start ${VM}`]);
    expect(steps).toEqual(["startingVm"]);
  });

  it("records the session on a VM a failed attempt left without it, retrying when the metadata changed meanwhile", async () => {
    const fake = fakeCompute([instance({})]);
    fake.failMetadata(1);
    const { orchestrator } = createOrchestrator(fake.compute);

    await orchestrator.provision(REQUEST, recorder().reporter);
    expect(fake.calls).toEqual([`setMetadata ${VM} fp0`, `setMetadata ${VM} fp0`]);
    expect(fake.instances.get(VM)!.metadata.items.find((item) => item.key === "hunt-session-id")?.value).toBe(ID);
  });

  it("refuses a VM that holds another session or is no session VM", async () => {
    const taken = fakeCompute([instance({ sessionId: OTHER_ID })]);
    const error = await rejection(createOrchestrator(taken.compute).orchestrator.provision(REQUEST, recorder().reporter));
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(`${VM} holds the session ${OTHER_ID}, not ${ID}`);
    expect(taken.calls).toEqual([]);

    const foreign = fakeCompute([instance({ labels: { "hunt-role": "gateway" } })]);
    expect((await rejection(createOrchestrator(foreign.compute).orchestrator.provision(REQUEST, recorder().reporter))).code).toBe("forbidden");
  });

  it("gives up on a creation Compute Engine does not finish within the creation timeout", async () => {
    const fake = fakeCompute();
    fake.stickOperations();
    const { orchestrator, elapsed } = createOrchestrator(fake.compute);

    const error = await rejection(orchestrator.provision(REQUEST, recorder().reporter));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to create ${VM} in ${ZONE}: Compute Engine has not finished after 2 minutes` });
    expect(elapsed()).toBeGreaterThanOrEqual(CREATE_TIMEOUT_MS);
  });

  it("creates the VM in the next zone when a zone has no capacity for it and reaches it there", async () => {
    const fake = fakeCompute();
    fake.insertErrors.set(ZONE, STOCKOUT);
    const { orchestrator, vmZones } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, steps, logs } = recorder();

    const result = await orchestrator.provision(REQUEST, reporter);
    expect(result).toMatchObject({ vm: { project: "medconomy-hunt", zone: ZONE_B, instance: VM }, created: true });
    expect(fake.insertedZones).toEqual([ZONE, ZONE_B]);
    expect(vmZones).toEqual([ZONE_B]);
    expect(steps).toEqual(["creatingVm"]);
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
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    expect((await orchestrator.provision(REQUEST, recorder().reporter)).vm.zone).toBe(ZONE_B);
  });

  it("names the machine type and every zone when none has capacity for the VM", async () => {
    const fake = fakeCompute();
    for (const zone of [ZONE, ZONE_B, ZONE_C]) {
      fake.insertErrors.set(zone, STOCKOUT);
    }
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);

    const error = await rejection(orchestrator.provision(REQUEST, recorder().reporter));
    expect(error).toMatchObject({
      code: "unavailable",
      message: `failed to create ${VM}: c4d-standard-8 is unavailable in ${ZONE}, ${ZONE_B} and ${ZONE_C}; try again later or pick another machine type`,
    });
  });

  it("stops at a failure other than a lack of capacity", async () => {
    const fake = fakeCompute();
    fake.insertErrors.set(ZONE, { code: "QUOTA_EXCEEDED", message: "Quota 'C4D_CPUS' exceeded. Limit: 24.0 in region europe-west3.", machineType: null });
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(orchestrator.provision(REQUEST, recorder().reporter));
    expect(error.message).toBe(`failed to create ${VM} in ${ZONE}: Quota 'C4D_CPUS' exceeded. Limit: 24.0 in region europe-west3.`);
    expect(fake.insertedZones).toEqual([ZONE]);
  });

  it("reuses the session's VM in another zone than the first and works with it there", async () => {
    const fake = fakeCompute([instance({ zone: ZONE_C, status: "TERMINATED", sessionId: ID })]);
    const { orchestrator, vmZones } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);
    const { reporter, logs } = recorder();

    const result = await orchestrator.provision(REQUEST, reporter);
    expect(result).toMatchObject({ vm: { zone: ZONE_C }, created: false });
    expect(logs[0]).toBe(`${VM} exists already in ${ZONE_C}`);
    expect(vmZones).toEqual([ZONE_C]);
    await orchestrator.stop(ID);
    expect(await orchestrator.delete(ID)).toEqual({ alreadyGone: false });
    expect(fake.calls).toEqual([`setMetadata ${VM} fp0`, `start ${VM}`, `stop ${VM}`, `delete ${VM}`]);
  });
});

describe("Orchestrator.start", () => {
  it("brings a running VM up without starting it", async () => {
    const fake = fakeCompute([instance({ sessionId: ID })]);
    const { vm, calls } = fakeVm();
    const { reporter, steps } = recorder();

    const result = await createOrchestrator(fake.compute, vm).orchestrator.start(ID, reporter);
    expect(result).toEqual({ vm: { project: "medconomy-hunt", zone: ZONE, instance: VM }, wasRunning: true, release: RELEASE });
    expect(fake.calls).toEqual([]);
    expect(steps).toEqual([]);
    expect(calls).toEqual(["wait until ready", "ensure release", PUT_SECRETS]);
  });

  it("resumes a suspended VM", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "SUSPENDED" })]);
    const { reporter, steps, logs } = recorder();

    const result = await createOrchestrator(fake.compute).orchestrator.start(ID, reporter);
    expect(result.wasRunning).toBe(false);
    expect(fake.calls).toEqual([`resume ${VM}`]);
    expect(steps).toEqual(["startingVm"]);
    expect(logs[0]).toBe(`resuming ${VM}`);
  });

  it("waits out a shutdown in progress and then starts the VM once", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "STOPPING" })]);
    fake.statuses.set(VM, ["STOPPING", "STOPPING", "TERMINATED"]);
    const { reporter, steps, logs } = recorder();

    await createOrchestrator(fake.compute).orchestrator.start(ID, reporter);
    expect(fake.calls).toEqual([`start ${VM}`]);
    expect(steps).toEqual(["startingVm"]);
    expect(logs.slice(0, 2)).toEqual([`waiting for ${VM} to finish shutting down`, `starting ${VM}`]);
  });

  it("gives up on a VM that does not run within the start timeout", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "STAGING" })]);
    const { orchestrator, elapsed } = createOrchestrator(fake.compute);

    const error = await rejection(orchestrator.start(ID, recorder().reporter));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to start ${VM}: it is still STAGING after 6 minutes` });
    expect(elapsed()).toBeGreaterThanOrEqual(START_TIMEOUT_MS);
  });

  it("fails at once when Compute Engine refuses to start the VM, without waiting for the start timeout", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "TERMINATED" })]);
    fake.failStart({ ...STOCKOUT, message: `A c4d-standard-8 VM instance is currently unavailable in the ${ZONE} zone.` });
    const { orchestrator, elapsed } = createOrchestrator(fake.compute);

    const error = await rejection(orchestrator.start(ID, recorder().reporter));
    expect(error).toMatchObject({
      code: "unavailable",
      message: `failed to start ${VM}: A c4d-standard-8 VM instance is currently unavailable in the ${ZONE} zone; its disk stays in ${ZONE}, try again later`,
    });
    expect(elapsed()).toBeLessThan(START_TIMEOUT_MS);
  });

  it("reports a missing VM as notFound", async () => {
    expect((await rejection(createOrchestrator(fakeCompute().compute).orchestrator.start(ID, recorder().reporter))).code).toBe("notFound");
  });

  it("lets concurrent calls for one session share one operation and replays its progress to the later ones", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "TERMINATED" })]);
    const { vm, calls } = fakeVm({ isOutdated: true });
    let ready = () => {};
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const waitUntilReady = vm.waitUntilReady;
    vm.waitUntilReady = async (timeoutMs, onWaiting) => {
      await isReady;
      await waitUntilReady(timeoutMs, onWaiting);
    };
    const { orchestrator } = createOrchestrator(fake.compute, vm);
    const first = recorder();
    const second = recorder();

    const running = orchestrator.start(ID, first.reporter);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const joined = orchestrator.start(ID, second.reporter);
    ready();
    const [a, b] = await Promise.all([running, joined]);

    expect(a).toEqual(b);
    expect(a.wasRunning).toBe(false);
    expect(fake.calls).toEqual([`start ${VM}`]);
    expect(calls).toEqual(["wait until ready", "ensure release", PUT_SECRETS]);
    expect(first.steps).toEqual(["startingVm", "installingRuntime"]);
    expect(second.steps).toEqual(["startingVm", "installingRuntime"]);
  });

  it("runs a different operation for the same session after the first one ended", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "TERMINATED" })]);
    const { vm, calls } = fakeVm();
    const { orchestrator } = createOrchestrator(fake.compute, vm);

    const order: string[] = [];
    const started = orchestrator.start(ID, recorder().reporter).then(() => order.push("start"));
    const provisioned = orchestrator.provision(REQUEST, recorder().reporter).then(() => order.push("provision"));
    await Promise.all([started, provisioned]);

    expect(order).toEqual(["start", "provision"]);
    expect(fake.calls).toEqual([`start ${VM}`, `setMetadata ${VM} fp0`]);
    expect(calls).toEqual(["wait until ready", "ensure release", PUT_SECRETS, "wait until ready", "ensure release", PUT_SECRETS]);
  });
});

describe("Orchestrator.start moving the VM", () => {
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
    const { orchestrator, vmZones } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, steps, logs } = recorder();

    const result = await orchestrator.start(ID, reporter);
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
    expect(steps).toEqual(["startingVm", "movingVm"]);
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
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, logs } = recorder();

    expect((await orchestrator.start(ID, reporter)).vm.zone).toBe(ZONE_C);
    expect(fake.calls.slice(5, 7)).toEqual([`insert ${VM} in ${ZONE_B}`, `insert ${VM} in ${ZONE_C}`]);
    expect(logs).toContain(`c4d-standard-8 is unavailable in ${ZONE_B}; trying ${ZONE_C}`);
    expect([...fake.disks.keys()]).toEqual([`${ZONE_C}/${VM}`]);
  });

  it("skips a zone as well when Compute Engine refuses the creation itself for lack of capacity", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.insertErrors.set(ZONE_B, new Error(`failed to create ${VM} from tpl-hunt-session in ${ZONE_B}: HTTP 503 {"error":{"errors":[{"reason":"ZONE_RESOURCE_POOL_EXHAUSTED"}]}}`));
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);

    expect((await orchestrator.start(ID, reporter())).vm.zone).toBe(ZONE_C);
    expect(fake.insertedZones).toEqual([ZONE_B, ZONE_C]);
  });

  it("gives the VM its name back and names every zone when none has capacity", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.insertErrors.set(ZONE_B, STOCKOUT);
    fake.insertErrors.set(ZONE_C, STOCKOUT);
    const { orchestrator, elapsed } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, logs } = recorder();

    const error = await rejection(orchestrator.start(ID, reporter));
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
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);

    const error = await rejection(orchestrator.start(ID, reporter()));
    expect(error.message).toBe(`failed to create ${VM} in ${ZONE_B}: Quota 'C4D_CPUS' exceeded.`);
    expect(fake.insertedZones).toEqual([ZONE_B]);
    expect(fake.calls.slice(-2)).toEqual([`setName ${MOVING} ${VM}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE });
  });

  it("deletes the snapshot and leaves the VM where it is when it cannot be renamed", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.failRename({ code: "RESOURCE_NOT_READY", message: `The resource '${VM}' is not ready`, machineType: null });
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(orchestrator.start(ID, reporter()));
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
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(orchestrator.start(ID, reporter()));
    expect(error.message).toBe(`failed to move ${VM}: snapshotting its disk failed: The disk is not ready.`);
    expect(fake.calls).not.toContain(`setName ${VM} ${MOVING}`);
    expect(fake.instances.get(VM)).toMatchObject({ zone: ZONE, status: "TERMINATED" });
  });

  it("gives up on a snapshot Compute Engine does not finish within the snapshot timeout", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    fake.stickOperations(1);
    const { orchestrator, elapsed } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(orchestrator.start(ID, reporter()));
    expect(error.message).toBe(`failed to snapshot the disk of ${VM}: Compute Engine has not finished after 10 minutes`);
    expect(elapsed()).toBeGreaterThanOrEqual(SNAPSHOT_TIMEOUT_MS);
    expect(fake.calls).not.toContain(`setName ${VM} ${MOVING}`);
  });

  it("does not move a suspended VM whose zone has no capacity for its resume", async () => {
    const fake = fakeCompute([instance({ sessionId: ID, status: "SUSPENDED" })]);
    fake.failResume(STOCKOUT);
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const error = await rejection(orchestrator.start(ID, reporter()));
    expect(error.message).toBe(`failed to resume ${VM}: The zone does not have enough resources available to fulfill the request; its disk stays in ${ZONE}, try again later`);
    expect(fake.calls).toEqual([`resume ${VM}`]);
  });

  it("finishes an interrupted move that created no VM: the VM gets its name back and the snapshot goes", async () => {
    const fake = fakeCompute([instance({ name: MOVING, status: "TERMINATED", sessionId: ID })]);
    fake.snapshots.add(SNAPSHOT);
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B, ZONE_C]);
    const { reporter, logs } = recorder();

    const result = await orchestrator.start(ID, reporter);
    expect(result.vm.zone).toBe(ZONE);
    expect(fake.calls).toEqual([`setName ${MOVING} ${VM}`, `deleteSnapshot ${SNAPSHOT}`, `start ${VM}`]);
    expect([...fake.disks.keys()]).toEqual([`${ZONE}/${MOVING}`]);
    expect(fake.snapshots.size).toBe(0);
    expect(logs[0]).toBe(`finishing an interrupted move of ${VM}: it stays in ${ZONE}`);
  });

  it("finishes an interrupted move whose new VM exists: the replaced VM and the snapshot go", async () => {
    const fake = fakeCompute([instance({ zone: ZONE_B, sessionId: ID }), instance({ name: MOVING, status: "TERMINATED", sessionId: ID })]);
    fake.snapshots.add(SNAPSHOT);
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const result = await orchestrator.start(ID, reporter());
    expect(result).toMatchObject({ vm: { zone: ZONE_B }, wasRunning: true });
    expect(fake.calls).toEqual([`delete ${MOVING}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.instances.has(MOVING)).toBe(false);
  });

  it("moves a stopped VM a provision reuses as well", async () => {
    const fake = fakeCompute([stoppedVm()]);
    fake.failStart(STOCKOUT);
    const { orchestrator } = createOrchestrator(fake.compute, fakeVm().vm, [ZONE, ZONE_B]);

    const result = await orchestrator.provision(REQUEST, reporter());
    expect(result).toMatchObject({ vm: { zone: ZONE_B }, created: false });
  });

  it("deletes a VM still under its moving name with the session, and reports it as existing", async () => {
    const fake = fakeCompute([instance({ name: MOVING, status: "TERMINATED", sessionId: ID })]);
    fake.snapshots.add(SNAPSHOT);
    const { orchestrator } = createOrchestrator(fake.compute);

    expect(await orchestrator.get(ID)).toEqual({ exists: true, name: VM, status: "TERMINATED" });
    await orchestrator.stop(ID);
    expect(await orchestrator.delete(ID)).toEqual({ alreadyGone: false });
    expect(fake.calls).toEqual([`delete ${MOVING}`, `deleteSnapshot ${SNAPSHOT}`]);
    expect(fake.snapshots.size).toBe(0);
  });

  function reporter(): Reporter {
    return recorder().reporter;
  }
});

describe("Orchestrator.stop, delete and get", () => {
  it("stops a running VM and leaves one that is off alone", async () => {
    const fake = fakeCompute([instance({ sessionId: ID })]);
    const { orchestrator } = createOrchestrator(fake.compute);

    await orchestrator.stop(ID);
    fake.instances.get(VM)!.status = "TERMINATED";
    await orchestrator.stop(ID);
    expect(fake.calls).toEqual([`stop ${VM}`]);
    expect((await rejection(orchestrator.stop(OTHER_ID.replace("ab12cd34", "00000000")))).code).toBe("notFound");
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
    const { orchestrator } = createOrchestrator(fake.compute);

    expect(await orchestrator.delete(ID)).toEqual({ alreadyGone: false });
    expect(fake.calls).toEqual([`setDiskAutoDelete ${VM} data`, `delete ${VM}`]);
    expect(await orchestrator.delete(ID)).toEqual({ alreadyGone: true });
  });

  it("refuses to delete a VM that holds another session", async () => {
    const fake = fakeCompute([instance({ sessionId: OTHER_ID })]);
    expect((await rejection(createOrchestrator(fake.compute).orchestrator.delete(ID))).code).toBe("conflict");
    expect(fake.calls).toEqual([]);
  });

  it("reports whether the session's VM exists and its status", async () => {
    const { orchestrator } = createOrchestrator(fakeCompute([instance({ status: "SUSPENDED" })]).compute);
    expect(await orchestrator.get(ID)).toEqual({ exists: true, name: VM, status: "SUSPENDED" });
    expect(await orchestrator.get("00000000-0000-4000-8000-000000000000")).toEqual({ exists: false, name: "vm-hunt-s-00000000", status: null });
  });
});

describe("Orchestrator.listSessions", () => {
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

    expect(await createOrchestrator(fake.compute).orchestrator.listSessions()).toEqual([
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

describe("labelValue", () => {
  it("keeps OS Login names and replaces what a label value cannot hold", () => {
    expect(labelValue("jane_doe_example_com")).toBe("jane_doe_example_com");
    expect(labelValue("Jane.Doe@Example.com")).toBe("jane_doe_example_com");
    expect(labelValue("x".repeat(70))).toHaveLength(63);
  });
});
