import { describe, expect, it } from "vitest";
import type { PullRequestDetails, PullRequestReview, ReviewThread } from "../review/review.types";
import { pullRequestState } from "./pull-request-commands.utils";

function review(author: string, state: string): PullRequestReview {
  return { author, body: "", state, submittedAt: "2026-11-01T10:00:00Z" };
}

function thread(id: string, isResolved: boolean): ReviewThread {
  return {
    id,
    path: "src/app.ts",
    side: "right",
    startLine: 1,
    line: 1,
    isResolved,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [],
  };
}

const DETAILS: PullRequestDetails = {
  number: 42,
  title: "feat(client): read tabs",
  body: "Long description",
  author: "ada",
  url: "https://github.com/unshoppable/hunt/pull/42",
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-11-01T09:00:00Z",
  headRefName: "feat/general/tabs",
  baseRefName: "master",
  comments: [{ author: "bob", body: "Nice", createdAt: "2026-11-01T09:30:00Z", url: "", isMinimized: false }],
  reviews: [review("bob", "CHANGES_REQUESTED"), review("carol", "COMMENTED"), review("bob", "APPROVED")],
};

describe("pullRequestState", () => {
  it("summarizes the pull request with each reviewer's latest verdict, the drafts and the threads", () => {
    const threads = { threads: [thread("t1", true), thread("t2", false), thread("t3", false)], error: null, loadedAt: 1 };
    expect(pullRequestState(DETAILS, 2, threads)).toEqual({
      number: 42,
      title: "feat(client): read tabs",
      state: "OPEN",
      isDraft: false,
      author: "ada",
      base: "master",
      head: "feat/general/tabs",
      url: "https://github.com/unshoppable/hunt/pull/42",
      verdicts: [{ author: "bob", state: "APPROVED" }],
      commentCount: 1,
      reviewCount: 3,
      draftCount: 2,
      threads: { resolved: 1, unresolved: 2, error: null },
    });
  });

  it("has no thread counts before a load and keeps a load's error", () => {
    expect(pullRequestState(DETAILS, 0, undefined).threads).toBeNull();
    expect(pullRequestState(DETAILS, 0, { threads: [], error: "gh failed", loadedAt: 1 }).threads).toEqual({ resolved: 0, unresolved: 0, error: "gh failed" });
  });
});
