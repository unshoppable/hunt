import { describe, expect, it } from "vitest";
import type { PullRequest } from "../ipc/types";
import { NO_PULL_REQUEST_FILTER, filterPullRequests, findPullRequestBranch, pullRequestAuthors } from "./pullRequests";

function pullRequest(number: number, title: string, author: string, headRefName: string, labels: string[] = []): PullRequest {
  return {
    number,
    title,
    author,
    authorAvatarUrl: "",
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
  pullRequest(261, "Export all reports", "alice", "fixes/csv-export"),
  pullRequest(258, "Feat/hyphens", "carol", "feat/hyphens", ["bug"]),
  pullRequest(12, "fix(ui): dropdown filters", "alice", "feature/ui/42-scope-filter"),
];

describe("filterPullRequests", () => {
  it("keeps everything for a blank query", () => {
    expect(filterPullRequests(pullRequests, "   ")).toBe(pullRequests);
  });

  it("matches the title case-insensitively", () => {
    expect(filterPullRequests(pullRequests, "REPORTS").map((pr) => pr.number)).toEqual([261]);
  });

  it("matches the number with and without the hash", () => {
    expect(filterPullRequests(pullRequests, "#258").map((pr) => pr.number)).toEqual([258]);
    expect(filterPullRequests(pullRequests, "12").map((pr) => pr.number)).toEqual([12]);
  });

  it("matches the author, the branch and a label, and requires every word", () => {
    expect(filterPullRequests(pullRequests, "alice").map((pr) => pr.number)).toEqual([261, 12]);
    expect(filterPullRequests(pullRequests, "alice ui").map((pr) => pr.number)).toEqual([12]);
    expect(filterPullRequests(pullRequests, "bug").map((pr) => pr.number)).toEqual([258]);
    expect(filterPullRequests(pullRequests, "alice hyphens")).toEqual([]);
  });

  it("keeps only the chosen author, combined with the query", () => {
    expect(filterPullRequests(pullRequests, "", { ...NO_PULL_REQUEST_FILTER, author: "carol" }).map((pr) => pr.number)).toEqual([258]);
    expect(filterPullRequests(pullRequests, "dropdown", { ...NO_PULL_REQUEST_FILTER, author: "alice" }).map((pr) => pr.number)).toEqual([12]);
    expect(filterPullRequests(pullRequests, "dropdown", { ...NO_PULL_REQUEST_FILTER, author: "carol" })).toEqual([]);
  });

  it("keeps only the chosen review state, `none` for pull requests the user has no part in", () => {
    const reviewed = [
      { ...pullRequests[0], viewerReview: "requested" as const },
      { ...pullRequests[1], viewerReview: "approved" as const },
      pullRequests[2],
    ];
    expect(filterPullRequests(reviewed, "", { ...NO_PULL_REQUEST_FILTER, review: "requested" }).map((pr) => pr.number)).toEqual([261]);
    expect(filterPullRequests(reviewed, "", { ...NO_PULL_REQUEST_FILTER, review: "none" }).map((pr) => pr.number)).toEqual([12]);
  });

  it("hides drafts on request", () => {
    const withDraft = [pullRequests[0], { ...pullRequests[1], isDraft: true }];
    expect(filterPullRequests(withDraft, "", { ...NO_PULL_REQUEST_FILTER, hidesDrafts: true }).map((pr) => pr.number)).toEqual([261]);
  });
});

describe("pullRequestAuthors", () => {
  it("lists each author once, sorted case-insensitively", () => {
    const listed = [...pullRequests, pullRequest(7, "Docs", "Bob", "docs")];
    expect(pullRequestAuthors(listed)).toEqual(["alice", "Bob", "carol"]);
  });
});

describe("findPullRequestBranch", () => {
  const branches = ["main", "feat/hyphens", "origin/main", "origin/feat/hyphens", "origin/fixes/csv-export", "fork/feature/ui/42-scope-filter"];

  it("prefers the local branch, then origin, then any remote", () => {
    expect(findPullRequestBranch(branches, "feat/hyphens")).toBe("feat/hyphens");
    expect(findPullRequestBranch(branches, "fixes/csv-export")).toBe("origin/fixes/csv-export");
    expect(findPullRequestBranch(branches, "feature/ui/42-scope-filter")).toBe("fork/feature/ui/42-scope-filter");
  });

  it("is null for a branch that was never fetched", () => {
    expect(findPullRequestBranch(branches, "feat/image-focus")).toBeNull();
  });
});
