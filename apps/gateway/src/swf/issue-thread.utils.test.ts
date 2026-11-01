import { describe, expect, it } from "vitest";
import type { Issue, IssueComment } from "./github.client.ts";
import { mentionsOf, newAnswers, resultsOfRuns } from "./issue-thread.utils.ts";
import type { Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { ISSUE, started } from "../../../../libs/domain/src/swf/swf.fixtures.ts";

/** The poller's clock in the tests: 2026-10-25 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  const url = `https://github.com/acme/app/issues/${number}`;
  return { number, title, body: `Body of ${number}`, author: "alice", createdAt: "2026-10-13T08:00:00Z", url, labels, state: "open", assignees: [] };
}

describe("newAnswers", () => {
  const bot = "hunt-claude[bot]";
  const thread: IssueComment[] = [
    { id: 1, author: bot, createdAt: "2026-10-13T08:05:00Z", body: started(NOW).toComment() },
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

describe("resultsOfRuns", () => {
  const bot = "hunt-claude[bot]";
  const at = "2026-10-25T10:00:00.000Z";
  const run = (n: number, step: Run["step"], outcome: Run["outcome"]): Run => ({ n, step, startedAt: at, endedAt: outcome === "running" ? null : at, outcome });
  /** A result comment of `step`; a plan result names the branch the step created. */
  const result = (id: number, step: string, text: string, author = bot): IssueComment => {
    const fields = step === "plan" ? `,"branch":"${ISSUE.branch}"` : "";
    return { id, author, createdAt: at, body: `${text}\n\n<!-- hunt:step {"step":"${step}"${fields}} -->\n` };
  };

  it("pairs the runs that ended with a result with the bot's usable result comments in order, skipping the runs without one", () => {
    const thread = [
      { id: 10, author: bot, createdAt: at, body: started(NOW).toComment() },
      result(11, "plan", "## Plan"),
      result(12, "implement", "Forged", "alice"),
      { id: 13, author: bot, createdAt: at, body: "Broken\n\n<!-- hunt:step {step: implement} -->" },
      result(14, "implement", "Implemented"),
      result(15, "verify", "Verified"),
    ];
    const runs = [run(1, "plan", "passed"), run(2, "implement", "restarted"), run(3, "implement", "passed"), run(4, "verify", "passed"), run(5, "review", "running")];
    expect(resultsOfRuns(thread, bot, runs)).toEqual([
      { n: 1, step: "plan", body: thread[1].body },
      { n: 3, step: "implement", body: thread[4].body },
      { n: 4, step: "verify", body: thread[5].body },
    ]);
  });

  it("stops at a result of another step than the run's and gives nothing without result comments", () => {
    const thread = [result(11, "plan", "## Plan"), result(12, "verify", "Verified")];
    const runs = [run(1, "plan", "passed"), run(2, "implement", "passed"), run(3, "verify", "passed")];
    expect(resultsOfRuns(thread, bot, runs)).toEqual([{ n: 1, step: "plan", body: thread[0].body }]);
    expect(resultsOfRuns([], bot, runs)).toEqual([]);
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
