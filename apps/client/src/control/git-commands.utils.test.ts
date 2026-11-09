import { describe, expect, it } from "vitest";
import type { Commit, GitRef } from "../git/git.types";
import { commitEntry, commitsStartingWith, describeLogFilter, logEntry, refsSummary } from "./git-commands.utils";

function commit(id: string): Commit {
  return { id, parents: [], author: "Ada", authorEmail: "ada@example.com", authoredAt: "2026-11-01T10:00:00Z", subject: `subject of ${id}`, refs: [] };
}

function ref(name: string, patch: Partial<GitRef> = {}): GitRef {
  return { name, kind: "local", target: "abc", upstream: null, ahead: 0, behind: 0, worktreePath: null, author: "", authorEmail: "", ...patch };
}

describe("commitsStartingWith", () => {
  const commits = [commit("abc123"), commit("abd456"), commit("ffe789")];

  it("finds the commits whose hash starts with the given one, in any case", () => {
    expect(commitsStartingWith(commits, "ABC")).toStrictEqual([commits[0]]);
    expect(commitsStartingWith(commits, "ab")).toStrictEqual([commits[0], commits[1]]);
    expect(commitsStartingWith(commits, "123")).toStrictEqual([]);
  });
});

describe("refsSummary", () => {
  it("lists local branches with upstream and distance, remote branches and tags by name, and counts the unpushed commits", () => {
    const refs = [
      ref("master", { upstream: "origin/master", ahead: 2, behind: 1, worktreePath: "/repo" }),
      ref("feature"),
      ref("origin/master", { kind: "remote" }),
      ref("v1.0", { kind: "tag" }),
    ];

    expect(refsSummary({ head: "master", refs, unpushed: ["a", "b"] })).toStrictEqual({
      local: [
        { name: "master", upstream: "origin/master", ahead: 2, behind: 1, isCheckedOut: true },
        { name: "feature", upstream: null, ahead: 0, behind: 0, isCheckedOut: false },
      ],
      remote: ["origin/master"],
      tags: ["v1.0"],
      unpushed: 2,
    });
  });
});

describe("logEntry and commitEntry", () => {
  it("name a commit by its sha", () => {
    expect(logEntry(commit("abc"))).toStrictEqual({ sha: "abc", subject: "subject of abc", author: "Ada", date: "2026-11-01T10:00:00Z" });
    const details = { id: "abc", message: "m", committer: "Ada", committedAt: "2026-11-01T10:00:00Z", files: [{ path: "a.ts", status: "M", oldPath: null }], branches: ["master"] };
    expect(commitEntry(details)).toStrictEqual({ sha: "abc", message: "m", committer: "Ada", committedAt: "2026-11-01T10:00:00Z", files: details.files, branches: ["master"] });
  });
});

describe("describeLogFilter", () => {
  it("names the history and the text", () => {
    expect(describeLogFilter({ reference: "master", text: "" })).toBe("the history of master");
    expect(describeLogFilter({ reference: "", text: "fix" })).toBe('the history of every branch and tag matching "fix"');
  });
});
