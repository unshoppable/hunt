import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import type { Instance, MetadataItem } from "../gcp/compute-engine.client.ts";
import { labelValue, SessionVm } from "./session-vm.domain.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const OTHER_ID = "cd34ef56-0000-4000-8000-000000000002";
const VM = "vm-hunt-s-ab12cd34";
const ZONE = "europe-west3-a";
const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

/** The running VM of session ID as Compute Engine lists it, with the metadata entries `metadata` after the template's. */
function instance(overrides: Partial<Instance> = {}, metadata: Record<string, string> = { "hunt-session-id": ID }): Instance {
  const items: MetadataItem[] = [{ key: "startup-script", value: "#!/bin/sh" }, ...Object.entries(metadata).map(([key, value]) => ({ key, value }))];
  return {
    name: VM,
    zone: ZONE,
    status: "RUNNING",
    creationTimestamp: "2026-10-13T08:00:00.000-07:00",
    lastStopTimestamp: "",
    lastSuspendedTimestamp: "",
    labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop" },
    metadata: { fingerprint: "fp0", items },
    disks: [{ deviceName: "persistent-disk-0", autoDelete: true, boot: true, source: VM }],
    machineType: "c4d-standard-8",
    ...overrides,
  };
}

/** `instance(overrides, metadata)` as a session VM; the fixture is one by construction. */
function sessionVm(overrides: Partial<Instance> = {}, metadata?: Record<string, string>): SessionVm {
  return SessionVm.fromInstance(instance(overrides, metadata))!;
}

describe("SessionVm.fromInstance", () => {
  it("takes the fields the gateway reads, with the metadata items by key", () => {
    expect(sessionVm({ status: "SUSPENDED", lastSuspendedTimestamp: daysAgo(1) }).toJSON()).toEqual({
      name: VM,
      zone: ZONE,
      status: "SUSPENDED",
      creationTimestamp: "2026-10-13T08:00:00.000-07:00",
      lastStopTimestamp: "",
      lastSuspendedTimestamp: daysAgo(1),
      labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop" },
      metadata: { "startup-script": "#!/bin/sh", "hunt-session-id": ID },
    });
  });

  it("is null for a VM without the label hunt-role=session", () => {
    expect(SessionVm.fromInstance(instance({ labels: {} }))).toBeNull();
    expect(SessionVm.fromInstance(instance({ labels: { "hunt-role": "gateway" } }))).toBeNull();
  });

  it("falls back to the given zone only for a VM that names none", () => {
    expect(SessionVm.fromInstance(instance({ zone: "" }), "europe-west1-c")!.zone).toBe("europe-west1-c");
    expect(SessionVm.fromInstance(instance({ zone: "" }))!.zone).toBe("");
    expect(SessionVm.fromInstance(instance(), "europe-west1-c")!.zone).toBe(ZONE);
  });

  it("keeps the first of metadata items with the same key", () => {
    const duplicated = instance();
    duplicated.metadata.items.push({ key: "hunt-session-id", value: OTHER_ID });
    expect(SessionVm.fromInstance(duplicated)!.metadata["hunt-session-id"]).toBe(ID);
  });
});

describe("SessionVm.sessionId", () => {
  it("is the session the metadata records when the VM carries its name", () => {
    expect(sessionVm().sessionId).toEqual(SessionId.of(ID));
  });

  it("is null without a valid session ID and for another VM's session, such as a VM under its moving name", () => {
    expect(sessionVm({}, {}).sessionId).toBeNull();
    expect(sessionVm({}, { "hunt-session-id": "not-a-uuid" }).sessionId).toBeNull();
    expect(sessionVm({}, { "hunt-session-id": OTHER_ID }).sessionId).toBeNull();
    expect(sessionVm({ name: `${VM}-moving` }).sessionId).toBeNull();
  });
});

