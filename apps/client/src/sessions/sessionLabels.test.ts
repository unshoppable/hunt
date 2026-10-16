import { describe, expect, it } from "vitest";
import type { SessionView } from "../ipc/types";
import { cycleSessionId, filterSessionRows, groupSessions, latestTopLevelSession, sessionMarks, sessionReference, sidebarTitle, titleFromPrompt } from "./sessionLabels";

function session(id: string, title: string, branch: string, parentId: string | null = null, path?: string): SessionView {
  return {
    id,
    title,
    repoPath: "/repo",
    worktreePath: `/repo/${id}`,
    branch,
    baseRef: "main",
    baseCommit: "abc",
    acpSessionId: null,
    createdAt: "2026-10-11T00:00:00Z",
    isLive: false,
    parentId,
    selection: path ? { path, startLine: 1, endLine: 1, text: "" } : null,
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
  };
}

const sessions = [
  session("a", "Fix the login form", "feat/login"),
  session("a1", "Validate the email", "feat/login", "a", "src/auth/email.ts"),
  session("a2", "Password rules", "feat/login", "a", "src/auth/password.ts"),
  session("b", "Analyse the repo", "feat/analysis"),
  session("orphan", "Lost child", "feat/x", "gone"),
];

const ids = (rows: ReturnType<typeof groupSessions>) => rows.map(({ session, isSubChat }) => `${isSubChat ? "  " : ""}${session.id}`);

describe("sessionReference", () => {
  it("names the pull request a session reviews, else the issue of a swf session", () => {
    const review = { ...session("r", "Review", "feat/x"), pullRequest: { number: 1465, url: "https://github.com/o/r/pull/1465" } };
    expect(sessionReference(review)).toEqual({ kind: "pullRequest", label: "#1465", title: "Reviews pull request https://github.com/o/r/pull/1465", tone: "neutral" });
    const swf = session("s", "Issue", "feat/x");
    swf.remote = { origin: "swf", issue: 687, repo: "o/r", vm: { project: "p", zone: "z", instance: "vm-1" } } as SessionView["remote"];
    expect(sessionReference(swf)).toMatchObject({ kind: "issue", label: "#687", tone: "amber" });
    expect(sessionReference(sessions[0])).toBeNull();
  });

  it("colours a pull request by its state like GitHub", () => {
    const review = { ...session("r", "Review", "feat/x"), pullRequest: { number: 1, url: "https://github.com/o/r/pull/1" } };
    expect(sessionReference(review, { state: "OPEN", isDraft: false })).toMatchObject({ tone: "green", title: "Reviews pull request https://github.com/o/r/pull/1 (open)" });
    expect(sessionReference(review, { state: "OPEN", isDraft: true })).toMatchObject({ tone: "grey" });
    expect(sessionReference(review, { state: "MERGED", isDraft: false })).toMatchObject({ tone: "purple" });
    expect(sessionReference(review, { state: "CLOSED", isDraft: false })).toMatchObject({ tone: "red" });
  });
});

describe("sidebarTitle", () => {
  it("drops the pull request number an older session's title starts with", () => {
    const pullRequest = { number: 1465, url: "https://github.com/o/r/pull/1465" };
    expect(sidebarTitle({ ...session("r", "#1465 feat: compress images", "feat/x"), pullRequest })).toBe("feat: compress images");
    expect(sidebarTitle({ ...session("r", "feat: compress images", "feat/x"), pullRequest })).toBe("feat: compress images");
    expect(sidebarTitle(session("r", "#1465 not a review", "feat/x"))).toBe("#1465 not a review");
  });
});

describe("groupSessions", () => {
  it("lists each top-level session followed by its sub chats and orphans on top level", () => {
    expect(ids(groupSessions(sessions))).toEqual(["a", "  a1", "  a2", "b", "orphan"]);
  });
});

describe("filterSessionRows", () => {
  const rows = groupSessions(sessions);

  it("keeps everything for a blank query", () => {
    expect(filterSessionRows(rows, "   ")).toBe(rows);
  });

  it("keeps a matching top-level session with all its sub chats", () => {
    expect(ids(filterSessionRows(rows, "LOGIN form"))).toEqual(["a", "  a1", "  a2"]);
  });

  it("keeps the parent of a matching sub chat but drops its other sub chats", () => {
    expect(ids(filterSessionRows(rows, "password"))).toEqual(["a", "  a2"]);
  });

  it("matches the branch and the sub chat file name", () => {
    expect(ids(filterSessionRows(rows, "feat/analysis"))).toEqual(["b"]);
    expect(ids(filterSessionRows(rows, "email.ts"))).toEqual(["a", "  a1"]);
  });

  it("requires every word to match", () => {
    expect(ids(filterSessionRows(rows, "login repo"))).toEqual([]);
  });
});

describe("titleFromPrompt", () => {
  it("uses the first non-empty line and shortens it with an ellipsis", () => {
    expect(titleFromPrompt("\n  hello world \nsecond")).toBe("hello world");
    expect(titleFromPrompt("x".repeat(60))).toBe(`${"x".repeat(47)}…`);
  });
});

describe("sessionMarks", () => {
  it("letters top-level sessions and numbers sub sessions per parent", () => {
    const marks = sessionMarks(sessions);
    expect(Object.fromEntries(marks)).toEqual({ a: "A", a1: "1", a2: "2", b: "B", orphan: "C" });
  });

  it("renumbers after a deletion", () => {
    const marks = sessionMarks(sessions.filter((candidate) => candidate.id !== "a1" && candidate.id !== "b"));
    expect(Object.fromEntries(marks)).toEqual({ a: "A", a2: "1", orphan: "B" });
  });

  it("continues past Z with two letters", () => {
    const many = Array.from({ length: 28 }, (_, index) => session(`s${index}`, "t", "b"));
    const marks = sessionMarks(many);
    expect([marks.get("s25"), marks.get("s26"), marks.get("s27")]).toEqual(["Z", "AA", "AB"]);
  });
});

describe("latestTopLevelSession", () => {
  it("returns the last top-level session, skipping sub chats and orphans with a parent id", () => {
    expect(latestTopLevelSession(sessions)?.id).toBe("b");
    expect(latestTopLevelSession([sessions[0], sessions[1]])?.id).toBe("a");
    expect(latestTopLevelSession([])).toBeNull();
  });
});

describe("cycleSessionId", () => {
  const rows = groupSessions(sessions);

  it("steps through the rows in sidebar order and wraps around", () => {
    expect(cycleSessionId(rows, "a2", 1)).toBe("b");
    expect(cycleSessionId(rows, "orphan", 1)).toBe("a");
    expect(cycleSessionId(rows, "a", -1)).toBe("orphan");
  });

  it("starts at the first or last row without an active row", () => {
    expect(cycleSessionId(rows, null, 1)).toBe("a");
    expect(cycleSessionId(rows, "hidden", -1)).toBe("orphan");
    expect(cycleSessionId([], null, 1)).toBeNull();
  });
});
