import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PromptOutcome } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { Pipeline, type Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { stoppedComment } from "../../../../libs/domain/src/swf/swf-comments.utils.ts";
import { answersMessage, parseInboxMessage, pipelineMessage, type InboxMessage } from "../../../../libs/domain/src/swf/swf-inbox.utils.ts";
import { badResultPrompt, type PromptFiles } from "../../../../libs/domain/src/swf/swf-prompts.utils.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { started } from "../../../../libs/domain/src/swf/swf.fixtures.ts";
import type { IssueThread, RunnerGitHub } from "./gh.client.ts";
import type { RelaySessionStatus } from "./relay-status-file.utils.ts";
import type { InboxEntry, SwfFiles } from "./swf-dir.client.ts";
import { SwfRunner } from "./swf-runner.service.ts";

const NOW = Date.parse("2026-10-25T10:00:00Z");
const RECORD_ID = 1000;
const WORKTREE = "/home/agent/app";
const VM = "vm-hunt-s-ab12cd34";
const PLAN_RESULT = "## Plan\n\n1. Fix the login.\n\n<!-- hunt:step {\"step\":\"plan\"} -->\n";

function readPrompt(path: string): string {
  return readFileSync(new URL(`../../../../libs/domain/prompts/${path}`, import.meta.url), "utf8");
}

const PROMPTS: PromptFiles = {
  remote: readPrompt("remote.system-prompt.md"),
  gitPush: readPrompt("git-push.system-prompt.md"),
  question: readPrompt("question.system-prompt.md"),
  sessions: readPrompt("sessions.system-prompt.md"),
  swfSystem: readPrompt("swf/0-system-prompt.md"),
  swfPlan: readPrompt("swf/1-plan.user-prompt.md"),
  swfImplement: readPrompt("swf/2-implement.user-prompt.md"),
  swfEscalate: readPrompt("swf/2-implement-escalate.user-prompt.md"),
  swfVerify: readPrompt("swf/3-verify.user-prompt.md"),
  swfGate: readPrompt("swf/4-gate.user-prompt.md"),
  swfPr: readPrompt("swf/5-pr.user-prompt.md"),
  swfNudge: readPrompt("swf/nudge.user-prompt.md"),
  swfAnswer: readPrompt("swf/answer.user-prompt.md"),
  swfBadResult: readPrompt("swf/bad-result.user-prompt.md"),
};

const THREAD: IssueThread = {
  issue: { number: 12, title: "Issue 12", body: "Body of 12", author: "alice", createdAt: "2026-10-13T08:00:00Z", url: "https://github.com/acme/app/issues/12" },
  labels: ["swf:plan"],
  comments: [{ author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Also the logout." }],
};

/** `.hunt/swf/` in memory. */
class FakeFiles implements SwfFiles {
  pipeline: Pipeline | null = null;
  result: string | null = null;
  steps = new Map<string, string>();
  inbox: { name: string; value: unknown }[] = [];
  /** How often the pipeline was written. */
  writes = 0;

  readPipeline(): Pipeline | null {
    return this.pipeline ? new Pipeline(Pipeline.schema.parse(this.pipeline.toJSON())) : null;
  }

  writePipeline(pipeline: Pipeline): void {
    this.writes++;
    this.pipeline = new Pipeline(Pipeline.schema.parse(pipeline.toJSON()));
  }

  readResult(): string | null {
    return this.result;
  }

  keepResult(run: Run): void {
    if (this.result === null) throw new Error("no result.md to keep");
    this.steps.set(`${String(run.n).padStart(2, "0")}-${run.step}.md`, this.result);
    this.result = null;
  }

  discardResult(): void {
    this.result = null;
  }

  readInbox(): InboxEntry[] {
    return [...this.inbox].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, value }) => ({ name, message: parseInboxMessage(value) }));
  }

  removeInboxEntry(name: string): void {
    this.inbox = this.inbox.filter((entry) => entry.name !== name);
  }

  deliver(name: string, message: InboxMessage | Record<string, unknown>): void {
    this.inbox.push({ name, value: message });
  }
}

/** GitHub as the runner sees it through gh: records its calls like the poller's tests do. */
class FakeGitHub implements RunnerGitHub {
  calls: string[] = [];
  thread = THREAD;
  labelsOnIssue = ["swf", "swf:plan"];
  /** The bodies the record comment got, latest last. */
  records: string[] = [];
  failRecordOnce = false;

