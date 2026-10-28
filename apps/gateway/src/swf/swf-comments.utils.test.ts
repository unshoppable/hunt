import { describe, expect, it } from "vitest";
import { changeRequestFinding, failureComment, humanReviewComment, missingPullRequestComment, missingSkillsError, noPullRequestComment } from "./swf-comments.utils.ts";

describe("issue comments", () => {
  it("reports a failure in a code block and names the VM that stays", () => {
    expect(failureComment("hunt-ctl: ``` broken", "vm-hunt-s-ab12cd34")).toBe(
      "Hunt could not start a session for this issue:\n\n```\nhunt-ctl: `` broken\n```\n\nThe VM `vm-hunt-s-ab12cd34` stays for inspection.",
    );
    expect(failureComment("quota exceeded", null)).not.toContain("stays");
  });

  it("names the agent steps hunt.json names no skill for", () => {
    expect(missingSkillsError(["gate"])).toBe(
      "hunt.json names no skill for the step gate under swf.skills; Hunt has no default skill and asks to add the entries when a session of the repository opens",
    );
    expect(missingSkillsError(["plan", "implement", "verify", "gate", "pr"])).toContain("no skill for the steps plan, implement, verify, gate, pr under swf.skills;");
  });
});

describe("humanReviewComment", () => {
  it("mentions the people and names the reasons", () => {
    const text = humanReviewComment(["alice", "bob"], 12, ["touches migrations"]);
    expect(text).toContain("@alice @bob");
    expect(text).toContain("#12");
    expect(text).toContain("- touches migrations");
    expect(humanReviewComment([], 12)).not.toContain("Why a person");
  });
});

describe("pull request comments and findings", () => {
  it("marks an issue as failed without a pull request and turns a change request into one finding without its empty body", () => {
    expect(noPullRequestComment()).toBe("Hunt reached the review without a pull request number, so this issue is marked as failed.");
    expect(missingPullRequestComment(31)).toBe("Pull request #31 does not exist (any more), so this issue is marked as failed.");
    const review = { id: 7, author: "carol", state: "CHANGES_REQUESTED", body: "  \n", submittedAt: "2026-10-13T10:00:00Z" };
    const finding = changeRequestFinding(31, review, ["db/0007.sql:3: Use a partial index."]);
    expect(finding).toBe("@carol requested changes on #31:\ndb/0007.sql:3: Use a partial index.");
  });
});
