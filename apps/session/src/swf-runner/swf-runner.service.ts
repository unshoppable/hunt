/**
 * The runner of the software factory's agent steps on a session VM (`hunt-swf-runner.service`, `swf-runner.main.ts`):
 * it drives the pipeline (`libs/domain/src/swf/pipeline.domain.ts`) through plan, implement, verify, review and pr, each
 * step one turn of the agent in a fresh conversation, and leaves the steps that wait for GitHub (checks, human-review,
 * merge) and every wait for a person to the gateway's poller (`apps/gateway/src/swf/poller.service.ts`), so that the VM
 * can sleep meanwhile. `.hunt/swf/pipeline.json` of the worktree is the pipeline's primary copy from the moment the
 * poller started the runner; the record comment on the issue mirrors it after every change, and the poller reads it
 * there to take over at checks.
 *
 * `tick` is idempotent and runs whenever the relay's `status.json` or the inbox changed, and every few seconds anyway:
 *
 * 1. The inbox (`hunt-ctl swf-inbox`, `libs/domain/src/swf/swf-inbox.utils.ts`): a `pipeline` message replaces the local
 *    pipeline when it is further (more runs) or when the local one is at a step the poller drives, since the poller owns
 *    those transitions; `answers` wait until they can be sent.
 * 2. Nothing happens while the pipeline ended, waits at a poller step, or the relay serves no session. With the relay
 *    idle the transcript of the current run's conversation is copied to `transcripts/<nn>-<step>.jsonl` (once more for
 *    the run before after the relay restarted for a fresh conversation, when the transcript is complete); a failed copy
 *    is logged and holds nothing up.
 * 3. `result.md`, the step result the agent writes instead of a comment, once its turn ended: a usable one first passes
 *    the step's gate, when its settings name one: every gate check of hunt.json runs in the worktree (its output kept as
 *    `gate/<nn>-<check>.log`) and the working tree must be clean afterwards; on a failure the result is discarded and
 *    goes back to the agent with the failures in the same conversation, past `maxGateRuns` with the request to
 *    escalate. A result that passed moves the pipeline on, becomes `steps/<nn>-<step>.md` and goes to the issue as a
 *    comment, with the step's label and the record; an unusable one is discarded and the agent is told why, in the same
 *    conversation. The plan step's result names the branch the agent created (the VM cloned the default branch): it is
 *    unusable unless the worktree has that branch checked out, and once accepted the branch becomes the session's
 *    (`hunt-ctl set-branch`), so that snapshot, push and the desktop's adoption see it.
 * 4. With the relay idle: the answers waiting go to the agent in the same conversation; a pending step prompt goes into
 *    a fresh conversation (`hunt-ctl clear <id> --keep-stored`, which restarts the relay and reports the new session)
 *    with the step's model and effort as the conversation's config options, which the restarted relay applies; a turn
 *    that ended without a result is looked up on the issue once: the question label means the poller brings the answer,
 *    the failed label that the agent gave up, else the agent is reminded once and the issue is marked as failed the
 *    second time.
 *
 * A Hunt desktop connected to the VM changes nothing: the pipeline runs on so that the desktop watches it live. The
 * restart of the relay for a fresh conversation drops the desktop's connection, and the desktop connects again on its
 * own and loads the new conversation; a prompt the person sends meanwhile lands in the step's conversation.
 */
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Log, LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import type { PromptOutcome } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import type { Pipeline, Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { parseStepResult } from "../../../../libs/domain/src/swf/step-result.utils.ts";
import { stoppedComment } from "../../../../libs/domain/src/swf/swf-comments.utils.ts";
import {
  answerPrompt,
  badResultPrompt,
  gatePrompt,
  nudgePrompt,
  stepPrompt,
  type CommentText,
  type GateFailure,
  type PromptFiles,
} from "../../../../libs/domain/src/swf/swf-prompts.utils.ts";
import { UnusableStepResult } from "../../../../libs/domain/src/swf/unusable-step-result.error.ts";
import { isAgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { SWF_LABEL, WorkflowLabels } from "../../../../libs/domain/src/swf/workflow-labels.value-object.ts";
import type { RunnerGitHub } from "./gh.client.ts";
import type { RelaySessionStatus } from "./relay-status-file.utils.ts";
import type { SwfFiles } from "./swf-dir.client.ts";

export interface RunnerDeps {
  files: SwfFiles;
  github: RunnerGitHub;
  /** The relay's status; null while it serves no session. */
  readStatus(): RelaySessionStatus | null;
  /** Begins a fresh conversation (`sudo -n hunt-ctl clear <id> --keep-stored`) and gives the relay's status once it is ready. */
  clearConversation(): Promise<RelaySessionStatus>;
  /** Sends one prompt into the relay's session and disconnects (`sendPrompt` of `libs/domain/src/relay/relay-prompt.client.ts`). */
  sendPrompt(request: { sessionId: string; cwd: string; text: string }): Promise<PromptOutcome>;
  /**
   * Runs the check `name` of the worktree's hunt.json to its end and gives its exit code (null when a signal ended it)
   * with the tail of its stdout and stderr; a check hunt.json does not declare gives null with the problem as output.
   */
  runCheck(name: string): Promise<{ exitCode: number | null; output: string }>;
  /** The worktree's files that differ from HEAD or are untracked (`git status`), relative to the worktree. */
  changedFiles(): Promise<string[]>;
  /** The branch the worktree has checked out (`git rev-parse --abbrev-ref HEAD`). */
  currentBranch(): Promise<string>;
  /** Records `name` as the session's branch in the VM's metadata (`sudo -n hunt-ctl set-branch <id> <name>`). */
  setBranch(name: string): Promise<void>;
  /** Sets the config options the relay applies at its next start (`configOptions` of `hunt-session.json`) to exactly `options`. */
  setConfigOptions(options: Record<string, string>): void;
  prompts: PromptFiles;
  /** The session's worktree, the cwd of every prompt. */
  worktree: string;
  /** The name of the session's VM, for the comment when the agent stopped. */
  vmName: string;
  /** The current time in ms, the clock of the pipeline's runs. */
  now(): number;
  log: Log;
}

/** The answers of one inbox file, kept until they went to the agent. */
interface WaitingAnswers {
  name: string;
  comments: CommentText[];
}

export class SwfRunner {
  private readonly deps: RunnerDeps;
  private readonly labels = WorkflowLabels.of(SWF_LABEL);
  private isTicking = false;
  private isTickRequested = false;
  private answers: WaitingAnswers[] = [];
  /** Whether the record comment misses the last change, so that the next tick saves it again. */
  private isRecordStale = false;
  /** The `lastTurnEndedAt` whose labels were looked up on the issue, and what they said, so that one turn end costs one request. */
  private lookedUpTurn: number | null = null;
  private lookedUpLabels: string[] = [];
  private lastWait = "";
  private lastError = "";
  private hasWarnedOfMissingRecord = false;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  /** One pass over the state, or another one right after the pass that runs; a failing pass is logged and tried again at the next tick. */
  async tick(): Promise<void> {
    if (this.isTicking) {
      this.isTickRequested = true;
      return;
    }
    this.isTicking = true;
    try {
      do {
        this.isTickRequested = false;
        await this.pass();
        this.lastError = "";
      } while (this.isTickRequested);
    } catch (error) {
      const message = messageOf(error);
      if (message !== this.lastError) {
        this.lastError = message;
        this.deps.log(message, "error");
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async pass(): Promise<void> {
    const pipeline = this.takeInbox(this.deps.files.readPipeline());
    if (!pipeline) {
      this.waitOnce("no pipeline in .hunt/swf yet");
      return;
    }
    if (this.isRecordStale) {
      await this.saveRecord(pipeline);
    }
    const run = pipeline.currentRun;
    if (!run) {
      this.waitOnce(`the pipeline ended at ${pipeline.step}`);
      return;
    }
    if (!pipeline.waitsForAgent) {
      this.waitOnce(`the gateway drives the step ${pipeline.step}`);
      return;
    }
    const status = this.deps.readStatus();
    if (!status) {
      this.waitOnce("the relay serves no session");
      return;
    }
    if (status.turn !== "idle") {
      this.waitOnce(`the agent runs a turn of ${pipeline.step}`);
      return;
    }
    this.keepTranscript(run);
    const result = this.deps.files.readResult();
    if (result !== null) {
      await this.acceptResult(pipeline, result, status);
      return;
    }
    if (this.answers.length > 0) {
      await this.deliverAnswers(pipeline, status);
      return;
    }
    if (pipeline.isPromptPending) {
      await this.sendStepPrompt(pipeline);
      return;
    }
    if (status.lastTurnEndedAt === null || !pipeline.hasTurnEndedSincePrompt(status.lastTurnEndedAt)) {
      this.waitOnce(`the agent works on ${pipeline.step}`);
      return;
    }
    await this.handleTurnWithoutResult(pipeline, status.lastTurnEndedAt);
  }

  /**
   * Reads the inbox: adopts the pipeline the gateway sent when it is further than `local` or `local` is at a poller
   * step, keeps the answers for `deliverAnswers` and removes what is handled or unreadable. Gives the pipeline to go on with.
   */
  private takeInbox(local: Pipeline | null): Pipeline | null {
    let pipeline = local;
    for (const entry of this.deps.files.readInbox()) {
      const { name, message } = entry;
      if (!message) {
        this.deps.log(`ignored ${name} of the inbox, which holds no message`, "warn");
        this.deps.files.removeInboxEntry(name);
        continue;
      }
      if (message.kind === "answers") {
        if (!this.answers.some((waiting) => waiting.name === name)) {
          this.answers.push({ name, comments: message.comments });
        }
        continue;
      }
      const incoming = message.pipeline;
      if (!pipeline || !pipeline.waitsForAgent || incoming.runs.length > pipeline.runs.length) {
        this.deps.files.writePipeline(incoming);
        this.deps.log(`took the pipeline the gateway sent: at ${incoming.step} after ${incoming.runs.length} runs`);
        pipeline = incoming;
        this.lastWait = "";
      } else {
        this.deps.log(`kept the local pipeline at ${pipeline.step}; the gateway's is no further (${incoming.runs.length} runs)`, "debug");
      }
      this.deps.files.removeInboxEntry(name);
    }
    return pipeline;
  }

  /**
   * Moves the pipeline on with the step result in `result.md` once the step's gate passed on it (`passGate`): the file
   * becomes the ended run's `steps/<nn>-<step>.md`, the issue gets the result as a comment, the next step's label and the
   * record; the next pass sends the next prompt. A plan result is usable only when the worktree has the branch it names
   * checked out; accepted, that branch becomes the session's (`setBranch`). An unusable result is discarded and the
   * agent is told why.
   */
  private async acceptResult(pipeline: Pipeline, text: string, status: RelaySessionStatus): Promise<void> {
    const from = pipeline.step;
    const repo = Repository.fromSlug(pipeline.repo);
    const reported = parseStepResult(text);
    const gate = reported?.result?.step === from ? pipeline.gateOf(from) : [];
    if (gate.length > 0 && !(await this.passGate(pipeline, gate, status))) return;
    const branch = reported?.result?.step === "plan" ? reported.result.branch : null;
    try {
      if (branch !== null) {
        const checkedOut = await this.deps.currentBranch();
        if (checkedOut !== branch) throw new UnusableStepResult(`the branch ${branch} of the result is not checked out; the worktree is on ${checkedOut}`);
      }
      pipeline.acceptResult(reported, null, this.deps.now());
    } catch (error) {
      if (!(error instanceof UnusableStepResult)) throw error;
      const outcome = await this.deps.sendPrompt({ sessionId: status.acpSessionId, cwd: this.deps.worktree, text: badResultPrompt(this.deps.prompts.swfBadResult, error.message) });
      this.deps.files.discardResult();
      pipeline.dismissResult(null, status.lastTurnEndedAt ?? 0);
      this.deps.files.writePipeline(pipeline);
      this.deps.log(`the step result of ${from} is unusable (${error.message}); told the agent (prompt ${outcome})`, "warn");
      await this.saveRecord(pipeline);
      return;
    }
    if (branch !== null) await this.deps.setBranch(branch);
    const ended = pipeline.lastEndedRun;
    if (ended) {
      this.deps.files.keepResult(ended);
    } else {
      this.deps.files.discardResult();
    }
    this.deps.files.writePipeline(pipeline);
    this.lastWait = "";
    this.deps.log(`the agent reported the step ${from}; the pipeline goes on with ${pipeline.step}`);
    this.isRecordStale = true;
    await this.deps.github.comment(repo, pipeline.issue, text);
    await this.relabel(repo, pipeline);
    await this.saveRecord(pipeline);
    this.isTickRequested = true;
  }

  /**
   * Runs the gate `gate` of the current step on its result: each check in turn, all of them, then whether the working
   * tree is clean. True when everything passed; else the result is discarded and goes back to the agent with the
   * failures in the same conversation, the failure counted on the pipeline, and false.
   */
  private async passGate(pipeline: Pipeline, gate: string[], status: RelaySessionStatus): Promise<boolean> {
    const step = pipeline.step;
    const run = pipeline.currentRun;
    if (!run) throw new Error(`the pipeline has no running step to gate at ${step}`);
    const failures: GateFailure[] = [];
    for (const name of gate) {
      const { exitCode, output } = await this.deps.runCheck(name);
      this.deps.files.keepGateLog(run, name, output);
      this.deps.log(`the check ${name} of the gate of ${step} ended with ${exitCode === null ? "no exit code" : `exit ${exitCode}`}`, "debug");
      if (exitCode !== 0) failures.push({ name, exitCode, output });
    }
    const dirty = await this.deps.changedFiles();
    if (dirty.length > 0) failures.push({ name: "working tree", exitCode: 0, output: "", dirty });
    if (failures.length === 0) {
      this.deps.log(`the gate of ${step} passed (${gate.join(", ")})`);
      return true;
    }
    pipeline.noteGateFailure(status.lastTurnEndedAt ?? 0);
    const text = gatePrompt(this.deps.prompts, this.labels, pipeline, failures);
    const outcome = await this.deps.sendPrompt({ sessionId: status.acpSessionId, cwd: this.deps.worktree, text });
    this.deps.files.discardResult();
    this.deps.files.writePipeline(pipeline);
    this.lastWait = "";
    const failed = failures.map((failure) => (failure.dirty ? "a dirty working tree" : failure.name)).join(", ");
    const told = pipeline.gateEscalates ? "asked the agent to escalate" : "gave the result back to the agent";
    this.deps.log(`the gate of ${step} failed (${failed}; gate run ${pipeline.gateRuns} of ${pipeline.settings.maxGateRuns}); ${told} (prompt ${outcome})`, "warn");
    await this.saveRecord(pipeline);
    return false;
  }

  /** Sends the answers waiting in the inbox to the agent in its conversation; each file's once. */
  private async deliverAnswers(pipeline: Pipeline, status: RelaySessionStatus): Promise<void> {
    const repo = Repository.fromSlug(pipeline.repo);
    const waiting = this.answers.splice(0);
    const comments = waiting.flatMap((entry) => entry.comments);
    const text = answerPrompt(this.deps.prompts.swfAnswer, repo, comments, this.labels, pipeline);
    const outcome = await this.deps.sendPrompt({ sessionId: status.acpSessionId, cwd: this.deps.worktree, text });
    for (const entry of waiting) {
      this.deps.files.removeInboxEntry(entry.name);
    }
    pipeline.noteAnswersDelivered(status.lastTurnEndedAt ?? 0);
    this.deps.files.writePipeline(pipeline);
    this.lookedUpTurn = null;
    this.lastWait = "";
    this.deps.log(`${comments.length === 1 ? "an answer" : `${comments.length} answers`} from the issue went to the agent (prompt ${outcome})`);
    await this.saveRecord(pipeline);
  }

  /**
   * Begins a fresh conversation with the current step's config options, replacing those of the previous step or a
   * desktop's pick, and sends it the prompt of the step, with the issue as it stands.
   */
  private async sendStepPrompt(pipeline: Pipeline): Promise<void> {
    const repo = Repository.fromSlug(pipeline.repo);
    const thread = await this.deps.github.issue(repo, pipeline.issue);
    const text = stepPrompt(this.deps.prompts, repo, thread.issue, thread.comments, this.labels, pipeline);
    const options = isAgentStep(pipeline.step) ? pipeline.configOptionsOf(pipeline.step) : {};
    this.deps.setConfigOptions(options);
    if (Object.keys(options).length > 0) {
      this.deps.log(`the conversation of ${pipeline.step} runs with ${Object.entries(options).map(([key, value]) => `${key} ${value}`).join(", ")}`);
    }
    const status = await this.deps.clearConversation();
    // The relay that stopped for the fresh conversation wrote the previous run's transcript to its end.
    const previous = pipeline.lastEndedRun;
    if (previous) this.keepTranscript(previous);
    const outcome = await this.deps.sendPrompt({ sessionId: status.acpSessionId, cwd: this.deps.worktree, text });
    pipeline.recordPrompt(status.lastTurnEndedAt ?? 0, status.acpSessionId);
    this.deps.files.writePipeline(pipeline);
    this.lookedUpTurn = null;
    this.lastWait = "";
    this.deps.log(`sent the prompt of the step ${pipeline.step}${pipeline.escalate ? " (escalation)" : ""} in a fresh conversation (prompt ${outcome})`);
    await this.saveRecord(pipeline);
  }

  /**
   * The agent's turn ended at `lastTurnEndedAt` without a result: the issue's labels, read once per turn, say whether it
   * asked a question (the poller brings the answer) or gave up; else the agent is reminded once and the issue is marked
   * as failed the second time.
   */
  private async handleTurnWithoutResult(pipeline: Pipeline, lastTurnEndedAt: number): Promise<void> {
    const repo = Repository.fromSlug(pipeline.repo);
    if (this.lookedUpTurn !== lastTurnEndedAt) {
      this.lookedUpLabels = await this.deps.github.labels(repo, pipeline.issue);
      this.lookedUpTurn = lastTurnEndedAt;
    }
    if (this.lookedUpLabels.includes(this.labels.question)) {
      this.waitOnce(`the agent asked a question at ${pipeline.step}; the gateway brings the answer`);
      return;
    }
    if (this.lookedUpLabels.includes(this.labels.failed)) {
      pipeline.fail(this.deps.now());
      this.deps.files.writePipeline(pipeline);
      this.deps.log(`the agent gave up at ${pipeline.step}; the issue is marked as failed`, "warn");
      await this.saveRecord(pipeline);
      return;
    }
    if (!pipeline.reminded) {
      const text = nudgePrompt(this.deps.prompts.swfNudge, repo, this.labels, pipeline);
      const outcome = await this.deps.sendPrompt({ sessionId: (await this.requireStatus()).acpSessionId, cwd: this.deps.worktree, text });
      pipeline.remind(lastTurnEndedAt);
      this.deps.files.writePipeline(pipeline);
      this.deps.log(`the agent ended its turn without a result for ${pipeline.step}; reminded it (prompt ${outcome})`);
      await this.saveRecord(pipeline);
      return;
    }
    const step = pipeline.step;
    pipeline.fail(this.deps.now());
    this.deps.files.writePipeline(pipeline);
    this.deps.log(`the agent ended its turn again without a result for ${step}; marking the issue as failed`, "warn");
    this.isRecordStale = true;
    await this.deps.github.editLabels(repo, pipeline.issue, [this.labels.failed], this.labels.carriedBy({ labels: this.lookedUpLabels }));
    await this.deps.github.comment(repo, pipeline.issue, stoppedComment(step, this.deps.vmName));
    await this.saveRecord(pipeline);
  }

  /** Copies the transcript of `run` (`SwfFiles.keepTranscript`); a failure is logged, since the pipeline goes on without it. */
  private keepTranscript(run: Run): void {
    try {
      this.deps.files.keepTranscript(run);
    } catch (error) {
      this.deps.log(`failed to keep the transcript of run ${run.n}: ${messageOf(error)}`, "warn");
    }
  }

  /** The relay's status for a prompt into the running conversation; throws when the relay went away meanwhile. */
  private async requireStatus(): Promise<RelaySessionStatus> {
    const status = this.deps.readStatus();
    if (!status) throw new Error("the relay serves no session");
    return status;
  }

  /** Gives the issue the label of the pipeline's step and takes every other label of the workflow off, as the poller does. */
  private async relabel(repo: Repository, pipeline: Pipeline): Promise<void> {
    const target = this.labels.step(pipeline.step);
    const current = await this.deps.github.labels(repo, pipeline.issue);
    const remove = this.labels.carriedBy({ labels: current }).filter((label) => label !== target);
    await this.deps.github.editLabels(repo, pipeline.issue, current.includes(target) ? [] : [target], remove);
  }

  /** Writes the pipeline into its record comment on the issue; without one (the poller posts it) the change waits for the next save. */
  private async saveRecord(pipeline: Pipeline): Promise<void> {
    if (pipeline.recordId === 0) {
      this.isRecordStale = true;
      if (!this.hasWarnedOfMissingRecord) {
        this.hasWarnedOfMissingRecord = true;
        this.deps.log("the pipeline names no record comment; the issue misses its state until the gateway sends a pipeline with one", "warn");
      }
      return;
    }
    try {
      await this.deps.github.editComment(Repository.fromSlug(pipeline.repo), pipeline.recordId, pipeline.toComment());
      this.isRecordStale = false;
    } catch (error) {
      this.isRecordStale = true;
      throw new Error(`failed to save the record comment ${pipeline.recordId}: ${messageOf(error)}`);
    }
  }

  /** Logs `reason` once while it lasts. */
  private waitOnce(reason: string, level: LogLevel = "info"): void {
    if (this.lastWait === reason) return;
    this.lastWait = reason;
    this.deps.log(reason, level);
  }
}
