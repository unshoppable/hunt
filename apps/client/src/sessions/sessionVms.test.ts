import { describe, expect, it } from "vitest";
import type { SessionVm } from "../ipc/types";
import { filterSessionVms, sessionVmMeta, sessionVmOriginLabel, sessionVmStatusLabel, sessionVmUrl } from "./sessionVms";

function sessionVm(overrides: Partial<SessionVm> = {}): SessionVm {
  return {
    id: "ab12cd34-0000-4000-8000-000000000001",
    vm: { project: "acme-hunt", zone: "europe-west1-c", instance: "vm-hunt-s-ab12cd34" },
    title: "Fix login",
    repo: "acme/app",
    branch: "fix/general/123-fix-login",
    origin: "swf",
    owner: "",
    issue: 123,
    status: "RUNNING",
    isRunning: true,
    createdAt: "2026-10-16T06:00:00Z",
    ...overrides,
  };
}

describe("filterSessionVms", () => {
  const running = sessionVm();
  const older = sessionVm({ id: "2", title: "Sitemaps", branch: "feat/general/45-sitemaps", issue: 45, createdAt: "2026-10-15T06:00:00Z" });
  const stopped = sessionVm({ id: "3", title: "Jane's handoff", branch: "chore/general/cleanup", origin: "desktop", owner: "jane", issue: null, status: "TERMINATED", isRunning: false, createdAt: "2026-10-17T06:00:00Z" });

  it("lists running VMs only unless stopped ones are asked for, newest first", () => {
    expect(filterSessionVms([older, stopped, running], "", false).map((vm) => vm.id)).toEqual([running.id, older.id]);
    expect(filterSessionVms([older, stopped, running], "", true).map((vm) => vm.id)).toEqual([running.id, older.id, stopped.id]);
  });

  it("matches every word against title, repository, branch, issue, owner and VM name", () => {
    const vms = [running, older, stopped];
    expect(filterSessionVms(vms, "#123", true)).toEqual([running]);
    expect(filterSessionVms(vms, "login fix", true)).toEqual([running]);
    expect(filterSessionVms(vms, "jane", true)).toEqual([stopped]);
    expect(filterSessionVms(vms, "vm-hunt-s-ab12cd34 acme", true)).toHaveLength(3);
    expect(filterSessionVms(vms, "nothing", true)).toEqual([]);
  });

  it("treats a missing creation time as the oldest", () => {
    const undated = sessionVm({ id: "4", createdAt: null });
    expect(filterSessionVms([undated, running], "", false).map((vm) => vm.id)).toEqual([running.id, undated.id]);
  });
});

describe("sessionVmOriginLabel", () => {
  it("names the poller's issue and calls a handoff remote", () => {
    expect(sessionVmOriginLabel(sessionVm())).toBe("swf #123");
    expect(sessionVmOriginLabel(sessionVm({ issue: null }))).toBe("swf");
    expect(sessionVmOriginLabel(sessionVm({ origin: "desktop", issue: null }))).toBe("remote");
  });
});

describe("sessionVmMeta", () => {
  const now = Date.parse("2026-10-16T06:05:00Z");

  it("lists repository, branch, owner and age, leaving unknown parts out", () => {
    expect(sessionVmMeta(sessionVm(), now)).toEqual(["acme/app", "fix/general/123-fix-login", "started 5 minutes ago"]);
    expect(sessionVmMeta(sessionVm({ branch: "", owner: "jane", createdAt: null }), now)).toEqual(["acme/app", "by jane"]);
    expect(sessionVmMeta(sessionVm({ createdAt: "not a date" }), now)).toEqual(["acme/app", "fix/general/123-fix-login"]);
  });
});

describe("sessionVmUrl", () => {
  it("opens the issue of a swf session and the repository otherwise", () => {
    expect(sessionVmUrl(sessionVm())).toBe("https://github.com/acme/app/issues/123");
    expect(sessionVmUrl(sessionVm({ origin: "desktop", issue: null }))).toBe("https://github.com/acme/app");
  });
});

describe("sessionVmStatusLabel", () => {
  it("words the Compute Engine status", () => {
    expect(sessionVmStatusLabel(sessionVm())).toBe("Running");
    expect(sessionVmStatusLabel(sessionVm({ status: "TERMINATED", isRunning: false }))).toBe("Stopped");
    expect(sessionVmStatusLabel(sessionVm({ status: "STAGING", isRunning: false }))).toBe("Staging");
    expect(sessionVmStatusLabel(sessionVm({ status: "", isRunning: false }))).toBe("Unknown");
  });
});