  issue(repo: Repository, number: number): Promise<IssueThread> {
    this.calls.push(`issue ${repo.slug}#${number}`);
    return Promise.resolve(this.thread);
  }

  labels(repo: Repository, number: number): Promise<string[]> {
    this.calls.push(`labels ${repo.slug}#${number}`);
    return Promise.resolve([...this.labelsOnIssue]);
  }

  comment(repo: Repository, number: number, body: string): Promise<void> {
    this.calls.push(`comment ${repo.slug}#${number} ${body}`);
    return Promise.resolve();
  }

  editComment(repo: Repository, commentId: number, body: string): Promise<void> {
    if (this.failRecordOnce) {
      this.failRecordOnce = false;
      return Promise.reject(new Error("HTTP 502"));
    }
    this.calls.push(`edit ${repo.slug} ${commentId}`);
    this.records.push(body);
    return Promise.resolve();
  }

  editLabels(repo: Repository, number: number, add: string[], remove: string[]): Promise<void> {
    this.calls.push(`labels ${repo.slug}#${number} +${add.join(",")} -${remove.join(",")}`);
    this.labelsOnIssue = [...this.labelsOnIssue.filter((label) => !remove.includes(label)), ...add];
    return Promise.resolve();
  }
}

interface Harness {
  runner: SwfRunner;
  files: FakeFiles;
  github: FakeGitHub;
  status: RelaySessionStatus | null;
  /** The prompts sent, with the session they went to. */
  prompts: { sessionId: string; cwd: string; text: string }[];
  /** How often a fresh conversation was begun. */
  clears: number;
  logs: string[];
  clock: { now: number };
}

/** A runner over `pipeline` (a copy) with the relay `status`; `clear` serves the session `acp-fresh-<n>` without a turn end. */
function harness(pipeline: Pipeline | null, status: RelaySessionStatus | null = idle()): Harness {
  const files = new FakeFiles();
  if (pipeline) files.writePipeline(pipeline);
  files.writes = 0;
  const github = new FakeGitHub();
  const h: Harness = { runner: null as unknown as SwfRunner, files, github, status, prompts: [], clears: 0, logs: [], clock: { now: NOW } };
  h.runner = new SwfRunner({
    files,
    github,
    readStatus: () => h.status,
    clearConversation: () => {
      h.clears++;
      h.status = { acpSessionId: `acp-fresh-${h.clears}`, turn: "idle", clientConnected: false, lastTurnEndedAt: null };
      return Promise.resolve(h.status);
    },
    sendPrompt: (request): Promise<PromptOutcome> => {
      h.prompts.push(request);
      return Promise.resolve("started");
    },
    prompts: PROMPTS,
    worktree: WORKTREE,
    vmName: VM,
    now: () => h.clock.now,
    log: (message: string, level: LogLevel = "info") => {
      h.logs.push(level === "info" ? message : `${level}: ${message}`);
    },
  });
  return h;
}

function idle(fields: Partial<RelaySessionStatus> = {}): RelaySessionStatus {
  return { acpSessionId: "acp-1", turn: "idle", clientConnected: false, lastTurnEndedAt: null, ...fields };
}

/** The pipeline of acme/app#12 with its record comment posted, at `step` after the given intents. */
function recorded(step: SwfStep = "plan", promptTurn: number | null = null): Pipeline {
  const pipeline = started(NOW);
  pipeline.noteRecordComment(RECORD_ID);
  const order: SwfStep[] = ["plan", "implement", "verify", "gate", "pr", "review"];
  for (const current of order.slice(0, order.indexOf(step))) {
    switch (current) {
      case "plan":
        pipeline.acceptResult({ result: { step: "plan" } }, null, NOW);
        break;
      case "implement":
        pipeline.acceptResult({ result: { step: "implement", summary: "done" } }, null, NOW);
        break;
      case "verify":
        pipeline.acceptResult({ result: { step: "verify", findings: [] } }, null, NOW);
        break;
      case "gate":
        pipeline.acceptResult({ result: { step: "gate", humanReview: false, risk: "low", reasons: [] } }, null, NOW);
        break;
      case "pr":
        pipeline.acceptResult({ result: { step: "pr", pullRequest: 31 } }, null, NOW);
        break;
      default:
        break;
    }
  }
  if (promptTurn !== null) pipeline.recordPrompt(promptTurn);
  return pipeline;
}

