import { describe, expect, it } from "vitest";
import type { Instance } from "./gcp.ts";
import { IdleSweeper, SWEEP_INTERVAL_MS } from "./idle.ts";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ZONE = "europe-west1-c";
const SESSION_ID = "ab12cd34-0000-4000-8000-000000000001";
const VM = "vm-hunt-s-ab12cd34";
const OTHER_ID = "cd34ef56-0000-4000-8000-000000000002";
const OTHER_VM = "vm-hunt-s-cd34ef56";
const IDLE = "idle: no turn, client, permission request, preview page view, login or hunt-ctl activity for 30 min";

function sessionVm(name: string, id: string | null, overrides: Partial<Instance> = {}): Instance {
  return {
    name,
    zone: ZONE,
    status: "RUNNING",
    creationTimestamp: "2026-10-19T08:00:00Z",
    lastStopTimestamp: "",
    lastSuspendedTimestamp: "",
    labels: { "hunt-role": "session", "hunt-origin": "desktop" },
    metadata: { fingerprint: "fp0", items: id ? [{ key: "hunt-session-id", value: id }] : [] },
    disks: [],
    machineType: "c4d-standard-8",
    ...overrides,
  };
}

/**
 * A sweeper over the VMs `vms`, whose idle checks answer from `decisions` (by VM name; a missing one fails the SSH
 * command, an Error is thrown) and whose suspends `failing` refuses; records every call and log line.
 */
function createSweeper(vms: Instance[], decisions: Record<string, string | Error>, failing: Set<string> = new Set()) {
  const calls: string[] = [];
  const logs: string[] = [];
  let now = NOW;
  const sweeper = new IdleSweeper({
    compute: {
      list: async (filter) => {
        calls.push(`list ${filter}`);
        return vms;
      },
    },
    orchestrator: {
      suspend: async (id) => {
        calls.push(`suspend ${id}`);
        if (failing.has(id)) throw new Error(`failed to suspend ${id}: HTTP 403 forbidden`);
      },
    },
    vm: (name, zone) => ({
      idleDecision: async () => {
        calls.push(`check ${name} in ${zone}`);
        const decision = decisions[name];
        if (decision === undefined) throw new Error(`failed to run the idle check of ${name}: ssh: connect to host ${name} port 22: Connection refused`);
        if (decision instanceof Error) throw decision;
        return decision;
      },
    }),
    zone: ZONE,
    now: () => now,
    log: (message, level = "info") => logs.push(`${level}: ${message}`),
  });
  return { sweeper, calls, logs, advance: (ms: number) => (now += ms) };
}

