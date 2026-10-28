import { describe, expect, it } from "vitest";
import type { PullRequestComment, PullRequestReview } from "./review.types";
import { buildTimeline } from "./timeline.utils";

function comment(body: string, createdAt: string, isMinimized = false): PullRequestComment {
  return { author: "alice", body, createdAt, url: "https://github.com/o/r/pull/1#issuecomment-1", isMinimized };
}

function review(state: string, submittedAt: string, body = ""): PullRequestReview {
  return { author: "bob", body, state, submittedAt };
}

describe("buildTimeline", () => {
  it("interleaves comments and reviews oldest first", () => {
    const entries = buildTimeline({
      comments: [comment("later", "2026-10-09T12:00:00Z"), comment("first", "2026-10-09T10:00:00Z")],
      reviews: [review("APPROVED", "2026-10-09T11:00:00Z")],
    });
    expect(entries.map((entry) => (entry.kind === "comment" ? entry.comment.body : entry.review.state))).toEqual(["first", "APPROVED", "later"]);
  });

  it("drops minimized comments but keeps reviews without text", () => {
    const entries = buildTimeline({ comments: [comment("spam", "2026-10-09T10:00:00Z", true)], reviews: [review("COMMENTED", "2026-10-09T11:00:00Z")] });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("review");
  });
});
