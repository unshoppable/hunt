import { describe, expect, it } from "vitest";
import type { ReplyTarget, ReviewComment, ReviewThread, SessionView } from "../ipc/types";
import { draftCards, FILE_SPAN, isInsideHunk, isPostedOnDiff, reviewCommentCounts, reviewCommentsFor, reviewSessionOf, threadAnchorLine } from "./reviewComments";

function session(id: string, parentId: string | null, reviewComments: ReviewComment[] = []): SessionView {
  return {
    id,
    title: id,
    repoPath: "/repo",
    worktreePath: "/wt",
    branch: "b",
    baseRef: "main",
    baseCommit: "abc",
    acpSessionId: null,
    createdAt: "2026-10-11T10:00:00Z",
    isLive: false,
    parentId,
    selection: null,
    summary: [],
    touchedFiles: [],
    worktreeChangedAt: null,
    pullRequest: { number: 7, url: "https://github.com/o/r/pull/7" },
    diffBase: "merge-base",
    reviewComments,
    workspace: "worktree",
    keepsBranch: false,
    remote: null,
    leftoverVm: null,
    dependencies: null,
    hasLocalWorktree: true,
    pushTarget: "main",
  };
}

function comment(id: string, path: string, line: number, createdAt: string, replyTo: ReplyTarget | null = null): ReviewComment {
  return { id, path, startLine: line, line, body: `note ${id}`, createdAt, replyTo };
}

describe("reviewSessionOf", () => {
  it("resolves a sub session to its parent and a top-level session to itself", () => {
    const parent = session("parent", null);
    const child = session("child", "parent");
    expect(reviewSessionOf([parent, child], "child")).toBe(parent);
    expect(reviewSessionOf([parent, child], "parent")).toBe(parent);
    expect(reviewSessionOf([parent, child], "missing")).toBeNull();
  });

  it("falls back to the sub session itself while its parent is not listed", () => {
    const child = session("child", "parent");
    expect(reviewSessionOf([child], "child")).toBe(child);
  });
});

describe("reviewCommentsFor", () => {
  it("lists the parent's drafts of the path, oldest first", () => {
    const parent = session("parent", null, [
      comment("b", "src/a.ts", 5, "2026-10-11T10:02:00Z"),
      comment("a", "src/a.ts", 3, "2026-10-11T10:01:00Z"),
      comment("c", "src/other.ts", 1, "2026-10-11T10:00:00Z"),
    ]);
    const child = session("child", "parent");
    expect(reviewCommentsFor([parent, child], "child", "src/a.ts").map((draft) => draft.id)).toEqual(["a", "b"]);
    expect(reviewCommentsFor([parent, child], "child", "src/none.ts")).toEqual([]);
  });
});

describe("draftCards", () => {
  const root = comment("root", "src/a.ts", 3, "2026-10-11T10:00:00Z");
  const first = comment("first", "src/a.ts", 3, "2026-10-11T10:01:00Z", { kind: "draft", id: "root" });
  const onThread = comment("on-thread", "src/a.ts", 9, "2026-10-11T10:02:00Z", { kind: "thread", id: "T1" });
  const second = comment("second", "src/a.ts", 3, "2026-10-11T10:03:00Z", { kind: "draft", id: "root" });
  const onGoneThread = comment("on-gone-thread", "src/a.ts", 12, "2026-10-11T10:04:00Z", { kind: "thread", id: "T2" });
  const onGoneDraft = comment("on-gone-draft", "src/a.ts", 5, "2026-10-11T10:05:00Z", { kind: "draft", id: "deleted" });
  const drafts = [root, first, onThread, second, onGoneThread, onGoneDraft];

  it("groups replies under what they answer, oldest first, and orphans those whose thread or draft is gone", () => {
    const cards = draftCards(drafts, new Set(["T1"]));
    expect(cards.roots).toEqual([root]);
    expect(cards.replies).toEqual(new Map([["root", [first, second]], ["T1", [onThread]]]));
    expect(cards.orphans).toEqual([onGoneThread, onGoneDraft]);
  });

  it("orphans no reply to a thread while no load of the threads has ended", () => {
    const cards = draftCards(drafts, null);
    expect(cards.replies.get("T2")).toEqual([onGoneThread]);
    expect(cards.orphans).toEqual([onGoneDraft]);
  });
});

