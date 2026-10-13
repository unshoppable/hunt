import { describe, expect, it } from "vitest";
import type { SelectionContext, SessionView } from "../ipc/types";
import { selectionChatsFor } from "./selectionChats";

function session(id: string, worktreePath: string, parentId: string | null, selection: SelectionContext | null): SessionView {
  return { id, title: id, repoPath: "", worktreePath, branch: "", baseRef: "", baseCommit: "", acpSessionId: null, createdAt: "", isLive: true, parentId, selection, summary: [], touchedFiles: [], worktreeChangedAt: null, pullRequest: null, diffBase: null, reviewComments: [], workspace: "worktree", remote: null, leftoverVm: null, dependencies: null };
}

const selection: SelectionContext = { path: "src/a.ts", startLine: 16, endLine: 19, text: "code" };

describe("selectionChatsFor", () => {
  const sessions = [
    session("sub", "/wt/a", "parent", selection),
    session("other-file", "/wt/a", "parent", { ...selection, path: "src/b.ts" }),
    session("other-worktree", "/wt/b", "x", selection),
    session("parent", "/wt/a", null, null),
  ];

  it("collects the sub chats of the worktree opened from the file, seen from the parent", () => {
    expect(selectionChatsFor(sessions, "parent", "src/a.ts")).toEqual([{ sessionId: "sub", selection }]);
  });

  it("shows the same sub chats from a sub session of the worktree, including itself", () => {
    expect(selectionChatsFor(sessions, "other-file", "src/a.ts")).toEqual([{ sessionId: "sub", selection }]);
    expect(selectionChatsFor(sessions, "sub", "src/a.ts")).toEqual([{ sessionId: "sub", selection }]);
  });

  it("keeps the first (newest) sub chat per start line", () => {
    const stacked = [session("newest", "/wt/a", "parent", selection), session("older", "/wt/a", "parent", { ...selection, endLine: 30 }), session("elsewhere", "/wt/a", "parent", { ...selection, startLine: 40 })];
    expect(selectionChatsFor(stacked, "newest", "src/a.ts").map((chat) => chat.sessionId)).toEqual(["newest", "elsewhere"]);
  });

  it("has no chats for an unknown session", () => {
    expect(selectionChatsFor(sessions, "missing", "src/a.ts")).toEqual([]);
  });
});
