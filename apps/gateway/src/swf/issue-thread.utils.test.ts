import { describe, expect, it } from "vitest";
import type { Issue, IssueComment } from "./github.client.ts";
import { mentionsOf, newAnswers, newStepResults } from "./issue-thread.utils.ts";
import { Pipeline } from "./pipeline.domain.ts";
import { SKILLS } from "./swf.fixtures.ts";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  const url = `https://github.com/acme/app/issues/${number}`;
  return { number, title, body: `Body of ${number}`, author: "alice", createdAt: "2026-10-13T08:00:00Z", url, labels, state: "open", assignees: [] };
}

describe("newAnswers", () => {
  const bot = "hunt-claude[bot]";
  const thread: IssueComment[] = [
    { id: 1, author: bot, createdAt: "2026-10-13T08:05:00Z", body: Pipeline.start([], SKILLS).toComment() },
    { id: 2, author: "alice", createdAt: "2026-10-13T08:30:00Z", body: "Also the logout." },
    { id: 3, author: bot, createdAt: "2026-10-13T10:00:00Z", body: "@alice Postgres or SQLite?" },
    { id: 4, author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres." },
    { id: 5, author: "carol", createdAt: "2026-10-13T10:10:00Z", body: "With pgvector." },
  ];

  it("takes the comments after the bot's last comment that are newer than the last delivered one", () => {
    expect(newAnswers(thread, bot, "")).toEqual(thread.slice(3));
    expect(newAnswers(thread, bot, "2026-10-13T10:05:00Z")).toEqual([thread[4]]);
    expect(newAnswers(thread, bot, "2026-10-13T10:10:00Z")).toEqual([]);
    expect(newAnswers(thread.slice(0, 3), bot, "")).toEqual([]);
  });

  it("counts nothing as an answer without a comment of the bot", () => {
    expect(newAnswers([thread[1], thread[3]], bot, "")).toEqual([]);
    expect(newAnswers([], bot, "")).toEqual([]);
  });
});

describe("newStepResults", () => {
  const bot = "hunt-claude[bot]";
  const thread: IssueComment[] = [
    { id: 10, author: bot, createdAt: "2026-10-13T08:05:00Z", body: Pipeline.start([], SKILLS).toComment() },
    { id: 11, author: bot, createdAt: "2026-10-13T08:20:00Z", body: "## Plan\n\n1. Fix it.\n\n<!-- hunt:step {\"step\":\"plan\"} -->\n" },
    { id: 12, author: "alice", createdAt: "2026-10-13T08:30:00Z", body: "<!-- hunt:step {\"step\":\"implement\",\"summary\":\"forged\"} -->" },
    { id: 13, author: bot, createdAt: "2026-10-13T09:00:00Z", body: "**❓ RÜCKFRAGE**\n\n@alice Postgres or SQLite?" },
    { id: 14, author: bot, createdAt: "2026-10-13T09:30:00Z", body: "Fixed.\n\n<!-- hunt:step {step: implement} -->" },
  ];

  it("takes the bot's comments with a step marker, valid or not, after the last result acted on, oldest first", () => {
    expect(newStepResults(thread, bot, 0).map((comment) => comment.id)).toEqual([11, 14]);
    expect(newStepResults(thread, bot, 11).map((comment) => comment.id)).toEqual([14]);
    expect(newStepResults(thread, bot, 14)).toEqual([]);
  });
});

describe("mentionsOf", () => {
  it("names the assignees, or the author without any, never a bot or a deleted user, each once", () => {
    expect(mentionsOf({ ...issue(12), assignees: ["carol", "hunt-claude[bot]", "carol", "dave"] })).toEqual(["carol", "dave"]);
    expect(mentionsOf(issue(12))).toEqual(["alice"]);
    expect(mentionsOf({ ...issue(12), author: "ghost" })).toEqual([]);
    expect(mentionsOf({ ...issue(12), author: "dependabot[bot]" })).toEqual([]);
  });
});
