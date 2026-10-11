import { describe, expect, it } from "vitest";
import type { PullRequest } from "../ipc/types";
import { filterPullRequests, findPullRequestBranch } from "./pullRequests";

function pullRequest(number: number, title: string, author: string, headRefName: string, labels: string[] = []): PullRequest {
  return {
    number,
    title,
    author,
    headRefName,
    baseRefName: "main",
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    url: `https://github.com/o/r/pull/${number}`,
    reviewDecision: null,
    viewerReview: null,
    commentCount: 0,
    checks: null,
    tasks: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    labels: labels.map((name) => ({ name, color: "d73a4a" })),
  };
}

const pullRequests = [
  pullRequest(261, "Export all participants", "hido", "fixes/christmas-2025"),
  pullRequest(258, "Feat/hyphens", "yannick", "feat/hyphens", ["bug"]),
  pullRequest(12, "fix(med): dropdown filters", "hido", "feature/med/623-scope-filter"),
];

describe("filterPullRequests", () => {
  it("keeps everything for a blank query", () => {
    expect(filterPullRequests(pullRequests, "   ")).toBe(pullRequests);
  });

  it("matches the title case-insensitively", () => {
    expect(filterPullRequests(pullRequests, "PARTICIPANTS").map((pr) => pr.number)).toEqual([261]);
  });

  it("matches the number with and without the hash", () => {
    expect(filterPullRequests(pullRequests, "#258").map((pr) => pr.number)).toEqual([258]);
    expect(filterPullRequests(pullRequests, "12").map((pr) => pr.number)).toEqual([12]);
  });

  it("matches the author, the branch and a label, and requires every word", () => {
    expect(filterPullRequests(pullRequests, "hido").map((pr) => pr.number)).toEqual([261, 12]);
    expect(filterPullRequests(pullRequests, "hido med").map((pr) => pr.number)).toEqual([12]);
    expect(filterPullRequests(pullRequests, "bug").map((pr) => pr.number)).toEqual([258]);
    expect(filterPullRequests(pullRequests, "hido hyphens")).toEqual([]);
  });
});

describe("findPullRequestBranch", () => {
  const branches = ["main", "feat/hyphens", "origin/main", "origin/feat/hyphens", "origin/fixes/christmas-2025", "fork/feature/med/623-scope-filter"];

  it("prefers the local branch, then origin, then any remote", () => {
    expect(findPullRequestBranch(branches, "feat/hyphens")).toBe("feat/hyphens");
    expect(findPullRequestBranch(branches, "fixes/christmas-2025")).toBe("origin/fixes/christmas-2025");
    expect(findPullRequestBranch(branches, "feature/med/623-scope-filter")).toBe("fork/feature/med/623-scope-filter");
  });

  it("is null for a branch that was never fetched", () => {
    expect(findPullRequestBranch(branches, "feat/image-focus")).toBeNull();
  });
});
