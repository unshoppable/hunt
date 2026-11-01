/**
 * The pipeline of a swf session, free of I/O: where the issue stands on its way from the plan to the merge, and the
 * transitions a step result of the agent (`step-result.utils.ts`) or the state of the pull request causes. Its state
 * lives in two places that hold the same JSON: `.hunt/swf/pipeline.json` of the session's worktree on the VM, where the
 * runner (`apps/session/src/swf-runner/swf-runner.service.ts`) and the Hunt client read it, and the record comment on
 * the issue (`toComment`: a status line for the people reading the issue and `<!-- hunt:pipeline {…} -->` for the
 * services), which the gateway's poller (`apps/gateway/src/swf/poller.service.ts`, `swf/pipeline-record.client.ts`)
 * posts when it claims the issue and both services edit in place after every intent, so that a restart loses nothing.
 * `version` says who drives the agent steps: RUNNER_VERSION and above the runner on the VM, older records the poller,
 * which keeps the sessions it started before the runner existed going to their end.
 *
 * `runs` is the pipeline's log: one entry per run of a step, in the order they happened, appended only. A step that runs
 * again gets a new entry; a run that sends the issue back to implement ends as `returned` and the implement run it causes
 * names it as its `cause`. The client draws the pipeline's graph from this list.
 *
 * The steps run plan → implement → verify → gate → pr → review → human-review (when a person has to approve) → merge.
 * Findings of verify, of the review (a failing check, blocking findings of the Claude review, a human's change request)
 * or of the merge (conflicts) send the issue back to implement, which then runs verify and gate again before the
 * pull request is reviewed once more. `humanReview` stays true once set; a pull request that touches a file matching
 * `humanReviewPaths` of the repository's hunt.json (`swf/glob.utils.ts`) sets it too.
 */
import * as z from "zod/mini";
import { DomainModel } from "../model/domain.model.ts";
import { isRecord } from "../shared/json-rpc.utils.ts";
import type { ParsedStepResult } from "./step-result.utils.ts";
import { AGENT_STEPS, isAgentStep, SWF_STEPS, type AgentStep, type SwfStep } from "./swf-step.types.ts";
import { UnusableStepResult } from "./unusable-step-result.error.ts";

/** How often the issue may go back to implement before the agent has to ask the humans instead. */
export const MAX_ATTEMPTS = 5;
/** The record version from which the runner on the session VM drives the agent steps; older records the poller drives. */
export const RUNNER_VERSION = 2;
/** `<!-- hunt:pipeline {…} -->` in the poller's record comment; the JSON object is the first group. */
const RECORD_MARKER = /<!--\s*hunt:pipeline\s+(\{[\s\S]*?\})\s*-->/;
const FINDINGS_LIMIT = 20;
const FINDING_LIMIT = 4000;
/** The steps whose findings send the issue back to implement. */
const CHECKING_STEPS: readonly SwfStep[] = ["verify", "review", "human-review", "merge"];

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
  step: z.enum(SWF_STEPS),
  startedAt: z.string(),
  endedAt: z.nullable(z.string()),
  outcome: z.enum(RUN_OUTCOMES),
  /** How many findings a `returned` run reported. */
  findings: z.optional(z.int()),
  /** The `n` of the run whose findings caused this implement run. */
  cause: z.optional(z.int()),
});
export type Run = z.infer<typeof ZodRun>;

/** The strings of a list; entries that are no string are dropped, and a value that is no list gives none. */
const ZodStrings = z.pipe(
  z.catch(z.array(z.unknown()), () => []),
  z.transform((entries) => entries.filter((entry): entry is string => typeof entry === "string")),
);

/** The skill of every agent step, as `swf.skills` of the repository's hunt.json names them; Hunt has no default for a step. */
const ZodStepSkills = z.record(z.enum(AGENT_STEPS), z.string().check(z.minLength(1)));

/**
 * The record. A field that an older record lacks or holds with another type falls back to its value at the start; only
 * a record without a step of the pipeline, one without the skill of every agent step, or one that breaks a refine, is
 * unusable.
 */
