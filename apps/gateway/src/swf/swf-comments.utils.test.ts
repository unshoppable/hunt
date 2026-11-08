import { describe, expect, it } from "vitest";
import { changeRequestFinding, failureComment, humanReviewComment, missingPullRequestComment, noPullRequestComment, replacedVmComment, stepSettingsError } from "./swf-comments.utils.ts";

describe("issue comments", () => {
  it("reports a failure in a code block and names the VM that stays", () => {
    expect(failureComment("hunt-ctl: ``` broken", "vm-hunt-s-ab12cd34")).toBe(
      "Hunt could not start a session for this issue:\n\n```\nhunt-ctl: `` broken\n```\n\nThe VM `vm-hunt-s-ab12cd34` stays for inspection.",
    );
    expect(failureComment("quota exceeded", null)).not.toContain("stays");
  });

  it("names the VM that replaces the lost one and the step that starts over", () => {
    expect(replacedVmComment("implement", "vm-hunt-s-ab12cd34")).toBe(
      "Hunt found no VM for this issue any more and replaced it with `vm-hunt-s-ab12cd34`; the step `implement` starts over there with what the steps before it left on the issue.",
    );
  });

  it("says why the step settings stop the start and where hunt.json names the skills", () => {
    expect(stepSettingsError("the step settings name no skill for the step review")).toBe(
      "Hunt cannot start: the step settings name no skill for the step review. hunt.json's `swf.steps.<step>.skill` (or `swf.skills.<step>`) names the skill " +
        "of every agent step; Hunt's desktop asks to add the missing ones when a session of the repository opens.",
    );
  });
});

describe("humanReviewComment", () => {
  it("mentions the people and points them to the review workflow's comment on the pull request", () => {
    expect(humanReviewComment(["alice", "bob"], 12)).toBe(
      "**👀 REVIEW** @alice @bob\n\nThe repository's review workflow asks for a human review of this pull request for #12 before Hunt merges it; its comment on the pull request says why. " +
        "Approve it to let Hunt merge it, or request changes and Hunt's agent will work them in.",
    );
    expect(humanReviewComment([], 12)).toContain("**👀 REVIEW** \n\n");
  });
});

describe("pull request comments and findings", () => {
  it("marks an issue as failed without a pull request and turns a change request into one finding without its empty body", () => {
    expect(noPullRequestComment()).toBe("Hunt reached the review of the pull request without a pull request number, so this issue is marked as failed.");
    expect(missingPullRequestComment(31)).toBe("Pull request #31 does not exist (any more), so this issue is marked as failed.");
    const review = { id: 7, author: "carol", state: "CHANGES_REQUESTED", body: "  \n", submittedAt: "2026-10-13T10:00:00Z" };
    const finding = changeRequestFinding(31, review, ["db/0007.sql:3: Use a partial index."]);
    expect(finding).toBe("@carol requested changes on #31:\ndb/0007.sql:3: Use a partial index.");
  });
});
