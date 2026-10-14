import { describe, expect, it } from "vitest";
import type { PreviewService } from "../ipc/types";
import { nextActiveKey, terminalTabs } from "./terminalTabs";

function service(name: string): PreviewService {
  return { name, port: 3000, url: `https://${name}.example`, guarded: true, tls: false, enabled: true, state: "running", responds: true };
}

describe("terminalTabs", () => {
  it("lists the services in hunt.json's order, then the windows in tmux's order", () => {
    const tabs = terminalTabs([service("api"), service("web")], [{ id: "@4", name: "worker" }, { id: "@1", name: "shell" }]);
    expect(tabs.map((tab) => [tab.key, tab.label])).toEqual([
      ["service:api", "api"],
      ["service:web", "web"],
      ["window:@4", "worker"],
      ["window:@1", "shell"],
    ]);
    expect(tabs[0].target).toEqual({ kind: "service", name: "api" });
    expect(tabs[0].service?.name).toBe("api");
    expect(tabs[2].target).toEqual({ kind: "window", id: "@4" });
    expect(tabs[2].service).toBeNull();
  });

  it("tells windows of the same name apart by their order", () => {
    const tabs = terminalTabs([], [{ id: "@1", name: "shell" }, { id: "@2", name: "vite" }, { id: "@5", name: "shell" }, { id: "@9", name: "shell" }]);
    expect(tabs.map((tab) => tab.label)).toEqual(["shell", "vite", "shell 2", "shell 3"]);
  });
});

describe("nextActiveKey", () => {
  const before = terminalTabs([service("api")], [{ id: "@1", name: "a" }, { id: "@2", name: "b" }, { id: "@3", name: "c" }]);

  it("keeps the active tab while it exists", () => {
    expect(nextActiveKey(before, before.slice(1), "window:@2")).toBe("window:@2");
  });

  it("moves to the next tab when the active one disappears, else to the one before it", () => {
    const withoutB = before.filter((tab) => tab.key !== "window:@2");
    expect(nextActiveKey(before, withoutB, "window:@2")).toBe("window:@3");
    const withoutC = before.filter((tab) => tab.key !== "window:@3");
    expect(nextActiveKey(before, withoutC, "window:@3")).toBe("window:@2");
    const onlyApi = before.slice(0, 1);
    expect(nextActiveKey(before, onlyApi, "window:@2")).toBe("service:api");
  });

  it("starts with the first tab and has none without tabs", () => {
    expect(nextActiveKey([], before, null)).toBe("service:api");
    expect(nextActiveKey(before, before, "window:@7")).toBe("service:api");
    expect(nextActiveKey(before, [], "service:api")).toBeNull();
  });
});
