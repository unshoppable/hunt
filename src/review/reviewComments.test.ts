import { describe, expect, it } from "vitest";
import type { ReviewComment, SessionView } from "../ipc/types";
import { isInsideHunk, reviewCommentsFor, reviewSessionOf } from "./reviewComments";

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
  };
}

function comment(id: string, path: string, line: number, createdAt: string): ReviewComment {
  return { id, path, startLine: line, line, body: `note ${id}`, createdAt };
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
