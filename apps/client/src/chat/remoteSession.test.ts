import { describe, expect, it } from "vitest";
import type { SessionView } from "../ipc/types";
import { createEmptyChat } from "../state/store";
import { handOffBlocker, moveStatus, retrieveBlocker } from "./remoteSession";

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

describe("moveStatus", () => {
  it("says what the session waits for until its move runs", () => {
    expect(moveStatus(createEmptyChat())).toBeNull();
    expect(moveStatus({ ...createEmptyChat(), move: "handOff", isBusy: true, remoteStep: "startingVm" })).toBe(
      "Starting the VM… The session moves to the VM once the agent finished its turn.",
    );
    expect(moveStatus({ ...createEmptyChat(), move: "handOff", remoteStep: "installingRuntime" })).toMatch(/^Installing Hunt.* as soon as it is ready\.$/);
    expect(moveStatus({ ...createEmptyChat(), move: "retrieve", isBusy: true })).toBe("The session comes back from the VM once the agent finished its turn.");
    expect(moveStatus({ ...createEmptyChat(), move: "handOff", isLoading: true, remoteStep: "transferringCode" })).toBeNull();
  });
});
