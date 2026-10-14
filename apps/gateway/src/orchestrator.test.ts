import { describe, expect, it } from "vitest";
import type { ProgressStep } from "../../../libs/domain/src/gatewayApi.ts";
import type { Transport } from "./acpClient.ts";
import { ApiError } from "./apiProtocol.ts";
import type { Compute, Instance, InstanceRequest, MetadataItem } from "./gcp.ts";
import { CREATE_TIMEOUT_MS, labelValue, Orchestrator, START_TIMEOUT_MS, type ProvisionRequest, type Reporter } from "./orchestrator.ts";
import type { SessionVm } from "./sessionVm.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const OTHER_ID = "ab12cd34-0000-4000-8000-000000000002";
const VM = "vm-hunt-s-ab12cd34";
const ZONE = "europe-west3-a";
const LOCATION = { project: "medconomy-hunt", zone: ZONE };
const RELEASE = { version: "session@1.4.0", protocol: 1 };
const SESSION_LABELS = { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop" };

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
    labels: SESSION_LABELS,
    metadata: { fingerprint: "fp0", items },
    disks: [{ deviceName: "persistent-disk-0", autoDelete: true }],
    ...rest,
  };
}

/**
 * A Compute Engine with the VMs in `vms`. Each `get` of a VM first applies the next status of its queue in
 * `statuses`; insert, start and resume queue the statuses a VM goes through. Every change is recorded in `calls`.
 */
function fakeCompute(vms: Instance[] = []) {
  const instances = new Map(vms.map((vm) => [vm.name, structuredClone(vm)]));
  const statuses = new Map<string, string[]>();
  const calls: string[] = [];
  const inserted: InstanceRequest[] = [];
  let metadataFailures = 0;
  const compute: Compute = {
    list: async () => [...instances.values()].map((vm) => structuredClone(vm)),
    listByLabel: async (key, value) => [...instances.values()].filter((vm) => vm.labels[key] === value).map((vm) => structuredClone(vm)),
    get: async (name) => {
      const vm = instances.get(name);
      if (!vm) return null;
      const next = statuses.get(name)?.shift();
      if (next) {
        vm.status = next;
      }
      return structuredClone(vm);
    },
    insert: async (request) => {
      calls.push(`insert ${request.name}`);
      inserted.push(request);
      instances.set(request.name, instance({ name: request.name, status: "PROVISIONING", labels: request.labels }));
      statuses.set(request.name, ["PROVISIONING", "STAGING", "STAGING", "RUNNING"]);
    },
    setMetadata: async (name, fingerprint, items) => {
      calls.push(`setMetadata ${name} ${fingerprint}`);
      if (metadataFailures > 0) {
        metadataFailures--;
        throw new Error(`failed to set the metadata of ${name}: HTTP 412 Supplied fingerprint does not match`);
      }
      const vm = instances.get(name)!;
      vm.metadata = { fingerprint: `${fingerprint}+`, items };
    },
    start: async (name) => {
      calls.push(`start ${name}`);
      statuses.set(name, ["TERMINATED", "STAGING", "RUNNING"]);
    },
    resume: async (name) => {
      calls.push(`resume ${name}`);
      statuses.set(name, ["RESUMING", "RUNNING"]);
    },
    stop: async (name) => {
      calls.push(`stop ${name}`);
    },
    setDiskAutoDelete: async (name, deviceName) => {
      calls.push(`setDiskAutoDelete ${name} ${deviceName}`);
      const disk = instances.get(name)!.disks.find((candidate) => candidate.deviceName === deviceName)!;
      disk.autoDelete = true;
    },
    delete: async (name) => {
      calls.push(`delete ${name}`);
      instances.delete(name);
    },
  };
  return {
    compute,
    calls,
    inserted,
    statuses,
    instances,
    failMetadata: (count: number) => {
      metadataFailures = count;
    },
  };
}

/** A session VM whose startup script finished unless `isBooting`, and that needs the staged release when `isOutdated`. */
function fakeVm(options: { isBooting?: boolean; isOutdated?: boolean } = {}) {
  const calls: string[] = [];
  const vm: SessionVm = {
    run: async () => "",
    huntCtl: async () => ({}),
    waitUntilReady: async (_timeoutMs, onWaiting) => {
      calls.push("wait until ready");
      if (options.isBooting) {
        onWaiting?.();
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

function createOrchestrator(compute: Compute, vm: SessionVm = fakeVm().vm) {
  let time = 0;
  const orchestrator = new Orchestrator({
    compute,
    location: LOCATION,
    vm: () => vm,
    sleep: async (ms) => {
      time += ms;
      await Promise.resolve();
    },
    now: () => time,
  });
  return { orchestrator, elapsed: () => time };
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
    expect(calls).toEqual(["wait until ready", "ensure release"]);
    expect(logs[0]).toBe(`creating ${VM} from tpl-hunt-session`);
  });

  it("records the issue of a poller session and labels it without an owner", async () => {
    const fake = fakeCompute();
    const { orchestrator } = createOrchestrator(fake.compute);

    await orchestrator.provision({ ...REQUEST, origin: "swf", owner: "", issue: 12 }, recorder().reporter);
    expect(fake.inserted[0].labels).toEqual({ "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" });
    expect(fake.instances.get(VM)!.metadata.items.at(-1)).toEqual({ key: "hunt-issue", value: "12" });
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

  it("gives up on a VM that does not appear within the creation timeout", async () => {
    const fake = fakeCompute();
    fake.compute.insert = async () => {};
    const { orchestrator, elapsed } = createOrchestrator(fake.compute);

    const error = await rejection(orchestrator.provision(REQUEST, recorder().reporter));
    expect(error).toMatchObject({ code: "unavailable", message: `failed to create ${VM}: it is still missing after 2 minutes` });
    expect(elapsed()).toBeGreaterThanOrEqual(CREATE_TIMEOUT_MS);
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
    expect(calls).toEqual(["wait until ready", "ensure release"]);
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
    expect(calls).toEqual(["wait until ready", "ensure release"]);
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
    expect(calls).toEqual(["wait until ready", "ensure release", "wait until ready", "ensure release"]);
  });
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
          { deviceName: "persistent-disk-0", autoDelete: true },
          { deviceName: "data", autoDelete: false },
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
