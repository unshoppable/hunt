import { describe, expect, it } from "vitest";
import type { RemoteStep, SessionView } from "../ipc/types";
import { createEmptyChat } from "../state/store";
import { fileSyncLabel, formatElapsed, handOffBlocker, hasBusySubChat, moveStatus, remoteOf, remotePosition, retrieveBlocker } from "./remoteSession";

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
    hasLocalWorktree: true,
    ...patch,
  };
}

/** Nothing unsaved, a Claude account selected and no sub chat running a turn. */
const READY = { hasUnsavedEdits: false, hasClaudeAccount: true, hasBusySubChat: false };

describe("handOffBlocker", () => {
  it("lets an idle top-level session in its own worktree go, with its sub chats", () => {
    expect(handOffBlocker(session("top"), READY)).toBeNull();
  });

  it("keeps sub sessions, checkout sessions and reviews local", () => {
    expect(handOffBlocker(session("sub", { parentId: "top" }), READY)).toMatch(/parent/);
    expect(handOffBlocker(session("c", { workspace: "checkout" }), READY)).toMatch(/checkout/);
    expect(handOffBlocker(session("r", { pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }), READY)).toMatch(/review/);
  });

  it("needs a Claude account, since the local login stays on this Mac", () => {
    expect(handOffBlocker(session("top"), { ...READY, hasClaudeAccount: false })).toMatch(/Claude account/);
  });

  it("waits for unsaved edits in the editor", () => {
    expect(handOffBlocker(session("top"), { ...READY, hasUnsavedEdits: true })).toMatch(/unsaved/);
  });

  it("waits until no sub chat runs a turn, since moving stops their agents", () => {
    expect(handOffBlocker(session("top"), { ...READY, hasBusySubChat: true })).toMatch(/sub chats finished/);
  });
});

/** A session handed off to its VM. */
const remote = {
  vm: { project: "p", zone: "z", instance: "vm-hunt-s-top00000" },
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
  agent: "",
};

describe("remoteOf", () => {
  it("is the session's own VM, or its parent's for a sub chat", () => {
    const top = session("top", { remote });
    const sub = session("sub", { parentId: "top" });
    expect(remoteOf(top, [top, sub])).toBe(remote);
    expect(remoteOf(sub, [top, sub])).toBe(remote);
  });

  it("is null for a local session, a sub chat of a local session and one whose parent is not listed", () => {
    const top = session("top");
    const sub = session("sub", { parentId: "top" });
    expect(remoteOf(top, [top, sub])).toBeNull();
    expect(remoteOf(sub, [top, sub])).toBeNull();
    expect(remoteOf(sub, [sub])).toBeNull();
  });
});

describe("hasBusySubChat", () => {
  it("looks at the session's own sub chats only", () => {
    const top = session("top");
    const sessions = [top, session("sub", { parentId: "top" }), session("other"), session("otherSub", { parentId: "other" })];
    expect(hasBusySubChat(top, sessions, new Set(["sub"]))).toBe(true);
    expect(hasBusySubChat(top, sessions, new Set(["top", "otherSub"]))).toBe(false);
  });
});

describe("retrieveBlocker", () => {
  const saved = { hasUnsavedEdits: false, hasBusySubChat: false };

  it("lets a session with a local checkout come back once the editor saved its edits", () => {
    expect(retrieveBlocker(session("top", { remote }), saved)).toBeNull();
    expect(retrieveBlocker(session("top", { remote }), { ...saved, hasUnsavedEdits: true })).toMatch(/unsaved edits/);
  });

  it("waits until no sub chat runs a turn, since their relays stop with the session's", () => {
    expect(retrieveBlocker(session("top", { remote }), { ...saved, hasBusySubChat: true })).toMatch(/sub chats finished/);
  });

  it("needs a local checkout for an adopted session", () => {
    const adopted = session("top", { repoPath: "", remote: { ...remote, origin: "swf", issue: 12 } });
    expect(retrieveBlocker(adopted, saved)).toMatch(/local checkout of acme\/app/);
    expect(retrieveBlocker({ ...adopted, repoPath: "/src/app" }, saved)).toBeNull();
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

  it("counts a VM start that moves the VM to another zone as one step", () => {
    expect(remotePosition("connect", ["connecting", "startingVm", "movingVm"])).toEqual({ position: 2, total: 5 });
    expect(remotePosition("connect", ["connecting", "startingVm", "movingVm", "waitingForVm"])).toEqual({ position: 3, total: 5 });
    expect(remotePosition("retrieve", ["connecting", "startingVm", "movingVm", "waitingForVm"])).toEqual({ position: 3, total: 6 });
    expect(remotePosition("handOff", ["connecting", "startingVm", "movingVm", "waitingForVm"])).toEqual({ position: 3, total: 7 });
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

describe("fileSyncLabel", () => {
  const time = (iso: string) => iso.slice(11, 16);
  const idle = { isRunning: false, syncedAt: null, error: null, conflicts: [] };

  it("shows a running sync only once it ran for a moment", () => {
    const running = { ...idle, isRunning: true, syncedAt: "2026-10-14T10:05:00Z" };
    expect(fileSyncLabel(running, false, time)).toBe("Synced 10:05");
    expect(fileSyncLabel(running, true, time)).toBe("Syncing…");
  });

  it("names a failure before the last success and nothing before the first sync", () => {
    const failed = { ...idle, syncedAt: "2026-10-14T10:05:00Z", error: "failed to list the files on the VM" };
    expect(fileSyncLabel(failed, false, time)).toBe("Sync failed");
    expect(fileSyncLabel({ ...idle, syncedAt: "2026-10-14T10:05:00Z" }, false, time)).toBe("Synced 10:05");
    expect(fileSyncLabel({ ...idle, syncedAt: "2026-10-14T10:05:00Z", conflicts: ["src: a folder here"] }, false, time)).toBe("1 file not synced");
    expect(fileSyncLabel(idle, false, time)).toBeNull();
  });
});
