/**
 * The pipeline of a swf session, free of I/O: where the issue stands on its way from the plan to the merge, and the
 * transitions a step result of the agent (`step-result.utils.ts`) or the state of the pull request causes. Its state
 * lives in two places that hold the same JSON: `.hunt/swf/pipeline.json` of the session's worktree on the VM, where the
 * runner (`apps/session/src/swf-runner/swf-runner.service.ts`) and the Hunt client read it, and the record comment on
 * the issue (`toComment`: a status line for the people reading the issue and `<!-- hunt:pipeline {…} -->` for the
 * services), which the gateway's poller (`apps/gateway/src/swf/poller.service.ts`, `swf/pipeline-record.client.ts`)
 * posts when it claims the issue and both services edit in place after every intent, so that a restart loses nothing.
 * `version` is RECORD_VERSION for every record this release writes; a record of an older version is left alone
 * (`fromComment` names the problem), since its fields meant something else.
 *
 * `settings` are the repository's step settings (`step-settings.value-object.ts`) as the poller found them at the claim:
 * the skill, model and effort of each agent step, the limit of returns of each step that sends the issue back and the
 * gate of each agent step. The services drive the pipeline by them, never by hunt.json again.
 *
 * `runs` is the pipeline's log: one entry per run of a step, in the order they happened, appended only. A step that runs
 * again gets a new entry; a run that sends the issue back to implement ends as `returned` and the implement run it causes
 * names it as its `cause`. The client draws the pipeline's graph from this list. A run of an agent step names the
 * conversation its prompt went to (`sessionId`, the relay's ACP session, which is Claude Code's), whose transcript the
 * runner keeps as `.hunt/swf/transcripts/<nn>-<step>.jsonl`.
 *
 * The steps run plan → implement → verify → review → pr → pr-gate → merge. The plan step creates the session's branch
 * by the repository's branch naming rules and reports it in its result (`branch` is empty until then). The agent steps
 * end with the review, a fresh conversation that judges the change by the repository's review criteria; the gates and
 * these steps make sure of the change, so a failing check of the pull request's CI sends nothing back. From pr-gate on
 * the poller watches the pull request and decides from GitHub's state alone (`prGateOutcome`), never from a particular
 * reviewer or workflow: pr-gate waits until the head commit's checks are done and goes on to merge once GitHub reports
 * the pull request as approved, by a person or by a review workflow of the repository (such as a scoring GitHub Action
 * that approves the pull requests no person has to review); without an approval it asks the issue's people once and
 * waits. merge merges, and sends a pull request that GitHub reports as blocked once its checks are done (a withdrawn
 * approval, a red required check) back to pr-gate. Findings of verify, of the review, of a person's change request or
 * of the merge (conflicts) send the issue back to implement, which then runs verify and review again before the pull
 * request waits at pr-gate once more. Each returning step counts its returns (`returns`) against its own limit
 * (`maxReturns`); past it the implement step is an escalation, the agent asks the people, and that step counts anew.
 *
 * A record of an earlier release may name a retired step (`RETIRED_STEPS` in `swf-step.types.ts`), as its step or the
 * step of a run: `human-review` and `checks` both read as pr-gate; the returns and settings of human-review, pr-gate's
 * former name, carry over to pr-gate, those of checks are dropped (`swf-step.rules.ts`), so the pipeline goes on.
 *
 * An agent step whose settings name a gate is finished only when the gate's checks pass on its result: the runner runs
 * them and, on a failure, gives the result back to the agent in the same conversation (`noteGateFailure`). `gateRuns`
 * counts those failures of the current run; past `maxGateRuns` the agent is asked to escalate (`gateEscalates`). A gate
 * failure is no return.
 *
 * An issue is marked as failed when the agent gives up or ends a step's turn twice without its result (`fail`); a run
 * of a person's slash command such as `/compact` ends the agent's turn too, but counts as neither (`continueAfterCommand`).
 * A person resumes a failed issue by taking `swf:failed` off: the step gets a new run that `resumes` the failed one
 * (`resume`), and an agent step sends the agent on in the conversation of the failed run when the VM still serves it.
 */
