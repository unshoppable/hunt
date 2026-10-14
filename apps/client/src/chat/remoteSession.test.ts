import { describe, expect, it } from "vitest";
import type { RemoteStep, SessionView } from "../ipc/types";
import { createEmptyChat } from "../state/store";
import { formatElapsed, handOffBlocker, moveStatus, remotePosition, retrieveBlocker } from "./remoteSession";

function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id,
    title: id,
    repoPath: "/repo",
    worktreePath: `/worktrees/${id}`,
    branch: `feat/general/${id}`,
    baseRef: "main",
    baseCommit: "abc",
    acpSessionId: "acp",
    createdAt: "",
    isLive: true,
    parentId: null,
    selection: null,
    summary: [],
    touchedFiles: [],
    worktreeChangedAt: null,
    pullRequest: null,
    diffBase: null,
    reviewComments: [],
    workspace: "worktree",
    keepsBranch: false,
    remote: null,
    leftoverVm: null,
    dependencies: null,
    ...patch,
  };
}

/** Nothing unsaved and a Claude account selected. */
const READY = { hasUnsavedEdits: false, hasClaudeAccount: true };

describe("handOffBlocker", () => {
  it("lets an idle top-level session in its own worktree go", () => {
    const top = session("top");
    expect(handOffBlocker(top, [top], READY)).toBeNull();
  });

  it("keeps sub sessions, checkout sessions, reviews and parents of sub sessions local", () => {
    const top = session("top");
    const sub = session("sub", { parentId: "top" });
    expect(handOffBlocker(sub, [top, sub], READY)).toMatch(/parent/);
    expect(handOffBlocker(top, [top, sub], READY)).toMatch(/sub sessions/);
    expect(handOffBlocker(session("c", { workspace: "checkout" }), [], READY)).toMatch(/checkout/);
    expect(handOffBlocker(session("r", { pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }), [], READY)).toMatch(/review/);
  });

  it("needs a Claude account, since the local login stays on this Mac", () => {
    const top = session("top");
    expect(handOffBlocker(top, [top], { ...READY, hasClaudeAccount: false })).toMatch(/Claude account/);
  });

  it("waits for unsaved edits in the editor", () => {
    const top = session("top");
    expect(handOffBlocker(top, [top], { ...READY, hasUnsavedEdits: true })).toMatch(/unsaved/);
  });
});

describe("retrieveBlocker", () => {
  const vm = { project: "p", zone: "z", instance: "vm-hunt-s-top00000" };
  const remote = {
    vm,
    worktreePath: "/home/agent/app",
    repo: "acme/app",
    branch: "feat/general/top",
    handoffHead: "",
    handedOffAt: "2026-10-13T10:00:00Z",
    localMode: null,
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: null,
    origin: "handoff" as const,
    issue: null,
  };

  it("lets a session with a local checkout come back", () => {
    expect(retrieveBlocker(session("top", { remote }))).toBeNull();
  });

  it("needs a local checkout for an adopted session", () => {
    const adopted = session("top", { repoPath: "", remote: { ...remote, origin: "swf", issue: 12 } });
    expect(retrieveBlocker(adopted)).toMatch(/local checkout of acme\/app/);
    expect(retrieveBlocker({ ...adopted, repoPath: "/src/app" })).toBeNull();
  });
});

describe("remotePosition", () => {
  it("counts the steps of a handoff that creates its VM", () => {
    expect(remotePosition("handOff", [])).toBeNull();
    expect(remotePosition("handOff", ["connecting"])).toEqual({ position: 1, total: 7 });
    expect(remotePosition("handOff", ["connecting", "creatingVm", "waitingForVm"])).toEqual({ position: 3, total: 7 });
  });

  it("leaves out the steps an operation skipped", () => {
    expect(remotePosition("connect", ["connecting", "installingRuntime"])).toEqual({ position: 2, total: 3 });
    expect(remotePosition("retrieve", ["connecting", "installingRuntime", "stoppingAgent", "retrievingCode"])).toEqual({ position: 4, total: 4 });
  });

  it("does not move back when the handoff repeats the steps its preparation ran", () => {
    const prepared: RemoteStep[] = ["connecting", "startingVm", "waitingForVm", "installingRuntime"];
    expect(remotePosition("handOff", [...prepared, "connecting"])).toEqual({ position: 4, total: 7 });
    expect(remotePosition("handOff", [...prepared, "connecting", "installingRuntime", "transferringCode"])).toEqual({ position: 5, total: 7 });
  });

  it("ignores steps outside the operation's plan", () => {
    expect(remotePosition("connect", ["retrievingCode"])).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("shows minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_999)).toBe("1:05");
    expect(formatElapsed(754_000)).toBe("12:34");
  });
});

describe("moveStatus", () => {
  it("says what the session waits for until its move runs", () => {
    expect(moveStatus(createEmptyChat())).toBeNull();
    expect(moveStatus({ ...createEmptyChat(), move: "handOff", isBusy: true, remoteStep: "startingVm" })).toBe(
      "The session moves to the VM once the agent finished its turn.",
    );
    expect(moveStatus({ ...createEmptyChat(), move: "handOff", remoteStep: "installingRuntime" })).toBe("The session moves to the VM as soon as it is ready.");
    expect(moveStatus({ ...createEmptyChat(), move: "retrieve", isBusy: true })).toBe("The session comes back from the VM once the agent finished its turn.");
    expect(moveStatus({ ...createEmptyChat(), move: "handOff", isLoading: true, remoteStep: "transferringCode" })).toBeNull();
  });
});
