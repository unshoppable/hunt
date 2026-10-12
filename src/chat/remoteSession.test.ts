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
    branch: `hunt/${id}`,
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
  it("waits for the agent only", () => {
    expect(retrieveBlocker(createEmptyChat())).toBeNull();
    expect(retrieveBlocker({ ...createEmptyChat(), isBusy: true })).toMatch(/turn/);
  });
});