describe("SwfRunner", () => {
  it("waits, logging each reason once, while there is no pipeline, the gateway drives the step, the relay serves no session or a turn runs", async () => {
    const h = harness(null);
    await h.runner.tick();
    await h.runner.tick();
    expect(h.logs).toEqual(["no pipeline in .hunt/swf yet"]);

    h.files.writePipeline(recorded("review"));
    await h.runner.tick();
    h.files.writePipeline(recorded("plan"));
    h.status = null;
    await h.runner.tick();
    h.status = idle({ turn: "running" });
    await h.runner.tick();
    await h.runner.tick();
    expect(h.logs.slice(1)).toEqual(["the gateway drives the step review", "the relay serves no session", "the agent runs a turn of plan"]);
    expect(h.prompts).toEqual([]);
    expect(h.github.calls).toEqual([]);
  });

  it("sends the plan prompt into a fresh conversation with the issue and its comments, records the prompt and saves the record", async () => {
    const h = harness(recorded("plan"));
    await h.runner.tick();
    expect(h.clears).toBe(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatchObject({ sessionId: "acp-fresh-1", cwd: WORKTREE });
    expect(h.prompts[0].text).toContain("Step `plan` for GitHub issue #12 of acme/app: Issue 12");
    expect(h.prompts[0].text).toContain("Body of 12");
    expect(h.prompts[0].text).toContain("**@bob** on 2026-10-13 09:00 UTC:\n\nAlso the logout.");
    expect(h.prompts[0].text).toContain("Work on the branch `feat/general/12-issue-12`.");
    expect(h.prompts[0].text).toContain("skill `swf-plan`");
    const expected = recorded("plan", 0);
    expect(h.files.pipeline?.toJSON()).toEqual(expected.toJSON());
    expect(h.github.calls).toEqual(["issue acme/app#12", `edit acme/app ${RECORD_ID}`]);
    expect(h.github.records).toEqual([expected.toComment()]);
    expect(h.logs).toContain("sent the prompt of the step plan in a fresh conversation (prompt started)");

    // The prompt is out; nothing more until the turn ends.
    await h.runner.tick();
    expect(h.prompts).toHaveLength(1);
    expect(h.clears).toBe(1);
  });

  it("takes the result of result.md once the turn ended: keeps it as the step's file, mirrors it to the issue and prompts the next step", async () => {
    const h = harness(recorded("plan", 0), idle({ lastTurnEndedAt: 5_000 }));
    h.files.result = PLAN_RESULT;
    h.clock.now = NOW + 60_000;
    await h.runner.tick();

    expect(h.files.result).toBeNull();
    expect([...h.files.steps.entries()]).toEqual([["01-plan.md", PLAN_RESULT]]);
    const pipeline = h.files.pipeline;
    expect(pipeline?.step).toBe("implement");
    expect(pipeline?.runs.map((run) => [run.step, run.outcome])).toEqual([
      ["plan", "passed"],
      ["implement", "running"],
    ]);
    expect(pipeline?.promptTurn).toBe(0);
    expect(h.github.calls).toEqual([
      `comment acme/app#12 ${PLAN_RESULT}`,
      "labels acme/app#12",
      "labels acme/app#12 +swf:implement -swf:plan",
      `edit acme/app ${RECORD_ID}`,
      "issue acme/app#12",
      `edit acme/app ${RECORD_ID}`,
    ]);
    expect(h.github.labelsOnIssue).toEqual(["swf", "swf:implement"]);
    expect(h.clears).toBe(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].sessionId).toBe("acp-fresh-1");
    expect(h.prompts[0].text).toContain("Step `implement` for issue #12 of acme/app");
    expect(h.github.records.at(-1)).toBe(pipeline?.toComment());
    expect(h.logs).toContain("the agent reported the step plan; the pipeline goes on with implement");
  });

  it("tells the agent in the running conversation why its result is unusable and discards the file", async () => {
    const h = harness(recorded("plan", 0), idle({ lastTurnEndedAt: 5_000 }));
    h.files.result = "Done.\n<!-- hunt:step {\"step\":\"implement\",\"summary\":\"x\"} -->\n";
    await h.runner.tick();
    expect(h.files.result).toBeNull();
    expect(h.files.steps.size).toBe(0);
    expect(h.clears).toBe(0);
    expect(h.prompts).toEqual([{ sessionId: "acp-1", cwd: WORKTREE, text: badResultPrompt(PROMPTS.swfBadResult, "the result reports step implement, but the current step is plan") }]);
    expect(h.files.pipeline?.step).toBe("plan");
    expect(h.files.pipeline?.promptTurn).toBe(5_000);
    expect(h.github.calls).toEqual([`edit acme/app ${RECORD_ID}`]);
    expect(h.logs).toContain("warn: the step result of plan is unusable (the result reports step implement, but the current step is plan); told the agent (prompt started)");
  });

  it("takes a result while a desktop is connected but sends no prompt until it is gone", async () => {
    const h = harness(recorded("plan", 0), idle({ lastTurnEndedAt: 5_000, clientConnected: true }));
    h.files.result = PLAN_RESULT;
    await h.runner.tick();
    expect(h.files.pipeline?.step).toBe("implement");
    expect(h.clears).toBe(0);
    expect(h.prompts).toEqual([]);
    expect(h.logs).toContain("a desktop is connected");

    h.status = idle({ lastTurnEndedAt: 5_000 });
    await h.runner.tick();
    expect(h.clears).toBe(1);
    expect(h.prompts).toHaveLength(1);
  });

  it("sends the answers the gateway put into the inbox in the running conversation and removes them", async () => {
    const h = harness(recorded("plan", 0), idle({ lastTurnEndedAt: 5_000 }));
    h.files.deliver("1-1.json", answersMessage([{ author: "bob", createdAt: "2026-10-25T11:00:00Z", body: "Postgres." }]));
    h.files.deliver("2-1.json", answersMessage([{ author: "carol", createdAt: "2026-10-25T11:05:00Z", body: "And MySQL." }]));
    await h.runner.tick();
    expect(h.clears).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].sessionId).toBe("acp-1");
    expect(h.prompts[0].text).toContain("An answer to your question arrived as a comment on issue #12 of acme/app");
    expect(h.prompts[0].text).toContain("**@bob** on 2026-10-25 11:00 UTC:\n\nPostgres.\n\n---\n\n**@carol** on 2026-10-25 11:05 UTC:\n\nAnd MySQL.");
    expect(h.prompts[0].text).toContain("finish the step `plan`");
    expect(h.files.inbox).toEqual([]);
    expect(h.files.pipeline?.promptTurn).toBe(5_000);
    expect(h.github.calls).toEqual([`edit acme/app ${RECORD_ID}`]);
    expect(h.logs).toContain("2 answers from the issue went to the agent (prompt started)");

    // Answers wait while a turn runs.
    h.files.deliver("3-1.json", answersMessage([{ author: "bob", createdAt: "2026-10-25T11:10:00Z", body: "Also." }]));
    h.status = idle({ turn: "running", lastTurnEndedAt: 5_000 });
    await h.runner.tick();
    expect(h.prompts).toHaveLength(1);
    expect(h.files.inbox.map((entry) => entry.name)).toEqual(["3-1.json"]);
  });

  it("adopts the gateway's pipeline when it is further or the local one is at a poller step, keeps its own otherwise and drops what is no message", async () => {
    const local = recorded("implement", 7_000);
    const h = harness(local, idle({ lastTurnEndedAt: 7_000 }));
    const same = recorded("implement");
    h.files.deliver("1-1.json", pipelineMessage(same));
    h.files.deliver("2-1.json", { kind: "nonsense" });
    await h.runner.tick();
    expect(h.files.pipeline?.toJSON()).toEqual(local.toJSON());
    expect(h.files.inbox).toEqual([]);
    expect(h.logs).toContain("warn: ignored 2-1.json of the inbox, which holds no message");

    // At review the poller owns the transitions: its pipeline wins, prepared or sent back.
    h.files.writePipeline(recorded("review"));
    const prepared = recorded("review");
    prepared.noteReviewPrepared();
    h.files.deliver("3-1.json", pipelineMessage(prepared));
    await h.runner.tick();
    expect(h.files.pipeline?.reviewPrepared).toBe(true);
    expect(h.prompts).toEqual([]);

    const returned = recorded("review");
    returned.sendBackToImplement(["Review: the test fails"], NOW + 1);
    h.files.deliver("4-1.json", pipelineMessage(returned));
    await h.runner.tick();
    expect(h.files.pipeline?.step).toBe("implement");
    expect(h.files.pipeline?.runs).toHaveLength(7);
    expect(h.clears).toBe(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].text).toContain("Step `implement` for issue #12 of acme/app on the branch `feat/general/12-issue-12` (attempt 1 of 5).");
    expect(h.prompts[0].text).toContain("- Review: the test fails");
    expect(h.logs).toContain("took the pipeline the gateway sent: at implement after 7 runs");
  });

  it("looks the labels up once per turn that ended without a result: a question waits for the gateway, a failed label ends the run", async () => {
    const h = harness(recorded("verify", 0), idle({ lastTurnEndedAt: 5_000 }));
    h.github.labelsOnIssue = ["swf", "swf:question"];
    await h.runner.tick();
    await h.runner.tick();
    expect(h.github.calls).toEqual(["labels acme/app#12"]);
    expect(h.prompts).toEqual([]);
    expect(h.logs).toContain("the agent asked a question at verify; the gateway brings the answer");

    h.status = idle({ lastTurnEndedAt: 6_000 });
    h.github.labelsOnIssue = ["swf", "swf:failed"];
    await h.runner.tick();
    expect(h.github.calls).toEqual(["labels acme/app#12", "labels acme/app#12", `edit acme/app ${RECORD_ID}`]);
    expect(h.files.pipeline?.currentRun).toBeUndefined();
    expect(h.files.pipeline?.runs.at(-1)).toMatchObject({ step: "verify", outcome: "failed" });
    expect(h.logs).toContain("warn: the agent gave up at verify; the issue is marked as failed");

    await h.runner.tick();
    expect(h.logs.at(-1)).toBe("the pipeline ended at verify");
  });

  it("reminds an agent whose turn ended without a result once and marks the issue as failed the second time", async () => {
    const h = harness(recorded("verify", 0), idle({ lastTurnEndedAt: 5_000 }));
    h.github.labelsOnIssue = ["swf", "swf:verify"];
    await h.runner.tick();
    expect(h.clears).toBe(0);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].sessionId).toBe("acp-1");
    expect(h.prompts[0].text).toContain("Your last turn ended, but issue #12 of acme/app still has the label `swf:verify`");
    expect(h.files.pipeline?.reminded).toBe(true);
    expect(h.files.pipeline?.promptTurn).toBe(5_000);
    expect(h.github.calls).toEqual(["labels acme/app#12", `edit acme/app ${RECORD_ID}`]);

    // The same turn end changes nothing; the next one fails the issue.
    await h.runner.tick();
    expect(h.prompts).toHaveLength(1);
    h.status = idle({ lastTurnEndedAt: 9_000 });
    h.clock.now = NOW + 120_000;
    await h.runner.tick();
    expect(h.github.calls.slice(2)).toEqual([
      "labels acme/app#12",
      "labels acme/app#12 +swf:failed -swf:verify",
      `comment acme/app#12 ${stoppedComment("verify", VM)}`,
      `edit acme/app ${RECORD_ID}`,
    ]);
    expect(h.files.pipeline?.runs.at(-1)).toMatchObject({ step: "verify", outcome: "failed", endedAt: new Date(NOW + 120_000).toISOString() });
    expect(h.github.records.at(-1)).toBe(h.files.pipeline?.toComment());
    expect(h.prompts).toHaveLength(1);
  });

  it("logs a failing pass once and saves the record at the next tick", async () => {
    const h = harness(recorded("plan"));
    h.github.failRecordOnce = true;
    await h.runner.tick();
    expect(h.prompts).toHaveLength(1);
    expect(h.files.pipeline?.promptTurn).toBe(0);
    expect(h.logs.at(-1)).toBe(`error: failed to save the record comment ${RECORD_ID}: HTTP 502`);
    expect(h.github.records).toEqual([]);

    await h.runner.tick();
    expect(h.github.records).toEqual([h.files.pipeline?.toComment()]);
    expect(h.prompts).toHaveLength(1);
    expect(h.clears).toBe(1);
  });

  it("warns once while the pipeline names no record comment and goes on without the mirror", async () => {
    const pipeline = started(NOW);
    const h = harness(pipeline);
    await h.runner.tick();
    expect(h.prompts).toHaveLength(1);
    expect(h.github.calls).toEqual(["issue acme/app#12"]);
    expect(h.logs.filter((line) => line.startsWith("warn: the pipeline names no record comment"))).toHaveLength(1);
  });
});