import * as z from "zod/mini";
import { DomainModel } from "../model/domain.model.ts";
import { isRecord } from "../shared/json-rpc.utils.ts";
import type { PullRequestState } from "./pull-request-state.value-object.ts";
import type { Finding, ParsedStepResult } from "./step-result.utils.ts";
import { isReturningStep, RETURNING_STEPS, StepSettings, type ReturningStep, type ScoringStep, type StepSetting } from "./step-settings.value-object.ts";
import { ZodSwfStep, ZodCurrentStepKeys } from "./swf-step.rules.ts";
import { isAgentStep, type AgentStep, type SwfStep } from "./swf-step.types.ts";
import { UnusableStepResult } from "./unusable-step-result.error.ts";

/** The version of the records this release writes and drives; see the module comment. */
export const RECORD_VERSION = 4;
/** `<!-- hunt:pipeline {…} -->` in the poller's record comment; the JSON object is the first group. */
const RECORD_MARKER = /<!--\s*hunt:pipeline\s+(\{[\s\S]*?\})\s*-->/;
const FINDINGS_LIMIT = 20;
const FINDING_LIMIT = 4000;

/**
 * How a run of a step ended: `passed` on to the next step, `returned` back to implement with findings, `failed` when
 * the issue was marked as failed, `restarted` when the session's VM was replaced and the step started over; `running`
 * while it runs.
 */