describe("reviewCommentCounts", () => {
  function thread(id: string, path: string, commentCount: number, isResolved = false): ReviewThread {
    const comments = Array.from({ length: commentCount }, (_, index) => ({
      id: `${id}-${index}`,
      author: "octocat",
      avatarUrl: "",
      body: "reply",
      createdAt: "2026-10-11T10:00:00Z",
      url: "https://github.com/o/r/pull/7",
    }));
    return { id, path, side: "right", startLine: 1, line: 1, isResolved, isOutdated: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false, comments };
  }

  it("adds the drafts of a path to every comment of its threads, resolved ones included", () => {
    const drafts = [comment("a", "src/a.ts", 3, "2026-10-11T10:01:00Z"), comment("b", "src/a.ts", 5, "2026-10-11T10:02:00Z")];
    const threads = [thread("t1", "src/a.ts", 2), thread("t2", "src/b.ts", 3, true)];
    expect(reviewCommentCounts(drafts, threads)).toEqual(new Map([["src/a.ts", 4], ["src/b.ts", 3]]));
    expect(reviewCommentCounts([], [])).toEqual(new Map());
  });
});

describe("isInsideHunk", () => {
  const blocks = [
    { original: { start: 10, end: 12 }, modified: { start: 10, end: 13 } },
    { original: { start: 40, end: 42 }, modified: { start: 41, end: 41 } },
  ];

  it("covers the changed lines and three context lines on either side", () => {
    expect(isInsideHunk(blocks, 7, 7)).toBe(true);
    expect(isInsideHunk(blocks, 6, 6)).toBe(false);
    expect(isInsideHunk(blocks, 15, 15)).toBe(true);
    expect(isInsideHunk(blocks, 16, 16)).toBe(false);
  });

  it("surrounds a deletion with context around the line it sits before", () => {
    expect(isInsideHunk(blocks, 38, 38)).toBe(true);
    expect(isInsideHunk(blocks, 43, 43)).toBe(true);
    expect(isInsideHunk(blocks, 37, 37)).toBe(false);
    expect(isInsideHunk(blocks, 44, 44)).toBe(false);
  });

  it("requires the whole span to lie in one hunk", () => {
    expect(isInsideHunk(blocks, 7, 15)).toBe(true);
    expect(isInsideHunk(blocks, 7, 16)).toBe(false);
    expect(isInsideHunk([], 1, 1)).toBe(false);
  });
});

describe("isPostedOnDiff", () => {
  const blocks = [{ original: { start: 1, end: 3 }, modified: { start: 1, end: 4 } }];

  it("posts a file comment on a changed file and turns one on an unchanged file into a note", () => {
    expect(isPostedOnDiff(blocks, FILE_SPAN)).toBe(true);
    expect(isPostedOnDiff([], FILE_SPAN)).toBe(false);
  });

  it("posts a line comment only inside a hunk, even near the top of the file", () => {
    expect(isPostedOnDiff(blocks, { startLine: 2, line: 6 })).toBe(true);
    expect(isPostedOnDiff(blocks, { startLine: 7, line: 7 })).toBe(false);
  });
});

describe("threadAnchorLine", () => {
  // Base lines 5–6 became new lines 5–7, base lines 10–11 were deleted (new line 11 follows new line 10).
  const blocks = [
    { original: { start: 5, end: 7 }, modified: { start: 5, end: 8 } },
    { original: { start: 10, end: 12 }, modified: { start: 11, end: 11 } },
  ];

  it("keeps the line of a thread on the new version and the 0 of a file thread", () => {
    expect(threadAnchorLine(blocks, { side: "right", line: 9 })).toBe(9);
    expect(threadAnchorLine(blocks, { side: "left", line: 0 })).toBe(0);
  });

  it("puts a thread on replaced or deleted base lines under the last new line of its block", () => {
    expect(threadAnchorLine(blocks, { side: "left", line: 6 })).toBe(7);
    expect(threadAnchorLine(blocks, { side: "left", line: 10 })).toBe(10);
    expect(threadAnchorLine(blocks, { side: "left", line: 11 })).toBe(10);
  });

  it("moves a thread on an unchanged base line by the lines the blocks before it added or removed", () => {
    expect(threadAnchorLine(blocks, { side: "left", line: 2 })).toBe(2);
    expect(threadAnchorLine(blocks, { side: "left", line: 8 })).toBe(9);
    expect(threadAnchorLine(blocks, { side: "left", line: 12 })).toBe(11);
  });
});
