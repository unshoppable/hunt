import { describe, expect, it } from "vitest";
import type { PreviewService, PreviewStatus, TmuxWindow } from "../ipc/types";
import { endedScriptWindow, isProcessWindow, isTerminalActive, nextActiveKey, terminalTabs, windowState } from "./terminalTabs";

function service(name: string, state: PreviewService["state"] = "running"): PreviewService {
  return { name, port: 3000, url: `https://${name}.example`, guarded: true, tls: false, enabled: true, state, responds: true };
}

function window(id: string, name: string, overrides: Partial<TmuxWindow> = {}): TmuxWindow {
  return { id, name, script: null, isDead: false, exitCode: null, ...overrides };
}

function status(services: PreviewService[]): PreviewStatus {
  return { vmRunning: true, services, listening: [] };
}

describe("terminalTabs", () => {
  it("lists the services in hunt.json's order, then the VM's windows, then this Mac's, in tmux's order", () => {
    const tabs = terminalTabs([service("api"), service("web")], [window("@4", "worker"), window("@1", "shell")], [window("@1", "vite")], true);
    expect(tabs.map((tab) => [tab.key, tab.label])).toEqual([
      ["service:api", "api"],
      ["service:web", "web"],
      ["window:vm:@4", "worker"],
      ["window:vm:@1", "shell"],
      ["window:desktop:@1", "vite (Mac)"],
    ]);
    expect(tabs[0].target).toEqual({ kind: "service", name: "api" });
    expect(tabs[0].service?.name).toBe("api");
    expect(tabs[2].target).toEqual({ kind: "window", id: "@4", machine: "vm" });
    expect(tabs[2].service).toBeNull();
    expect(tabs[4].target).toEqual({ kind: "window", id: "@1", machine: "desktop" });
    expect(tabs[2].title).toContain("~/logs/worker.log");
    expect(tabs[4].title).toContain(".hunt/logs/desktop/vite.log");
  });

  it("labels this Mac's windows plainly in a local session", () => {
    expect(terminalTabs([], [], [window("@1", "shell")], false).map((tab) => tab.label)).toEqual(["shell"]);
  });

  it("tells windows of the same name on one machine apart by their order", () => {
    const tabs = terminalTabs([], [window("@1", "shell"), window("@2", "vite"), window("@5", "shell")], [window("@3", "shell")], false);
    expect(tabs.map((tab) => tab.label)).toEqual(["shell", "vite", "shell 2", "shell"]);
  });
});

describe("windowState", () => {
  it("shows whether a script runs and how it ended", () => {
    expect(windowState(window("@1", "shell"))).toBeNull();
    expect(windowState(window("@2", "start", { script: "start" }))).toEqual({ text: "Running", tone: "ok" });
    expect(windowState(window("@2", "start", { script: "start", isDead: true, exitCode: 0 }))).toEqual({ text: "Process finished with exit code 0.", tone: "idle" });
    expect(windowState(window("@2", "start", { script: "start", isDead: true, exitCode: 2 }))?.tone).toBe("error");
  });
});

describe("endedScriptWindow", () => {
  it("offers to run again only an ended script window, on the VM as on this Mac", () => {
    const ended = window("@2", "start", { script: "start", isDead: true, exitCode: 1 });
    const [vmTab, desktopTab] = terminalTabs([], [ended], [ended], true);
    expect(endedScriptWindow(desktopTab)).toBe(ended);
    expect(endedScriptWindow(vmTab)).toBe(ended);
    expect(endedScriptWindow(terminalTabs([], [window("@3", "shell", { isDead: true })], [], false)[0])).toBeNull();
    expect(endedScriptWindow(terminalTabs([], [], [window("@2", "start", { script: "start" })], false)[0])).toBeNull();
    expect(endedScriptWindow(terminalTabs([service("api")], [], [], false)[0])).toBeNull();
  });
});

describe("isProcessWindow and isTerminalActive", () => {
  it("counts running scripts and the agent's windows, not Hunt's shells or ended scripts", () => {
    expect(isProcessWindow(window("@1", "shell"))).toBe(false);
    expect(isProcessWindow(window("@2", "shell-3"))).toBe(false);
    expect(isProcessWindow(window("@3", "vite"))).toBe(true);
    expect(isProcessWindow(window("@4", "shell", { script: "shell" }))).toBe(true);
    expect(isProcessWindow(window("@5", "start", { script: "start", isDead: true, exitCode: 0 }))).toBe(false);
  });

  it("marks the tab while a service or a process in either machine's windows runs", () => {
    expect(isTerminalActive(status([service("api")]), { vm: null, desktop: null })).toBe(true);
    expect(isTerminalActive(status([service("api", "stopped")]), { vm: [window("@1", "shell")], desktop: null })).toBe(false);
    expect(isTerminalActive(null, { vm: null, desktop: [window("@1", "vite")] })).toBe(true);
    expect(isTerminalActive(null, { vm: null, desktop: null })).toBe(false);
  });
});

describe("nextActiveKey", () => {
  const before = terminalTabs([service("api")], [window("@1", "a"), window("@2", "b"), window("@3", "c")], [], false);

  it("keeps the active tab while it exists", () => {
    expect(nextActiveKey(before, before.slice(1), "window:vm:@2")).toBe("window:vm:@2");
  });

  it("moves to the next tab when the active one disappears, else to the one before it", () => {
    const withoutB = before.filter((tab) => tab.key !== "window:vm:@2");
    expect(nextActiveKey(before, withoutB, "window:vm:@2")).toBe("window:vm:@3");
    const withoutC = before.filter((tab) => tab.key !== "window:vm:@3");
    expect(nextActiveKey(before, withoutC, "window:vm:@3")).toBe("window:vm:@2");
    const onlyApi = before.slice(0, 1);
    expect(nextActiveKey(before, onlyApi, "window:vm:@2")).toBe("service:api");
  });

  it("starts with the first tab and has none without tabs", () => {
    expect(nextActiveKey([], before, null)).toBe("service:api");
    expect(nextActiveKey(before, before, "window:vm:@7")).toBe("service:api");
    expect(nextActiveKey(before, [], "service:api")).toBeNull();
  });
});
