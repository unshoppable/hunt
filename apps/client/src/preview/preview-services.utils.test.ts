import { describe, expect, it } from "vitest";
import type { PreviewService, PreviewStatus } from "./preview.types";
import { describeService, hasRespondingService, hasRunningService, isPreviewActive, isServiceRunning, offersStart, servicesToComplete, withLastKnown } from "./preview-services.utils";

function service(name: string, patch: Partial<PreviewService> = {}): PreviewService {
  return {
    name,
    port: 3000,
    url: "https://0123abcd-3000.p.example.com",
    guarded: true,
    tls: false,
    enabled: false,
    state: "stopped",
    responds: false,
    invocation: null,
    uses: [],
    ...patch,
  };
}

function status(services: PreviewService[], patch: Partial<PreviewStatus> = {}): PreviewStatus {
  return { vmRunning: true, services, ...patch };
}

const VM_OFF: PreviewStatus = { vmRunning: false, services: [] };

describe("describeService", () => {
  it("names each state and whether a running service answers", () => {
    expect(describeService(service("api", { state: "running", responds: true }), true)).toEqual({ text: "Running", tone: "ok" });
    expect(describeService(service("api", { state: "running" }), true)).toEqual({ text: "Running, not answering yet", tone: "warning" });
    expect(describeService(service("api", { state: "starting" }), true)).toEqual({ text: "Starting…", tone: "pending" });
    expect(describeService(service("api", { state: "failed" }), true)).toEqual({ text: "Failed", tone: "error" });
    expect(describeService(service("api"), true)).toEqual({ text: "Stopped", tone: "idle" });
  });

  it("says which services come back with a VM that is off", () => {
    expect(describeService(service("api", { enabled: true }), false)).toEqual({ text: "Starts with the VM", tone: "idle" });
    expect(describeService(service("api"), false)).toEqual({ text: "Stopped", tone: "idle" });
  });
});

describe("isServiceRunning", () => {
  it("takes a running or starting unit as running", () => {
    expect(isServiceRunning(service("api", { state: "running" }))).toBe(true);
    expect(isServiceRunning(service("api", { state: "starting" }))).toBe(true);
    expect(isServiceRunning(service("api", { state: "failed" }))).toBe(false);
    expect(isServiceRunning(service("api"))).toBe(false);
  });
});

describe("hasRunningService and hasRespondingService", () => {
  it("counts starting services as running but only answering ones as responding", () => {
    const starting = status([service("api", { state: "starting" }), service("web")]);
    expect(hasRunningService(starting)).toBe(true);
    expect(hasRespondingService(starting)).toBe(false);
    expect(hasRespondingService(status([service("api", { state: "running", responds: true })]))).toBe(true);
    expect(hasRunningService(status([service("api", { state: "failed" })]))).toBe(false);
  });
});

describe("isPreviewActive", () => {
  it("marks the Terminal tab while a service runs or starts on a running VM", () => {
    expect(isPreviewActive(null)).toBe(false);
    expect(isPreviewActive(status([service("api", { state: "starting" })]))).toBe(true);
    expect(isPreviewActive(status([service("api", { state: "failed" })]))).toBe(false);
    expect(isPreviewActive(status([service("api", { state: "running" })], { vmRunning: false }))).toBe(false);
  });
});

describe("offersStart", () => {
  it("offers to start the app while no service runs", () => {
    expect(offersStart(status([service("api"), service("web", { state: "failed" })]))).toBe(true);
    expect(offersStart(status([service("api", { state: "starting" }), service("web")]))).toBe(false);
    expect(offersStart(status([service("api", { state: "running" })]))).toBe(false);
  });

  it("offers it while the VM is off, but not for a hunt.json without services", () => {
    expect(offersStart(VM_OFF)).toBe(true);
    expect(offersStart(status([]))).toBe(false);
  });
});

describe("withLastKnown", () => {
  const running = status([service("api", { state: "running", responds: true, enabled: true, invocation: "a1" }), service("web", { port: 4200 })]);

  it("keeps the last known services as stopped while the VM is off", () => {
    expect(withLastKnown(running, VM_OFF)).toEqual({
      vmRunning: false,
      services: [service("api", { enabled: true }), service("web", { port: 4200 })],
    });
  });

  it("keeps them across repeated polls of a VM that is off", () => {
    const off = withLastKnown(running, VM_OFF);
    expect(withLastKnown(off, VM_OFF)).toEqual(off);
  });

  it("takes the VM's services once it runs, and an empty list when nothing was known", () => {
    const off = withLastKnown(running, VM_OFF);
    const empty = status([]);
    expect(withLastKnown(off, empty)).toBe(empty);
    expect(withLastKnown(null, VM_OFF)).toBe(VM_OFF);
    expect(withLastKnown(status([]), VM_OFF)).toBe(VM_OFF);
  });
});

describe("servicesToComplete", () => {
  const backend = (patch: Partial<PreviewService> = {}) => service("ppp-rl-backend", { uses: ["ppp-rl-admin-ui"], ...patch });
  const adminUi = (patch: Partial<PreviewService> = {}) => service("ppp-rl-admin-ui", { uses: ["ppp-rl-backend"], ...patch });

  it("names the stopped and failed services of an app one of whose services runs or starts", () => {
    expect(servicesToComplete(status([backend({ state: "running" }), adminUi()]))).toEqual(["ppp-rl-admin-ui"]);
    expect(servicesToComplete(status([backend({ state: "failed" }), adminUi({ state: "starting" })]))).toEqual(["ppp-rl-backend"]);
  });

  it("follows the links in either direction and over other services, in the order of hunt.json", () => {
    const services = [
      service("med-backend"),
      service("med-admin-ui", { uses: ["med-backend"], state: "running" }),
      service("med-ui", { uses: ["med-backend"] }),
      service("med-report-generator"),
    ];
    expect(servicesToComplete(status(services))).toEqual(["med-backend", "med-ui"]);
  });

  it("leaves the other apps, an app none of whose services runs, a VM that is off and links to undeclared services alone", () => {
    expect(servicesToComplete(status([backend({ state: "running" }), adminUi({ state: "running" }), service("med-backend", { uses: ["med-ui"] })]))).toEqual([]);
    expect(servicesToComplete(status([backend(), adminUi()]))).toEqual([]);
    expect(servicesToComplete(status([backend({ state: "running" }), adminUi()], { vmRunning: false }))).toEqual([]);
    expect(servicesToComplete(status([service("api", { uses: ["gone", "api"], state: "running" })]))).toEqual([]);
  });
});