describe("SessionVm.summary", () => {
  it("lists the session from the labels and metadata", () => {
    const poller = sessionVm(
      { status: "TERMINATED", labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" } },
      {
        "hunt-session-id": ID,
        "hunt-repo": "acme/app",
        "hunt-branch": "feat/general/12-login",
        "hunt-title": "Login",
        "hunt-issue": "12",
        "hunt-agent": "implement",
      },
    );
    expect(poller.summary).toEqual({
      id: ID,
      vm: VM,
      zone: ZONE,
      status: "TERMINATED",
      origin: "swf",
      owner: "",
      repo: "acme/app",
      branch: "feat/general/12-login",
      title: "Login",
      issue: 12,
      agent: "implement",
      createdAt: "2026-10-13T08:00:00.000-07:00",
    });
    expect(sessionVm({ labels: { "hunt-role": "session", "hunt-origin": "desktop", "hunt-owner": "jane_doe_example_com" } }).summary).toMatchObject({
      origin: "desktop",
      owner: "jane_doe_example_com",
      repo: "",
      branch: "",
      title: "",
      issue: null,
      agent: "",
    });
  });

  it("is null for a VM that holds no session", () => {
    expect(sessionVm({}, {}).summary).toBeNull();
    expect(sessionVm({ name: "vm-hunt-s-00000002" }).summary).toBeNull();
  });
});

describe("SessionVm labels and metadata", () => {
  it("reads empty values for missing labels and metadata", () => {
    const bare = sessionVm({ labels: { "hunt-role": "session" } }, {});
    expect([bare.origin, bare.owner, bare.repo, bare.branch, bare.title, bare.agent]).toEqual(["", "", "", "", "", ""]);
  });

  it("reads an issue only from an issue number", () => {
    expect(sessionVm({}, { "hunt-issue": "42" }).issue).toBe(42);
    for (const value of ["0", "042", "12a", "", "12345678901"]) {
      expect(sessionVm({}, { "hunt-issue": value }).issue).toBeNull();
    }
  });

  it("tells whether the metadata records every entry with its value", () => {
    const recorded = sessionVm({}, { "hunt-session-id": ID, "hunt-title": "" });
    expect(recorded.hasMetadataEntries({ "hunt-session-id": ID, "hunt-title": "" })).toBe(true);
    expect(recorded.hasMetadataEntries({ "hunt-session-id": OTHER_ID })).toBe(false);
    expect(recorded.hasMetadataEntries({ "hunt-repo": "" })).toBe(false);
    expect(recorded.hasMetadataEntries({})).toBe(true);
  });
});

describe("SessionVm status", () => {
  it("tells a running VM from an off one, through the statuses of vm-status.utils.ts", () => {
    expect([sessionVm().isRunning, sessionVm().isOff]).toEqual([true, false]);
    for (const status of ["TERMINATED", "STOPPED", "SUSPENDED"]) {
      expect([sessionVm({ status }).isRunning, sessionVm({ status }).isOff]).toEqual([false, true]);
    }
    for (const status of ["PROVISIONING", "STAGING", "STOPPING", "SUSPENDING"]) {
      expect([sessionVm({ status }).isRunning, sessionVm({ status }).isOff]).toEqual([false, false]);
    }
  });

  it("tells a stopped or stopping VM, which a stop leaves alone, from a running or suspended one", () => {
    for (const status of ["TERMINATED", "STOPPED", "STOPPING"]) {
      expect(sessionVm({ status }).isStoppedOrStopping, status).toBe(true);
    }
    for (const status of ["RUNNING", "PROVISIONING", "SUSPENDED", "SUSPENDING"]) {
      expect(sessionVm({ status }).isStoppedOrStopping, status).toBe(false);
    }
  });

  it("reads the stop time of a stopped VM and the suspension time of a suspended one", () => {
    expect(sessionVm({ status: "TERMINATED", lastStopTimestamp: daysAgo(8) }).offSince).toBe(NOW - 8 * DAY_MS);
    expect(sessionVm({ status: "SUSPENDED", lastStopTimestamp: daysAgo(20), lastSuspendedTimestamp: daysAgo(8) }).offSince).toBe(NOW - 8 * DAY_MS);
  });

  it("knows no off time for a VM that is not off, also with an old stop time, nor without a time", () => {
    expect(sessionVm({ status: "RUNNING", lastStopTimestamp: daysAgo(8) }).offSince).toBeNull();
    expect(sessionVm({ status: "STOPPING", lastStopTimestamp: daysAgo(8) }).offSince).toBeNull();
    expect(sessionVm({ status: "TERMINATED" }).offSince).toBeNull();
  });
});

describe("SessionVm.assertHoldsSession", () => {
  it("accepts a VM that records the session or none", () => {
    expect(() => sessionVm().assertHoldsSession(SessionId.of(ID))).not.toThrow();
    expect(() => sessionVm({}, {}).assertHoldsSession(SessionId.of(ID))).not.toThrow();
    expect(() => sessionVm({ name: `${VM}-moving` }).assertHoldsSession(SessionId.of(ID))).not.toThrow();
  });

  it("refuses a VM that records another session as a conflict", () => {
    let error: unknown = null;
    try {
      sessionVm({}, { "hunt-session-id": OTHER_ID }).assertHoldsSession(SessionId.of(ID));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "conflict", message: `${VM} holds the session ${OTHER_ID}, not ${ID}` });
  });
});

describe("labelValue", () => {
  it("keeps OS Login names and replaces what a label value cannot hold", () => {
    expect(labelValue("jane_doe_example_com")).toBe("jane_doe_example_com");
    expect(labelValue("Jane.Doe@Example.com")).toBe("jane_doe_example_com");
    expect(labelValue("x".repeat(70))).toHaveLength(63);
  });
});