export const RUN_OUTCOMES = ["running", "passed", "returned", "failed", "restarted"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** One run of a step; see the module comment. Times are ISO 8601. */
const ZodRun = z.object({
  /** The run's position in the pipeline's log, from 1. */
  n: z.int(),
  step: ZodSwfStep,
  startedAt: z.string(),
  endedAt: z.nullable(z.string()),
  outcome: z.enum(RUN_OUTCOMES),
  /** How many findings a `returned` run reported. */
  findings: z.optional(z.int()),
  /** The `n` of the run whose findings caused this implement run. */
  cause: z.optional(z.int()),
  /** The ACP session of the conversation the prompt of this agent step's run went to; absent until the prompt went out. */
  sessionId: z.optional(z.string()),
  /** The `n` of the failed run of the same step that this run resumes. */
  resumes: z.optional(z.int()),
});
export type Run = z.infer<typeof ZodRun>;

/** The strings of a list; entries that are no string are dropped, and a value that is no list gives none. */
const ZodStrings = z.pipe(
  z.catch(z.array(z.unknown()), () => []),
  z.transform((entries) => entries.filter((entry): entry is string => typeof entry === "string")),
);

/** How often each returning step sent the issue back; a value that is no such map counts as none. */
const ZodReturns = z.catch(ZodCurrentStepKeys(z.partialRecord(z.enum(RETURNING_STEPS), z.int().check(z.nonnegative()))), () => ({}));

/**
 * The record. A field that a record lacks or holds with another type falls back to its value at the start; only a record
 * of a version below RECORD_VERSION, one without a step of the pipeline, one without usable step settings, or one that
 * breaks a refine, is unusable.
 */
const ZodPipelineState = z
  .object({
    /** The record's version, RECORD_VERSION or above; `fromComment` tells an older record apart before this schema sees it. */
    version: z.int().check(z.gte(RECORD_VERSION)),
    /** The issue's repository as `<owner>/<repo>`, its number and the session's branch; the branch is empty until the plan step reported it. */
    repo: z.catch(z.string(), ""),
    issue: z.catch(z.int(), 0),
    branch: z.catch(z.string(), ""),
    /** The id of the record comment on the issue, so that the runner can edit it; 0 until the poller posted it. */
    recordId: z.catch(z.int(), 0),
    step: ZodSwfStep,
    /** How often each returning step sent the issue back to implement since the plan or since that step's last escalation. */
    returns: ZodReturns,
    /** How often the result of the current step's run failed its gate. */
    gateRuns: z.catch(z.int().check(z.nonnegative()), 0),
    pullRequest: z.catch(z.nullable(z.number()), null),
    /** The repository's step settings as the poller found them at the claim; see the module comment. */
    settings: StepSettings.createParser(),
    /** What the current implement step is to fix; empty for the first implementation of the plan. */
    findings: ZodStrings,
    /** Whether the current implement step is an escalation: the agent is to ask the humans instead of fixing on its own. */
    escalate: z.catch(z.boolean(), false),
    /**
     * The relay's `lastTurnEndedAt` when the current step's prompt was sent, so that a turn that ended since is told
     * apart; null while no prompt was sent for the current step.
     */
    promptTurn: z.catch(z.nullable(z.number()), null),
    /** Whether the agent was reminded once after it ended the current step's turn without a result. */
    reminded: z.catch(z.boolean(), false),
    /** The id of the last step-result comment the poller acted on; results with a lower id are history. */
    lastResultId: z.catch(z.int(), 0),
    /** The id of the last review of a person with changes requested that went back to the agent. */
    handledReview: z.catch(z.nullable(z.number()), null),
    /** The head commit for which the branch was last updated or the merge last tried, so that each is done once per head. */
    mergeSha: z.catch(z.nullable(z.string()), null),
    /** Whether the people who have to review were mentioned on the pull request. */
    notified: z.catch(z.boolean(), false),
    /** Whether the issue was moved to In Review in its projects, which happens once, at the first poll after the pull request opened. */
    inReview: z.catch(z.boolean(), false),
    /** The log of the steps' runs, appended only. */
    runs: z.catch(z.array(ZodRun), () => []),
  })
  .check(
    z.refine((state) => !state.reminded || state.promptTurn !== null, { message: "the agent is reminded only after a prompt", path: ["reminded"] }),
    z.refine((state) => state.mergeSha === null || state.step === "merge", { message: "a merge is requested only at the step merge", path: ["mergeSha"] }),
    z.refine((state) => !state.notified || state.pullRequest !== null, { message: "reviewers are notified only on a pull request", path: ["notified"] }),
    z.refine((state) => runningRun(state.runs)?.step === undefined || runningRun(state.runs)?.step === state.step, {
      message: "the running run is the current step's",
      path: ["runs"],
    }),
  );

/** The run of `runs` that still runs, the last one, or undefined when the last one ended or there is none. */
function runningRun(runs: Run[]): Run | undefined {
  const last = runs[runs.length - 1];
  return last?.outcome === "running" ? last : undefined;
}

/** A review of the pull request by a person or a bot. */
export interface PullRequestReview {
  id: number;
  author: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state: string;
  body: string;
  submittedAt: string;
}

/**
 * What pr-gate does: send a person's change request back, go on to merge (`by` the people who approved, empty when
 * only GitHub's review decision says so), or wait for `reason`, asking the issue's people to review unless it waits for
 * the checks (`asksPeople`).
 */
export type PrGateOutcome =
  | { kind: "changes"; review: PullRequestReview }
  | { kind: "approved"; by: string[] }
  | { kind: "wait"; reason: string; asksPeople: boolean };

/** The issue a pipeline works on: its repository as `<owner>/<repo>`, its number and the session's branch (empty until the plan step named it). */
export interface SwfIssue {
  repo: string;
  number: number;
  branch: string;
}

/** What a record comment holds: the pipeline, or why the record is not driven (`problem`, for the people reading the issue). */
export type ParsedRecord = { pipeline: Pipeline; problem?: undefined } | { pipeline?: undefined; problem: string };

export interface Pipeline extends z.infer<typeof ZodPipelineState> {}

/** What the poller knows about a session's pipeline; see the module comment. */
export class Pipeline extends DomainModel<typeof ZodPipelineState> {
  static readonly schema = ZodPipelineState;

  constructor(value: z.input<typeof ZodPipelineState>) {
    super(value);
  }

  /**
   * The pipeline of the newly claimed `issue`: at plan, with nothing sent or acted on yet, of RECORD_VERSION; `settings`
   * are the repository's step settings, `now` the time in ms the first run starts at.
   */
  static start(issue: SwfIssue, settings: StepSettings, now: number): Pipeline {
    return new Pipeline({
      version: RECORD_VERSION,
      repo: issue.repo,
      issue: issue.number,
      branch: issue.branch,
      recordId: 0,
      step: "plan",
      returns: {},
      gateRuns: 0,
      pullRequest: null,
      settings,
      findings: [],
      escalate: false,
      promptTurn: null,
      reminded: false,
      lastResultId: 0,
      handledReview: null,
      mergeSha: null,
      notified: false,
      inReview: false,
      runs: [{ n: 1, step: "plan", startedAt: isoOf(now), endedAt: null, outcome: "running" }],
    });
  }

  /**
   * The pipeline in the body of a record comment (`toComment`), or the problem with the record: one of a version below
   * RECORD_VERSION (a record without a version is of version 1, from before Hunt recorded one), whose fields meant
   * something else, is left alone; one the schema rejects is unusable. Null when `body` carries no record marker.
   */
  static fromComment(body: string): ParsedRecord | null {
    const match = RECORD_MARKER.exec(body);
    if (!match) return null;
    const json = parseJson(match[1]);
    const version = recordVersion(json);
    if (typeof version === "number" && version < RECORD_VERSION) {
      return { problem: `the record is of version ${version}; this release drives records of version ${RECORD_VERSION} and above only` };
    }
    const parsed = ZodPipelineState.safeParse(json);
    return parsed.success ? { pipeline: new Pipeline(parsed.data) } : { problem: "the record is unusable" };
  }

  /** Whether the pipeline waits for a turn of the agent (an agent step) rather than for GitHub. */
  get waitsForAgent(): boolean {
    return isAgentStep(this.step);
  }

  /** Whether the prompt of the current agent step is still to be sent. */
  get isPromptPending(): boolean {
    return this.waitsForAgent && this.promptTurn === null;
  }

  /**
   * The conversation a resumed agent step goes on in while its prompt is pending: that of the failed run it resumes;
   * null for any other run, after its prompt went out, or when the failed run had no conversation yet.
   */
  get resumedConversation(): string | null {
    const resumes = this.currentRun?.resumes;
    if (!this.isPromptPending || resumes === undefined) return null;
    return this.runs.find((run) => run.n === resumes)?.sessionId ?? null;
  }

  /** Whether the pipeline ended because its issue was marked as failed, which a person can resume (`resume`). */
  get hasFailed(): boolean {
    return !this.currentRun && this.runs[this.runs.length - 1]?.outcome === "failed";
  }

  /** One line on where the pipeline stands, for the people who read the issue. */
  get statusLine(): string {
    const parts = [`**Hunt:** step \`${this.step}\``];
    for (const step of RETURNING_STEPS) {
      const count = this.returnsOf(step);
      if (count > 0) {
        parts.push(`${this.returnCountOf(step)} (${step})`);
      }
    }
    if (this.pullRequest !== null) {
      parts.push(`pull request #${this.pullRequest}`);
    }
    if (this.step === "pr-gate") {
      parts.push("the pull request waits for its checks and an approval");
    }
    return parts.join(" · ");
  }

  /** The run of the current step while it runs; undefined for a record without runs. */
  get currentRun(): Run | undefined {
    return runningRun(this.runs);
  }

  /** The last run that ended, the one whose result the pipeline acted on last; undefined before the first ended. */
  get lastEndedRun(): Run | undefined {
    for (let index = this.runs.length - 1; index >= 0; index--) {
      if (this.runs[index].outcome !== "running") return this.runs[index];
    }
    return undefined;
  }

  /**
   * The step that sent the issue back to the current implement run: the step of the last run that ended as returned since
   * the plan. Null at another step than implement, for the plan's own implementation and for a record without runs.
   */
  get causeOf(): ReturningStep | null {
    if (this.step !== "implement") return null;
    for (let index = this.runs.length - 1; index >= 0; index--) {
      const run = this.runs[index];
      if (run.step === "plan") return null;
      if (run.outcome === "returned" && isReturningStep(run.step)) return run.step;
    }
    return null;
  }

  /** Whether the current step's result failed its gate more often than the settings allow, so that the agent is to escalate. */
  get gateEscalates(): boolean {
    return this.gateRuns > this.settings.maxGateRuns;
  }

  /** Whether the agent ended a turn since its last prompt; `lastTurnEndedAt` is the relay's. False while no prompt was sent. */
  hasTurnEndedSincePrompt(lastTurnEndedAt: number): boolean {
    return this.promptTurn !== null && lastTurnEndedAt !== this.promptTurn;
  }

  /** The repository's skill for the agent step `step`, the one its hunt.json names. */
  skillOf(step: AgentStep): string {
    return this.settings.skillOf(step);
  }

  /** The settings of `step`. */
  settingsOf(step: SwfStep): StepSetting {
    return this.settings.of(step);
  }

  /** How often `step` sent the issue back since the plan or since its last escalation; 0 for a step that never does. */
  returnsOf(step: SwfStep): number {
    return isReturningStep(step) ? (this.returns[step] ?? 0) : 0;
  }

  /** The returns of `step` against its limit as the status line and the implement prompt say them: `return n of m`, `return n` without a limit. */
  returnCountOf(step: SwfStep): string {
    const limit = this.limitOf(step);
    return limit === null ? `return ${this.returnsOf(step)}` : `return ${this.returnsOf(step)} of ${limit}`;
  }

  /** How often `step` may send the issue back before the agent escalates; null for a step without a limit. */
  limitOf(step: SwfStep): number | null {
    return this.settings.limitOf(step);
  }

  /** The checks of hunt.json that must pass on the result of `step`, in the order of hunt.json; empty for no gate. */
  gateOf(step: SwfStep): string[] {
    return this.settings.of(step).gate;
  }

  /** The config options of the conversation of the agent step `step`: `model` and `effort` where set. */
  configOptionsOf(step: AgentStep): Record<string, string> {
    return this.settings.configOptionsOf(step);
  }

  /**
   * What pr-gate does with `pullRequest` and its `reviews`, from the latest review of each person (reviews by
   * `botLogin` or another bot and plain comments do not count) and GitHub's state: a change request that was not handled
   * yet goes back to the agent at once; otherwise the step waits until the head commit's checks are done, then goes on to
   * merge when a person approved or GitHub's review decision is APPROVED, no change request is open and GitHub does not
   * report the pull request as blocked (a red required check, which a person has to see to). Otherwise it waits for the
   * people.
   */
  prGateOutcome(reviews: PullRequestReview[], botLogin: string, pullRequest: PullRequestState): PrGateOutcome {
    const latest = new Map<string, PullRequestReview>();
    for (const review of reviews) {
      if (review.author === botLogin || review.author.endsWith("[bot]")) continue;
      if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
      latest.set(review.author, review);
    }
    const changes = [...latest.values()].filter((review) => review.state === "CHANGES_REQUESTED");
    const unhandled = changes.find((review) => this.isUnhandledReview(review.id));
    if (unhandled) return { kind: "changes", review: unhandled };
    if (pullRequest.checks === "pending") return { kind: "wait", reason: `the checks of #${pullRequest.number} are still running`, asksPeople: false };
    if (pullRequest.checks === "none") return { kind: "wait", reason: `the head commit of #${pullRequest.number} has no checks yet`, asksPeople: false };
    if (changes.length > 0) return { kind: "wait", reason: `a change request on #${pullRequest.number} is open`, asksPeople: true };
    const approvers = [...latest.values()].filter((review) => review.state === "APPROVED").map((review) => review.author);
    if (approvers.length === 0 && !pullRequest.isApproved) return { kind: "wait", reason: `waiting for an approval of #${pullRequest.number}`, asksPeople: true };
    if (pullRequest.mergeState === "BLOCKED") {
      return { kind: "wait", reason: `#${pullRequest.number} is approved, but GitHub reports it as blocked`, asksPeople: true };
    }
    return { kind: "approved", by: approvers };
  }

  /** The body of the record comment: the status line for people and the record for the poller. */
  toComment(): string {
    return `${this.statusLine}\n\n<!-- hunt:pipeline ${JSON.stringify(this)} -->\n`;
  }

  /**
   * Moves the pipeline on with the step result the agent reported (`parseStepResult` of its text): plan → implement;
   * implement → verify; verify → review, or back to implement with the findings at or above the step's `minSeverity`
   * (an unscored finding always returns; the others stay in the result as suggestions); review → pr while the pull
   * request does not exist yet, else pr-gate, or back to implement the same way; pr → pr-gate. `resultId` is the id of the comment
   * that carries the result when the poller reads it from the issue, null for the result the runner reads from
   * `.hunt/swf/result.md`. Throws UnusableStepResult with the problem for a text without a usable result and for the
   * result of another step than the current one. `now` is the time in ms the step's run ends and the next one starts at.
   * The plan's result starts the counts anew: no returns, no escalation.
   */
  acceptResult(reported: ParsedStepResult | null, resultId: number | null, now: number): void {
    if (resultId !== null) {
      this.assertNewResult(resultId);
    }
    if (!reported) throw new UnusableStepResult("no step marker");
    if (!reported.result) throw new UnusableStepResult(reported.problem);
    const result = reported.result;
    if (result.step !== this.step) throw new UnusableStepResult(`the result reports step ${result.step}, but the current step is ${this.step}`);
    this.changeState(() => {
      this.lastResultId = resultId ?? this.lastResultId;
      switch (result.step) {
        case "plan":
          this.branch = result.branch;
          this.moveTo("implement", now);
          this.returns = {};
          this.findings = [];
          this.escalate = false;
          break;
        case "implement":
          this.moveTo("verify", now);
          break;
        case "verify": {
          const returning = this.returningFindings("Verify", result.findings);
          if (returning.length > 0) {
            this.returnToImplement(returning, now);
          } else {
            this.moveTo("review", now);
          }
          break;
        }
        case "review": {
          const returning = this.returningFindings("Review", result.findings);
          if (returning.length > 0) {
            this.returnToImplement(returning, now);
          } else {
            this.moveTo(this.pullRequest === null ? "pr" : "pr-gate", now);
          }
          break;
        }
        case "pr":
          this.moveTo("pr-gate", now);
          this.pullRequest = result.pullRequest;
          break;
      }
    });
  }

  /**
   * The unusable step result went back to the agent, whose turn had ended at `lastTurnEndedAt` (0: none had): the step
   * stays, the result is history and the agent's next turn counts as the answer to it. `resultId` is the id of the
   * comment that carried the result when the poller read it from the issue, null for the result the runner read from
   * `.hunt/swf/result.md`.
   */
  dismissResult(resultId: number | null, lastTurnEndedAt: number): void {
    if (resultId !== null) {
      this.assertNewResult(resultId);
    }
    this.changeState(() => {
      this.lastResultId = resultId ?? this.lastResultId;
      this.promptTurn = lastTurnEndedAt;
      this.reminded = false;
    });
  }

  /**
   * The result of the current agent step failed its gate and went back to the agent, whose turn had ended at
   * `lastTurnEndedAt` (0: none had): the failure is counted, the step stays, the result is history and the agent's next
   * turn counts as the answer to it, as after `dismissResult`. No return: the returns stay as they are.
   */
  noteGateFailure(lastTurnEndedAt: number): void {
    if (!this.waitsForAgent) throw new Error(`the step ${this.step} waits for GitHub and has no gate`);
    this.changeState(() => {
      this.gateRuns += 1;
      this.promptTurn = lastTurnEndedAt;
      this.reminded = false;
    });
  }

  /**
   * The prompt of the current agent step went to the agent in the conversation `sessionId`, whose turn had ended at
   * `lastTurnEndedAt` (0: none had); the current run names that conversation.
   */
  recordPrompt(lastTurnEndedAt: number, sessionId: string): void {
    if (!this.waitsForAgent) throw new Error(`the step ${this.step} has no prompt for the agent`);
    if (this.promptTurn !== null) throw new Error(`the prompt of the step ${this.step} was sent already`);
    this.changeState(() => {
      this.promptTurn = lastTurnEndedAt;
      const current = runningRun(this.runs);
      if (current) this.runs = [...this.runs.slice(0, -1), { ...current, sessionId }];
    });
  }

  /** The agent, whose turn ended at `lastTurnEndedAt` without a result for the step, was reminded of it; that happens once. */
  remind(lastTurnEndedAt: number): void {
    if (!this.hasTurnEndedSincePrompt(lastTurnEndedAt)) throw new Error(`no turn of the agent ended since the prompt of the step ${this.step}`);
    if (this.reminded) throw new Error(`the agent was reminded of the step ${this.step} already`);
    this.changeState(() => {
      this.reminded = true;
      this.promptTurn = lastTurnEndedAt;
    });
  }

  /**
   * A person's slash command (`/compact`, …) ended the agent's turn at `lastTurnEndedAt` before the step's result: the
   * agent was told to go on, and its next turn counts as the step's; the reminder stays as it was.
   */
  continueAfterCommand(lastTurnEndedAt: number): void {
    if (!this.hasTurnEndedSincePrompt(lastTurnEndedAt)) throw new Error(`no turn of the agent ended since the prompt of the step ${this.step}`);
    this.changeState(() => {
      this.promptTurn = lastTurnEndedAt;
    });
  }

  /**
   * The answers to the agent's question went to the agent, whose turn had ended at `lastTurnEndedAt` (0: none had): its
   * next turn counts as the step's, and one that ends without a result gets a reminder again.
   */
  noteAnswersDelivered(lastTurnEndedAt: number): void {
    this.changeState(() => {
      this.promptTurn = lastTurnEndedAt;
      this.reminded = false;
    });
  }

  /**
   * Findings of a returning step (verify, review, pr-gate, merge) send the issue back to implement: the
   * return is counted for the step, past the step's limit the agent escalates to the people and the step counts anew.
   * Empty findings are dropped; at most FINDINGS_LIMIT of FINDING_LIMIT characters each are kept. `now` is the time in
   * ms the step's run ends at.
   */
  sendBackToImplement(findings: string[], now: number): void {
    if (!isReturningStep(this.step)) throw new Error(`the step ${this.step} checks nothing that could send the issue back to implement`);
    this.changeState(() => this.returnToImplement(findings, now));
  }

  /** At the merge GitHub reports the pull request as blocked (its approval withdrawn, a red required check): back to pr-gate. */
  requireReview(now: number): void {
    this.assertStep("merge", "a review");
    this.changeState(() => this.moveTo("pr-gate", now));
  }

  /** The pull request is approved, by a person or as GitHub's review decision says: on to merge. */
  approve(now: number): void {
    this.assertStep("pr-gate", "an approval");
    this.changeState(() => this.moveTo("merge", now));
  }

  /** The change request `reviewId` of a person goes back to implement with `finding`, once. */
  handleChangeRequest(reviewId: number, finding: string, now: number): void {
    this.assertStep("pr-gate", "a change request");
    if (!this.isUnhandledReview(reviewId)) throw new Error(`the review ${reviewId} was handled already`);
    this.changeState(() => {
      this.returnToImplement([finding], now);
      this.handledReview = reviewId;
    });
  }

  /** The pull request is merged: the merge run ends as passed, and with it the pipeline. */
  complete(now: number): void {
    this.assertStep("merge", "completing the pipeline");
    this.changeState(() => this.endRun("passed", now));
  }

  /** The issue was marked as failed at the current step: its run ends as failed. */
  fail(now: number): void {
    this.changeState(() => this.endRun("failed", now));
  }

  /**
   * A person took the failed label off the issue at `now`: a run of the step the pipeline failed at begins, which
   * `resumes` the failed run, with no prompt sent, no reminder and no gate failure yet; see `resumedConversation`.
   */
  resume(now: number): void {
    const failed = this.runs[this.runs.length - 1];
    if (!this.hasFailed || !failed) throw new Error(`the pipeline at ${this.step} has not failed; nothing to resume`);
    this.changeState(() => this.beginRun(this.step, now, { resumes: failed.n }));
  }

  /**
   * The session's VM was replaced, and with it the agent's conversation: the current agent step starts over on the new
   * VM at `now`, its run ends as `restarted` and a new run of the step begins, whose prompt is to be sent. A step that
   * waits for GitHub has nothing to start over.
   */
  restart(now: number): void {
    if (!this.waitsForAgent) throw new Error(`the step ${this.step} waits for GitHub, not for the agent; nothing to restart`);
    this.changeState(() => this.moveTo(this.step, now, "restarted"));
  }

  /** The people who have to review were asked to on the pull request. */
  noteReviewersNotified(): void {
    this.changeState(() => {
      this.notified = true;
    });
  }

  /** The issue was moved to In Review in its projects; that happens once per pipeline. */
  noteInReview(): void {
    this.changeState(() => {
      this.inReview = true;
    });
  }

  /** The record comment `recordId` on the issue holds this pipeline from now on. */
  noteRecordComment(recordId: number): void {
    this.changeState(() => {
      this.recordId = recordId;
    });
  }

  /** GitHub was asked to update the branch of, or to merge, the head commit `headSha`; the merge step waits for it. */
  noteMergeRequested(headSha: string): void {
    this.assertStep("merge", "a merge request");
    this.changeState(() => {
      this.mergeSha = headSha;
    });
  }

  /**
   * Enters `step` at `now`: the current run ends as `outcome`, a run of `step` starts (with `cause`, the run that sent the
   * issue back); no prompt sent, no reminder, no gate failure, no merge requested yet.
   */
  private moveTo(step: SwfStep, now: number, outcome: Exclude<RunOutcome, "running"> = "passed", cause?: number): void {
    this.endRun(outcome, now);
    this.beginRun(step, now, cause === undefined ? {} : { cause });
  }

  /** Begins a run of `step` at `now` with `link` (its `cause` or the run it `resumes`), with no prompt sent, no reminder, no gate failure and no merge requested yet. */
  private beginRun(step: SwfStep, now: number, link: Pick<Run, "cause" | "resumes">): void {
    this.step = step;
    this.promptTurn = null;
    this.reminded = false;
    this.gateRuns = 0;
    this.mergeSha = null;
    this.runs = [...this.runs, { n: this.runs.length + 1, step, startedAt: isoOf(now), endedAt: null, outcome: "running", ...link }];
  }

  /** Ends the current run as `outcome` at `now`; a record without a running run has nothing to end. */
  private endRun(outcome: Exclude<RunOutcome, "running">, now: number, findings?: number): void {
    const current = runningRun(this.runs);
    if (!current) return;
    const ended: Run = { ...current, endedAt: isoOf(now), outcome };
    if (findings !== undefined) ended.findings = findings;
    this.runs = [...this.runs.slice(0, -1), ended];
  }

  /**
   * The findings of the current scoring step that send the pipeline back, as the implement prompt lists them: those at
   * or above the step's `minSeverity` and the unscored ones, the gravest first, each prefixed with `prefix` and its
   * severity (`Review (severity 4): …`; `Review: …` for an unscored one). Empty when every finding is a suggestion.
   */
  private returningFindings(prefix: string, findings: Finding[]): string[] {
    const minSeverity = this.settings.minSeverityOf(this.step as ScoringStep);
    return findings
      .filter((finding) => finding.severity === null || finding.severity >= minSeverity)
      .sort((a, b) => (b.severity ?? Infinity) - (a.severity ?? Infinity))
      .map((finding) => (finding.severity === null ? `${prefix}: ${finding.text}` : `${prefix} (severity ${finding.severity}): ${finding.text}`));
  }

  /** Enters implement to fix `findings` of the current step, which must be a returning one; see `sendBackToImplement`. */
  private returnToImplement(findings: string[], now: number): void {
    const cause = this.step;
    if (!isReturningStep(cause)) throw new Error(`the step ${cause} cannot send the issue back to implement`);
    const count = this.returnsOf(cause) + 1;
    const limit = this.limitOf(cause);
    const escalate = limit !== null && count > limit;
    const kept = findings.filter((finding) => finding.trim() !== "").slice(0, FINDINGS_LIMIT).map((finding) => finding.slice(0, FINDING_LIMIT));
    const causeRun = runningRun(this.runs)?.n;
    this.endRun("returned", now, kept.length);
    this.moveTo("implement", now, "passed", causeRun);
    this.findings = kept;
    this.escalate = escalate;
    this.returns = { ...this.returns, [cause]: escalate ? 0 : count };
  }

  /** Whether the review `reviewId` is newer than the last change request that went back to the agent. */
  private isUnhandledReview(reviewId: number): boolean {
    return this.handledReview === null || reviewId > this.handledReview;
  }

  /** Refuses a step result the poller acted on already: results up to `lastResultId` are history. */
  private assertNewResult(resultId: number): void {
    if (resultId <= this.lastResultId) throw new Error(`the step result ${resultId} is not newer than the last one acted on, ${this.lastResultId}`);
  }

  /** Refuses `what` at another step than `step`. */
  private assertStep(step: SwfStep, what: string): void {
    if (this.step !== step) throw new Error(`${what} needs the step ${step}, but the pipeline is at ${this.step}`);
  }
}

/**
 * The step settings in `value` (`swf_steps` of `hunt-ctl session-config`), or the problem with them: settings the schema
 * rejects, or settings without the skill of every agent step. Hunt has no default skill, so a session of a repository
 * whose hunt.json leaves one out cannot start.
 */
export function stepSettings(value: unknown): { settings: StepSettings; problem?: undefined } | { settings?: undefined; problem: string } {
  const parsed = StepSettings.schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
    return { problem: `the step settings are unusable (${issues.join("; ")})` };
  }
  const settings = new StepSettings(parsed.data);
  const missing = settings.stepsWithoutSkill;
  if (missing.length > 0) return { problem: `the step settings name no skill for ${missing.length === 1 ? "the step" : "the steps"} ${missing.join(", ")}` };
  return { settings };
}

/** `now`, a time in ms, as ISO 8601. */
function isoOf(now: number): string {
  return new Date(now).toISOString();
}

/**
 * The `version` of the raw record `json`, before the schema sees it: 1 for a record without one (written before Hunt
 * recorded a version), whatever it holds otherwise; undefined for a value that is no object.
 */
function recordVersion(json: unknown): unknown {
  if (!isRecord(json)) return undefined;
  return json.version === undefined ? 1 : json.version;
}

/** The JSON value of `text`; undefined for text that is no JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
