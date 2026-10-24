import { describe, expect, it } from "vitest";
import type { PreviewService, PreviewStatus } from "../ipc/types";
import { describePreview, describeService, hasRespondingService, hasRunningService, isPreviewActive, isServiceInUse, offersStart, shouldPollFast, withLastKnown } from "./services";

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
    ...patch,
  };
}

function status(services: PreviewService[], patch: Partial<PreviewStatus> = {}): PreviewStatus {
  return { vmRunning: true, services, listening: [], ...patch };
}

const VM_OFF: PreviewStatus = { vmRunning: false, services: [], listening: [] };

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

describe("isServiceInUse", () => {
  it("lists running, starting and failed services but not stopped ones", () => {
    expect(isServiceInUse(service("api", { state: "running" }), true)).toBe(true);
    expect(isServiceInUse(service("api", { state: "starting" }), true)).toBe(true);
    expect(isServiceInUse(service("api", { state: "failed" }), true)).toBe(true);
    expect(isServiceInUse(service("api", { enabled: true }), true)).toBe(false);
  });

  it("lists the services that start with a VM that is off", () => {
    expect(isServiceInUse(service("api", { enabled: true }), false)).toBe(true);
    expect(isServiceInUse(service("api"), false)).toBe(false);
  });
});

describe("describePreview", () => {
  it("waits for the first status and reports a VM that is off", () => {
    expect(describePreview(null).text).toBe("…");
    expect(describePreview(VM_OFF)).toEqual({ text: "VM off", tone: "idle" });
    expect(describePreview(withLastKnown(status([service("api", { state: "running" })]), VM_OFF)).text).toBe("VM off");
  });

  it("reports a hunt.json without services", () => {
    expect(describePreview(status([]))).toEqual({ text: "No services in hunt.json", tone: "idle" });
  });

  it("counts running, starting and failed services", () => {
    const services = [service("api", { state: "running" }), service("admin", { state: "starting" }), service("web"), service("docs", { state: "failed" })];
    expect(describePreview(status(services))).toEqual({ text: "1 of 4 running, 1 starting, 1 failed", tone: "error" });
    expect(describePreview(status(services.slice(0, 3)))).toEqual({ text: "1 of 3 running, 1 starting", tone: "ok" });
    expect(describePreview(status(services.slice(1, 3)))).toEqual({ text: "1 starting", tone: "pending" });
    expect(describePreview(status([service("web")]))).toEqual({ text: "No service running", tone: "idle" });
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
  it("marks the Preview tab while a service runs or starts on a running VM", () => {
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
  const running = status([service("api", { state: "running", responds: true, enabled: true }), service("web", { port: 4200 })], {
    listening: [{ port: 9229, url: "https://0123abcd-9229.p.example.com" }],
  });

  it("keeps the last known services as stopped while the VM is off", () => {
    expect(withLastKnown(running, VM_OFF)).toEqual({
      vmRunning: false,
      services: [service("api", { enabled: true }), service("web", { port: 4200 })],
      listening: [],
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

describe("shouldPollFast", () => {
  it("polls fast while waiting for the app or while a service starts", () => {
    expect(shouldPollFast(null, true)).toBe(true);
    expect(shouldPollFast(status([service("api", { state: "starting" })]), false)).toBe(true);
    expect(shouldPollFast(status([service("api", { state: "running", responds: true })]), false)).toBe(false);
    expect(shouldPollFast(null, false)).toBe(false);
  });
});
