import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SessionView } from "./session.types";

export const SESSION = "11111111-1111-1111-1111-111111111111";

/** Payloads recorded from claude-agent-acp 0.89.1 over the wire. */
export function notification(update: Record<string, unknown>): SessionNotification {
  return { sessionId: "acp-session", update } as unknown as SessionNotification;
}

/** A stored top-level session as the backend lists it. */
export function storedSession(id: string, title: string): SessionView {
  return {
    id,
    title,
    repoPath: "/repo",
    worktreePath: `/worktrees/${id}`,
    branch: `feat/general/${title}`,
    baseRef: "main",
    baseCommit: "abc123",
    acpSessionId: "acp-session",
    createdAt: "2026-10-11T10:00:00Z",
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
    pushTarget: "main",
  };
}

export const TARGET = { repoPath: "/repo", baseRef: "main", workspace: "worktree" as const, pullRequest: null, diffBaseRef: null, pullRequestBranch: null, newBranch: null };
export const START = { setup: { configValues: { model: "fable", effort: "high" }, modeId: "plan" }, prompt: { text: "build it", images: [] } };