describe("IdleSweeper.cycle", () => {
  it("asks every running session VM once per interval and suspends the idle ones", async () => {
    const { sweeper, calls, logs, advance } = createSweeper(
      [
        sessionVm(VM, SESSION_ID),
        sessionVm(OTHER_VM, OTHER_ID, { zone: "europe-west1-d" }),
        sessionVm("vm-hunt-s-11111111", "11111111-0000-4000-8000-000000000003", { status: "SUSPENDED" }),
        sessionVm("vm-hunt-s-22222222", "22222222-0000-4000-8000-000000000004", { labels: { "hunt-role": "gateway" } }),
      ],
      { [VM]: IDLE, [OTHER_VM]: "keep: a turn is running" },
    );

    await sweeper.cycle();
    expect(calls).toEqual([`list labels.hunt-role = "session" AND status = RUNNING`, `check ${VM} in ${ZONE}`, `check ${OTHER_VM} in europe-west1-d`, `suspend ${SESSION_ID}`]);
    expect(logs).toEqual([`info: sweeper: suspending ${VM} (session ${SESSION_ID}): ${IDLE.slice("idle: ".length)}`, `info: sweeper: suspended ${VM}`]);

    await sweeper.cycle();
    expect(calls).toHaveLength(4);
    advance(SWEEP_INTERVAL_MS);
    await sweeper.cycle();
    expect(calls).toHaveLength(8);
  });

  it("leaves a VM alone whose check decides to power it off itself", async () => {
    const { sweeper, calls, logs } = createSweeper([sessionVm(VM, SESSION_ID)], { [VM]: "poweroff: idle for 15 min and not suspended by the gateway" });
    await sweeper.cycle();
    expect(calls).toEqual([expect.stringMatching(/^list /), `check ${VM} in ${ZONE}`]);
    expect(logs).toEqual([]);
  });

  it("logs a lasting failure of a VM once, logs it again when it changes, and forgets it once the VM passes or is gone", async () => {
    const decisions: Record<string, string | Error> = { [OTHER_VM]: IDLE };
    const vms = [sessionVm(VM, SESSION_ID), sessionVm(OTHER_VM, OTHER_ID), sessionVm("vm-hunt-s-33333333", null)];
    const { sweeper, calls, logs, advance } = createSweeper(vms, decisions, new Set([OTHER_ID]));

    await sweeper.cycle();
    expect([...logs].sort()).toEqual([
      `info: sweeper: suspending ${OTHER_VM} (session ${OTHER_ID}): ${IDLE.slice("idle: ".length)}`,
      "warn: sweeper: vm-hunt-s-33333333: it names no session",
      `warn: sweeper: ${VM}: failed to run the idle check of ${VM}: ssh: connect to host ${VM} port 22: Connection refused`,
      `warn: sweeper: ${OTHER_VM}: failed to suspend ${OTHER_ID}: HTTP 403 forbidden`,
    ]);

    advance(SWEEP_INTERVAL_MS);
    await sweeper.cycle();
    expect(logs).toHaveLength(5);
    expect(logs[4]).toBe(`info: sweeper: suspending ${OTHER_VM} (session ${OTHER_ID}): ${IDLE.slice("idle: ".length)}`);

    decisions[VM] = new Error("failed to run the idle check: timed out");
    advance(SWEEP_INTERVAL_MS);
    await sweeper.cycle();
    expect(logs.slice(5).sort()).toEqual([expect.stringMatching(/^info: sweeper: suspending/), `warn: sweeper: ${VM}: failed to run the idle check: timed out`]);

    decisions[VM] = "keep: booted 3 min ago, within the grace period of 15 min";
    vms.splice(2, 1);
    advance(SWEEP_INTERVAL_MS);
    await sweeper.cycle();
    delete decisions[VM];
    vms.push(sessionVm("vm-hunt-s-33333333", null));
    advance(SWEEP_INTERVAL_MS);
    await sweeper.cycle();
    expect(logs.slice(7).sort()).toEqual([
      expect.stringMatching(/^info: sweeper: suspending/),
      expect.stringMatching(/^info: sweeper: suspending/),
      "warn: sweeper: vm-hunt-s-33333333: it names no session",
      `warn: sweeper: ${VM}: failed to run the idle check of ${VM}: ssh: connect to host ${VM} port 22: Connection refused`,
    ]);
    expect(calls.filter((call) => call.startsWith("suspend"))).toHaveLength(5);
  });

  it("logs a failed listing and tries again at the next interval", async () => {
    const logs: string[] = [];
    let now = NOW;
    const sweeper = new IdleSweeper({
      compute: {
        list: async () => {
          throw new Error("HTTP 500");
        },
      },
      orchestrator: { suspend: async () => {} },
      vm: () => ({ idleDecision: async () => "keep: test" }),
      zone: ZONE,
      now: () => now,
      log: (message, level = "info") => logs.push(`${level}: ${message}`),
    });
    await sweeper.cycle();
    await sweeper.cycle();
    now += SWEEP_INTERVAL_MS;
    await sweeper.cycle();
    expect(logs).toEqual(["error: sweeper: listing the session VMs failed: HTTP 500", "error: sweeper: listing the session VMs failed: HTTP 500"]);
  });
});
