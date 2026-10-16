import { describe, expect, it } from "vitest";
import type { Compute, Instance } from "./gcp.ts";
import { Orchestrator } from "./orchestrator.ts";
import { offSince, Reaper, RETENTION_DAYS, SWEEP_INTERVAL_MS } from "./reaper.ts";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const ZONE = "europe-west3-a";
const SESSION_ID = "ab12cd34-0000-4000-8000-000000000001";
const VM = "vm-hunt-s-ab12cd34";
const OTHER_ID = "cd34ef56-0000-4000-8000-000000000002";
const OTHER_VM = "vm-hunt-s-cd34ef56";

const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

function sessionVm(name: string, id: string | null, overrides: Partial<Instance> = {}): Instance {
  return {
    name,
    zone: ZONE,
    status: "TERMINATED",
    creationTimestamp: daysAgo(30),
    lastStopTimestamp: "",
    lastSuspendedTimestamp: "",
    labels: { "hunt-role": "session", "hunt-origin": "desktop" },
    metadata: { fingerprint: "fp0", items: id ? [{ key: "hunt-session-id", value: id }] : [] },
    disks: [{ deviceName: "persistent-disk-0", autoDelete: true, boot: true, source: name }],
    machineType: "c4d-standard-8",
    ...overrides,
  };
}

/** A Compute that lists `vms`; `get` answers from `current` when set, else from the listing; every change is recorded. */
function fakeCompute(vms: Instance[], current = new Map<string, Instance | null>()) {
  const calls: string[] = [];
  const unexpected = async () => {
    throw new Error("unexpected call");
  };
  const find = async (name: string) => (current.has(name) ? (current.get(name) ?? null) : (vms.find((vm) => vm.name === name) ?? null));
  const compute: Compute = {
    list: async () => vms,
    listByLabel: unexpected,
    locate: find,
    get: async (_zone, name) => {
      calls.push(`get ${name}`);
      return find(name);
    },
    insert: unexpected,
    operation: unexpected,
    setMetadata: unexpected,
    start: unexpected,
    resume: unexpected,
    stop: unexpected,
    setDiskAutoDelete: unexpected,
    delete: async (_zone, name) => {
      calls.push(`delete ${name}`);
      if (name === OTHER_VM) throw new Error(`failed to delete ${name}: HTTP 500`);
    },
    setName: unexpected,
    getDisk: unexpected,
    createSnapshot: unexpected,
    deleteSnapshot: unexpected,
    insertDisk: unexpected,
    deleteDisk: unexpected,
  };
  return { compute, calls };
}

function createReaper(vms: Instance[], current?: Map<string, Instance | null>) {
  const { compute, calls } = fakeCompute(vms, current);
  const logs: string[] = [];
  let now = NOW;
  const orchestrator = new Orchestrator({
    compute,
    location: { project: "medconomy-hunt", zone: ZONE },
    zones: () => [ZONE],
    vm: () => ({}) as never,
    sleep: async () => {},
    now: () => now,
  });
  const reaper = new Reaper({ compute, orchestrator, zone: ZONE, now: () => now, log: (message) => logs.push(message) });
  return { reaper, calls, logs, advance: (ms: number) => (now += ms) };
}

describe("offSince", () => {
  it("reads the stop time of a stopped VM and the suspension time of a suspended one", () => {
    expect(offSince(sessionVm(VM, SESSION_ID, { lastStopTimestamp: daysAgo(8) }))).toBe(NOW - 8 * DAY_MS);
    expect(offSince(sessionVm(VM, SESSION_ID, { status: "SUSPENDED", lastStopTimestamp: daysAgo(20), lastSuspendedTimestamp: daysAgo(8) }))).toBe(NOW - 8 * DAY_MS);
  });

  it("is null for a running VM, also with an old stop time, and without a time", () => {
    expect(offSince(sessionVm(VM, SESSION_ID, { status: "RUNNING", lastStopTimestamp: daysAgo(8) }))).toBeNull();
    expect(offSince(sessionVm(VM, SESSION_ID))).toBeNull();
  });
});

