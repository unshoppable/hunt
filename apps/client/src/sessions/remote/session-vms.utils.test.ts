import { describe, expect, it } from "vitest";
import type { SessionVm } from "./remote-session.types";
import { filterSessionVms, sessionVmAgentLabel, sessionVmMarkState, sessionVmMeta, sessionVmOriginLabel, sessionVmStatusLabel, sessionVmUrl } from "./session-vms.utils";

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
    agent: "implement",
    ...overrides,
  };
}

describe("filterSessionVms", () => {
  const running = sessionVm();
  const older = sessionVm({ id: "2", title: "Sitemaps", branch: "feat/general/45-sitemaps", issue: 45, createdAt: "2026-10-15T06:00:00Z" });
  const stopped = sessionVm({ id: "3", title: "Jane's handoff", branch: "chore/general/cleanup", origin: "desktop", owner: "jane", issue: null, status: "TERMINATED", isRunning: false, createdAt: "2026-10-17T06:00:00Z" });

  it("lists running VMs and waiting ones only unless stopped ones are asked for, newest first", () => {
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

  it("puts a session whose agent waits for an answer first, even a stopped one", () => {
    const asking = sessionVm({ id: "5", agent: "question", status: "TERMINATED", isRunning: false, createdAt: "2026-10-14T06:00:00Z" });
    expect(filterSessionVms([older, asking, running], "", true).map((vm) => vm.id)).toEqual([asking.id, running.id, older.id]);
    expect(filterSessionVms([older, asking, stopped, running], "", false).map((vm) => vm.id)).toEqual([asking.id, running.id, older.id]);
  });

  it("treats a missing creation time as the oldest", () => {
    const undated = sessionVm({ id: "4", createdAt: null });
    expect(filterSessionVms([undated, running], "", false).map((vm) => vm.id)).toEqual([running.id, undated.id]);
  });
});

describe("sessionVmAgentLabel", () => {
  it("names a question, a finished and a failed agent, nothing for a step the agent works on or an unknown state", () => {
    expect(sessionVmAgentLabel(sessionVm({ agent: "question" }))).toMatchObject({ label: "Question", tone: "question" });
    expect(sessionVmAgentLabel(sessionVm({ agent: "done" }))).toMatchObject({ label: "Done", tone: "done" });
    expect(sessionVmAgentLabel(sessionVm({ agent: "failed" }))).toMatchObject({ label: "Failed", tone: "failed" });
    for (const agent of ["plan", "implement", "verify", "gate", "pr", "running", ""]) {
      expect(sessionVmAgentLabel(sessionVm({ agent })), agent).toBeNull();
    }
  });

  it("names the steps in which the pull request waits for others in a neutral tone", () => {
    expect(sessionVmAgentLabel(sessionVm({ agent: "review" }))).toEqual({
      label: "Review",
      tone: "neutral",
      title: "The pull request waits for the Claude review and its checks",
    });
    expect(sessionVmAgentLabel(sessionVm({ agent: "human-review" }))).toEqual({
      label: "Human review",
      tone: "neutral",
      title: "A person has to review the pull request",
    });
    expect(sessionVmAgentLabel(sessionVm({ agent: "merge" }))).toEqual({ label: "Merging", tone: "neutral", title: "Hunt merges the pull request" });
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

  it("lists repository, owner and age, leaving unknown parts out", () => {
    expect(sessionVmMeta(sessionVm(), now)).toEqual(["acme/app", "started 5 minutes ago"]);
    expect(sessionVmMeta(sessionVm({ owner: "jane", createdAt: null }), now)).toEqual(["acme/app", "by jane"]);
    expect(sessionVmMeta(sessionVm({ createdAt: "not a date" }), now)).toEqual(["acme/app"]);
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

describe("sessionVmMarkState", () => {
  it("is busy only while the pipeline is at a step on a running VM and asks while the agent waits for an answer", () => {
    for (const agent of ["plan", "implement", "verify", "gate", "pr", "review", "human-review", "merge", "running"]) {
      expect(sessionVmMarkState(sessionVm({ agent })), agent).toEqual({ isBusy: true, hasQuestion: false });
    }
    expect(sessionVmMarkState(sessionVm({ isRunning: false, status: "TERMINATED" }))).toEqual({ isBusy: false, hasQuestion: false });
    expect(sessionVmMarkState(sessionVm({ agent: "question" }))).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionVmMarkState(sessionVm({ agent: "done" }))).toEqual({ isBusy: false, hasQuestion: false });
    expect(sessionVmMarkState(sessionVm({ agent: "failed" }))).toEqual({ isBusy: false, hasQuestion: false });
    expect(sessionVmMarkState(sessionVm({ agent: "" }))).toEqual({ isBusy: false, hasQuestion: false });
  });
});