const ZodPipelineState = z
  .object({
    /** The record's version; 1 for a record written before the runner existed, which the poller drives to its end. */
    version: z.catch(z.int(), 1),
    /** The issue's repository as `<owner>/<repo>`, its number and the session's branch; empty in a record of version 1. */
    repo: z.catch(z.string(), ""),
    issue: z.catch(z.int(), 0),
    branch: z.catch(z.string(), ""),
    /** The id of the record comment on the issue, so that the runner can edit it; 0 until the poller posted it. */
    recordId: z.catch(z.int(), 0),
    step: z.enum(SWF_STEPS),
    /** How often the issue went back to implement since the last plan or escalation. */
    attempt: z.catch(z.int(), 0),
    /** Whether a person has to approve the pull request before it is merged. */
    humanReview: z.catch(z.boolean(), false),
    pullRequest: z.catch(z.nullable(z.number()), null),
    /** The globs of the files whose change always needs a human, from the repository's hunt.json. */
    humanReviewPaths: ZodStrings,
    /** The repository's skill of every agent step (`swf.skills` of its hunt.json), named in the step's prompt; exactly the five, each non-empty. */
    skills: ZodStepSkills,
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
    /** The id of the last human review with changes requested that went back to the agent. */
    handledReview: z.catch(z.nullable(z.number()), null),
    /** The head commit for which the branch was last updated or the merge last tried, so that each is done once per head. */
    mergeSha: z.catch(z.nullable(z.string()), null),
    /** Whether the people who have to review were mentioned on the pull request. */
    notified: z.catch(z.boolean(), false),
    /** Whether the poller carried out what entering the current review step brings with it (`prepareReview`). */
    reviewPrepared: z.catch(z.boolean(), false),
    /** The log of the steps' runs, appended only; empty for a record written before Hunt kept it. */
    runs: z.catch(z.array(ZodRun), () => []),
  })
  .check(
    z.refine((state) => !state.reminded || state.promptTurn !== null, { message: "the agent is reminded only after a prompt", path: ["reminded"] }),
    z.refine((state) => state.mergeSha === null || state.step === "merge", { message: "a merge is requested only at the step merge", path: ["mergeSha"] }),
    z.refine((state) => !state.notified || state.humanReview, { message: "reviewers are notified only when a person reviews", path: ["notified"] }),
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

export type HumanReviewOutcome = { kind: "wait" } | { kind: "approved"; by: string[] } | { kind: "changes"; review: PullRequestReview };

/** The issue a pipeline works on: its repository as `<owner>/<repo>`, its number and the session's branch. */
export interface SwfIssue {
  repo: string;
  number: number;
  branch: string;
}

export interface Pipeline extends z.infer<typeof ZodPipelineState> {}

/** What the poller knows about a session's pipeline; see the module comment. */
export class Pipeline extends DomainModel<typeof ZodPipelineState> {
  static readonly schema = ZodPipelineState;

  constructor(value: z.input<typeof ZodPipelineState>) {
    super(value);
  }

  /**
   * The pipeline of the newly claimed `issue`: at plan, with nothing sent or acted on yet, of RUNNER_VERSION; `skills` is
   * the repository's skill of every agent step, `now` the time in ms the first run starts at.
   */
  static start(issue: SwfIssue, humanReviewPaths: string[], skills: Record<AgentStep, string>, now: number): Pipeline {
    return new Pipeline({
      version: RUNNER_VERSION,
      repo: issue.repo,
      issue: issue.number,
      branch: issue.branch,
      recordId: 0,
      step: "plan",
      attempt: 0,
      humanReview: false,
      pullRequest: null,
      humanReviewPaths,
      skills,
      findings: [],
      escalate: false,
      promptTurn: null,
      reminded: false,
      lastResultId: 0,
      handledReview: null,
      mergeSha: null,
      notified: false,
      reviewPrepared: false,
      runs: [{ n: 1, step: "plan", startedAt: isoOf(now), endedAt: null, outcome: "running" }],
    });
  }

  /** The pipeline in the body of a record comment (`toComment`); null when `body` carries no usable record. */
  static fromComment(body: string): Pipeline | null {
    const match = RECORD_MARKER.exec(body);
    if (!match) return null;
    const parsed = ZodPipelineState.safeParse(parseJson(match[1]));
    return parsed.success ? new Pipeline(parsed.data) : null;
  }

  /** Whether the runner on the session VM drives the agent steps; false for a record the poller drives to its end. */
  get isRunnerDriven(): boolean {
    return this.version >= RUNNER_VERSION;
  }

  /** Whether the pipeline waits for a turn of the agent (an agent step) rather than for GitHub. */
  get waitsForAgent(): boolean {
    return isAgentStep(this.step);
  }

  /** Whether the prompt of the current agent step is still to be sent. */
  get isPromptPending(): boolean {
    return this.waitsForAgent && this.promptTurn === null;
  }

  /** One line on where the pipeline stands, for the people who read the issue. */
  get statusLine(): string {
    const parts = [`**Hunt:** step \`${this.step}\``];
    if (this.attempt > 0) {
      parts.push(`attempt ${this.attempt} of ${MAX_ATTEMPTS}`);
    }
    if (this.pullRequest !== null) {
      parts.push(`pull request #${this.pullRequest}`);
    }
    parts.push(this.humanReview ? "a person reviews before the merge" : "merged without a human review unless the gate asks for one");
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

  /** Whether the agent ended a turn since its last prompt; `lastTurnEndedAt` is the relay's. False while no prompt was sent. */
  hasTurnEndedSincePrompt(lastTurnEndedAt: number): boolean {
    return this.promptTurn !== null && lastTurnEndedAt !== this.promptTurn;
  }

  /** The repository's skill for the agent step `step`, the one its hunt.json names. */
  skillOf(step: AgentStep): string {
    return this.skills[step];
  }

  /**
   * What the latest review of each person (reviews by `botLogin` and plain comments do not count) means: a change request
   * that was not handled yet goes back to the agent; approval by at least one person and no open change request
   * approves; otherwise the step waits.
   */
  humanReviewOutcome(reviews: PullRequestReview[], botLogin: string): HumanReviewOutcome {
    const latest = new Map<string, PullRequestReview>();
    for (const review of reviews) {
      if (review.author === botLogin || review.author.endsWith("[bot]")) continue;
      if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
      latest.set(review.author, review);
    }
    const changes = [...latest.values()].filter((review) => review.state === "CHANGES_REQUESTED");
    const unhandled = changes.find((review) => this.isUnhandledReview(review.id));
    if (unhandled) return { kind: "changes", review: unhandled };
    if (changes.length > 0) return { kind: "wait" };
    const approvers = [...latest.values()].filter((review) => review.state === "APPROVED").map((review) => review.author);
    return approvers.length > 0 ? { kind: "approved", by: approvers } : { kind: "wait" };
  }

  /** The body of the record comment: the status line for people and the record for the poller. */
  toComment(): string {
    return `${this.statusLine}\n\n<!-- hunt:pipeline ${JSON.stringify(this)} -->\n`;
  }

  /**
   * Moves the pipeline on with the step result the agent reported (`parseStepResult` of its text): plan → implement;
   * implement → verify; verify → gate, or back to implement with the findings; gate → pr while the pull request does not
   * exist yet, else review; pr → review. `resultId` is the id of the comment that carries the result when the poller
   * reads it from the issue, null for the result the runner reads from `.hunt/swf/result.md`. Throws UnusableStepResult
   * with the problem for a text without a usable result and for the result of another step than the current one. `now`
   * is the time in ms the step's run ends and the next one starts at.
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
          this.moveTo("implement", now);
          this.attempt = 0;
          this.findings = [];
          this.escalate = false;
          break;
        case "implement":
          this.moveTo("verify", now);
          break;
        case "verify":
          if (result.findings.length > 0) {
            this.returnToImplement(result.findings.map((finding) => `Verify: ${finding}`), now);
          } else {
            this.moveTo("gate", now);
          }
          break;
        case "gate":
          this.humanReview = this.humanReview || result.humanReview;
          this.moveTo(this.pullRequest === null ? "pr" : "review", now);
          break;
        case "pr":
          this.moveTo("review", now);
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

  /** The prompt of the current agent step went to the agent, whose turn had ended at `lastTurnEndedAt` (0: none had). */
  recordPrompt(lastTurnEndedAt: number): void {
    if (!this.waitsForAgent) throw new Error(`the step ${this.step} has no prompt for the agent`);
    if (this.promptTurn !== null) throw new Error(`the prompt of the step ${this.step} was sent already`);
    this.changeState(() => {
      this.promptTurn = lastTurnEndedAt;
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
   * Findings of a step that checks the implementation (verify, review, human-review, merge) send the issue back to
   * implement: the attempt is counted, past MAX_ATTEMPTS the agent escalates to the humans and the count starts anew.
   * Empty findings are dropped; at most FINDINGS_LIMIT of FINDING_LIMIT characters each are kept. `now` is the time in
   * ms the step's run ends at.
   */
  sendBackToImplement(findings: string[], now: number): void {
    if (!CHECKING_STEPS.includes(this.step)) throw new Error(`the step ${this.step} checks nothing that could send the issue back to implement`);
    this.changeState(() => this.returnToImplement(findings, now));
  }

  /** The pull request passed its checks and the Claude review: on to human-review when a person has to approve, else to merge. */
  passReview(now: number): void {
    this.assertStep("review", "passing the review");
    this.changeState(() => this.moveTo(this.humanReview ? "human-review" : "merge", now));
  }

  /** A person approved the pull request: on to merge. */
  approve(now: number): void {
    this.assertStep("human-review", "an approval");
    this.changeState(() => this.moveTo("merge", now));
  }

  /** The change request `reviewId` of a person goes back to implement with `finding`, once. */
  handleChangeRequest(reviewId: number, finding: string, now: number): void {
    this.assertStep("human-review", "a change request");
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
   * The session's VM was replaced, and with it the agent's conversation: the current agent step starts over on the new
   * VM at `now`, its run ends as `restarted` and a new run of the step begins, whose prompt is to be sent. A step that
   * waits for GitHub has nothing to start over.
   */
  restart(now: number): void {
    if (!this.waitsForAgent) throw new Error(`the step ${this.step} waits for GitHub, not for the agent; nothing to restart`);
    this.changeState(() => this.moveTo(this.step, now, "restarted"));
  }

  /** A person has to approve the pull request before it is merged, from now on. */
  requireHumanReview(): void {
    this.changeState(() => {
      this.humanReview = true;
    });
  }

  /** The people who have to review were asked to on the pull request. */
  noteReviewersNotified(): void {
    this.changeState(() => {
      this.notified = true;
    });
  }

  /** The poller carried out what entering the current review step brings with it, once. */
  noteReviewPrepared(): void {
    this.assertStep("review", "preparing the review");
    this.changeState(() => {
      this.reviewPrepared = true;
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
   * issue back); no prompt sent, no reminder, no merge requested, no review prepared yet.
   */
  private moveTo(step: SwfStep, now: number, outcome: Exclude<RunOutcome, "running"> = "passed", cause?: number): void {
    this.endRun(outcome, now);
    this.step = step;
    this.promptTurn = null;
    this.reminded = false;
    this.mergeSha = null;
    this.reviewPrepared = false;
    const run: Run = { n: this.runs.length + 1, step, startedAt: isoOf(now), endedAt: null, outcome: "running" };
    if (cause !== undefined) run.cause = cause;
    this.runs = [...this.runs, run];
  }

  /** Ends the current run as `outcome` at `now`; a record without a running run (an old one) has nothing to end. */
  private endRun(outcome: Exclude<RunOutcome, "running">, now: number, findings?: number): void {
    const current = runningRun(this.runs);
    if (!current) return;
    const ended: Run = { ...current, endedAt: isoOf(now), outcome };
    if (findings !== undefined) ended.findings = findings;
    this.runs = [...this.runs.slice(0, -1), ended];
  }

  /** Enters implement to fix `findings`; see `sendBackToImplement`. */
  private returnToImplement(findings: string[], now: number): void {
    const attempt = this.attempt + 1;
    const kept = findings.filter((finding) => finding.trim() !== "").slice(0, FINDINGS_LIMIT).map((finding) => finding.slice(0, FINDING_LIMIT));
    const cause = runningRun(this.runs)?.n;
    this.endRun("returned", now, kept.length);
    this.moveTo("implement", now, "passed", cause);
    this.findings = kept;
    this.escalate = attempt > MAX_ATTEMPTS;
    this.attempt = this.escalate ? 0 : attempt;
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
 * The skill of every agent step in `value` (`swf_skills` of `hunt-ctl session-config`), in the order of the steps, or the
 * steps `value` names no skill for (no object, no entry or an empty one); entries of other steps are dropped. Hunt has no
 * default for a step, so a session of a repository whose hunt.json leaves one out cannot start.
 */
export function stepSkills(value: unknown): { skills: Record<AgentStep, string>; missing?: undefined } | { skills?: undefined; missing: AgentStep[] } {
  const named = isRecord(value) ? value : {};
  const missing = AGENT_STEPS.filter((step) => typeof named[step] !== "string" || !named[step]);
  if (missing.length > 0) return { missing };
  return { skills: ZodStepSkills.parse(Object.fromEntries(AGENT_STEPS.map((step) => [step, named[step]]))) };
}

/** `now`, a time in ms, as ISO 8601. */
function isoOf(now: number): string {
  return new Date(now).toISOString();
}

/** The JSON value of `text`; undefined for text that is no JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