describe("Reaper.cycle", () => {
  it("deletes a VM stopped for longer than the retention and keeps younger and running ones", async () => {
    const { reaper, calls, logs } = createReaper([
      sessionVm(VM, SESSION_ID, { lastStopTimestamp: daysAgo(RETENTION_DAYS + 1) }),
      sessionVm("vm-hunt-s-11111111", "11111111-0000-4000-8000-000000000003", { lastStopTimestamp: daysAgo(RETENTION_DAYS - 1) }),
      sessionVm("vm-hunt-s-22222222", "22222222-0000-4000-8000-000000000004", { status: "RUNNING", lastStopTimestamp: daysAgo(20) }),
      sessionVm("vm-hunt-s-33333333", "33333333-0000-4000-8000-000000000005"),
    ]);
    await reaper.cycle();
    expect(calls).toEqual([`get ${VM}`, `delete ${VM}`]);
    expect(logs).toEqual([`reaper: deleting ${VM} (session ${SESSION_ID}, origin desktop, off for ${RETENTION_DAYS + 1} days)`]);
  });

  it("deletes a VM suspended for longer than the retention", async () => {
    const { reaper, calls } = createReaper([sessionVm(VM, SESSION_ID, { status: "SUSPENDED", lastSuspendedTimestamp: daysAgo(9) })]);
    await reaper.cycle();
    expect(calls).toEqual([`get ${VM}`, `delete ${VM}`]);
  });

  it("keeps a VM that was started since the listing and notes one that is gone", async () => {
    const stale = sessionVm(VM, SESSION_ID, { lastStopTimestamp: daysAgo(9) });
    const started = createReaper([stale], new Map([[VM, { ...stale, status: "RUNNING" }]]));
    await started.reaper.cycle();
    expect(started.calls).toEqual([`get ${VM}`]);
    expect(started.logs).toEqual([`reaper: keeping ${VM}: it is RUNNING`]);

    const gone = createReaper([stale], new Map([[VM, null]]));
    await gone.reaper.cycle();
    expect(gone.calls).toEqual([`get ${VM}`]);
    expect(gone.logs).toEqual([`reaper: ${VM} is already gone`]);
  });

  it("only reports a stale VM that names no session or another VM's session", async () => {
    const { reaper, calls, logs } = createReaper([
      sessionVm(VM, null, { lastStopTimestamp: daysAgo(9) }),
      sessionVm(OTHER_VM, SESSION_ID, { lastStopTimestamp: daysAgo(9) }),
      sessionVm("vm-other", SESSION_ID, { labels: {}, lastStopTimestamp: daysAgo(9) }),
    ]);
    await reaper.cycle();
    expect(calls).toEqual([]);
    expect(logs).toEqual([
      `reaper: ${VM} has been off for 9 days but names no session; delete it by hand`,
      `reaper: ${OTHER_VM} has been off for 9 days but names no session; delete it by hand`,
    ]);
  });

  it("goes on with the other VMs when one deletion fails", async () => {
    const { reaper, calls, logs } = createReaper([
      sessionVm(OTHER_VM, OTHER_ID, { lastStopTimestamp: daysAgo(10) }),
      sessionVm(VM, SESSION_ID, { lastStopTimestamp: daysAgo(8) }),
    ]);
    await reaper.cycle();
    expect(calls).toEqual([`get ${OTHER_VM}`, `delete ${OTHER_VM}`, `get ${VM}`, `delete ${VM}`]);
    expect(logs).toEqual([
      `reaper: deleting ${OTHER_VM} (session ${OTHER_ID}, origin desktop, off for 10 days)`,
      `reaper: deleting ${OTHER_VM} failed: failed to delete ${OTHER_VM}: HTTP 500`,
      `reaper: deleting ${VM} (session ${SESSION_ID}, origin desktop, off for 8 days)`,
    ]);
  });

  it("sweeps once per interval and logs a failed listing", async () => {
    const { reaper, calls, advance } = createReaper([sessionVm(VM, SESSION_ID, { lastStopTimestamp: daysAgo(9) })]);
    await reaper.cycle();
    await reaper.cycle();
    advance(SWEEP_INTERVAL_MS - 1);
    await reaper.cycle();
    expect(calls).toEqual([`get ${VM}`, `delete ${VM}`]);
    advance(1);
    await reaper.cycle();
    expect(calls).toEqual([`get ${VM}`, `delete ${VM}`, `get ${VM}`, `delete ${VM}`]);

    const logs: string[] = [];
    const failing = new Reaper({
      compute: {
        list: async () => {
          throw new Error("HTTP 503");
        },
        get: async () => null,
      },
      orchestrator: { delete: async () => ({ alreadyGone: true }) },
      zone: ZONE,
      now: () => NOW,
      log: (message) => logs.push(message),
    });
    await failing.cycle();
    expect(logs).toEqual(["reaper: listing the session VMs failed: HTTP 503"]);
  });
});
