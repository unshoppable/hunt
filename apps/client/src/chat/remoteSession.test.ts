import { describe, expect, it } from "vitest";
import type { SessionView } from "../ipc/types";
import { createEmptyChat } from "../state/store";
import { handOffBlocker, retrieveBlocker } from "./remoteSession";

function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id,
    title: id,
    repoPath: "/repo",
    worktreePath: `/worktrees/${id}`,
    branch: id,
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
    expect(handOffBlocker(top, [top], createEmptyChat(), READY)).toBeNull();
  });

  it("keeps sub sessions, checkout sessions, reviews and parents of sub sessions local", () => {
    const top = session("top");
    const sub = session("sub", { parentId: "top" });
    expect(handOffBlocker(sub, [top, sub], undefined, READY)).toMatch(/parent/);
    expect(handOffBlocker(top, [top, sub], undefined, READY)).toMatch(/sub sessions/);
    expect(handOffBlocker(session("c", { workspace: "checkout" }), [], undefined, READY)).toMatch(/checkout/);
    expect(handOffBlocker(session("r", { pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } }), [], undefined, READY)).toMatch(/review/);
  });

  it("needs a Claude account, since the local login stays on this Mac", () => {
    const top = session("top");
    expect(handOffBlocker(top, [top], createEmptyChat(), { ...READY, hasClaudeAccount: false })).toMatch(/Claude account/);
  });

  it("waits for a running turn, queued prompts, a question of the agent and unsaved edits", () => {
    const top = session("top");
    expect(handOffBlocker(top, [top], { ...createEmptyChat(), isBusy: true }, READY)).toMatch(/turn/);
    expect(handOffBlocker(top, [top], { ...createEmptyChat(), queue: [{ id: "q", text: "next", images: [] }] }, READY)).toMatch(/queued/);
    expect(handOffBlocker(top, [top], createEmptyChat(), { ...READY, hasUnsavedEdits: true })).toMatch(/unsaved/);
  });
});

describe("retrieveBlocker", () => {
  const vm = { project: "p", zone: "z", instance: "vm-hunt-s-top00000" };
  const remote = {
    vm,
    worktreePath: "/home/agent/app",
    repo: "acme/app",
    branch: "top",
    handoffHead: "",
    handedOffAt: "2026-10-13T10:00:00Z",
    localMode: null,
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: null,
    origin: "handoff" as const,
    issue: null,
  };

  it("waits for the agent", () => {
    const handedOff = session("top", { remote });
    expect(retrieveBlocker(handedOff, createEmptyChat())).toBeNull();
    expect(retrieveBlocker(handedOff, { ...createEmptyChat(), isBusy: true })).toMatch(/turn/);
  });

  it("needs a local checkout for an adopted session", () => {
    const adopted = session("top", { repoPath: "", remote: { ...remote, origin: "swf", issue: 12 } });
    expect(retrieveBlocker(adopted, createEmptyChat())).toMatch(/local checkout of acme\/app/);
    expect(retrieveBlocker({ ...adopted, repoPath: "/src/app" }, createEmptyChat())).toBeNull();
  });
});
