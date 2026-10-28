/**
 * The poller of hunt-swf (`swf/swf.main.ts` runs its `cycle()` at every poll): starts a remote session for every open
 * GitHub issue with the label `swf` in the repositories the gateway's instance metadata lists (`swf/swf-config.utils.ts`)
 * and drives each session through the steps of its pipeline (`swf/pipeline.domain.ts`) until the pull request is merged.
 *
 * Per issue, as long as fewer than `maxSessions` of its VMs (label `hunt-origin=swf`) are up (`swf/session-slots.utils.ts`):
 * claim the issue first (label `swf` → `swf:plan`, the issue's status in every project it belongs to →
 * IN_PROGRESS_STATUS), then do what a handoff of the desktop does (`apps/client/src-tauri/src/remote/handoff.rs`), with
 * a clone from GitHub in place of the push: the session VM service
 * (`session-vm/session-vm.service.ts`) creates the session VM from the instance template, records the session in its
 * metadata, waits for its startup script and installs the session release staged on the gateway; then `install-tools`,
 * `clone` (onto the branch of `swf/session-branch.utils.ts`), the repository's private files (the ignored files a
 * handoff copies, such as `.env.private`) from the secret `HUNT_SWF_FILES_<owner>_<repo>` (`swf/private-files.utils.ts`)
 * through `put-files`, `session-config` (which also reports the repository's `swf.humanReviewPaths` and `swf.skills`;
 * the pipeline record then goes onto the issue as a comment of the poller (`swf/pipeline-record.client.ts`), and a
 * hunt.json that names no skill for an agent step fails the setup, since Hunt has no default skill),
 * `hunt-session.json` with the model the repository's hunt.json sets (`swf.model`) through `put-files --claude`, `deps`,
 * `start` with the tokens on stdin and `wait`. The session's system prompt holds the protocol of the steps
 * (`software-factory/0-system-prompt.md`); then the issue goes to the agent as the prompt of the first step, `plan`,
 * through the relay (`swf/swf-prompts.utils.ts`). When the setup fails, the poller sets `swf:failed` with the error and
 * leaves the VM for inspection; Hunt desktops adopt the VM either way.
 *
 * Every poll also drives the pipeline of each session VM (`watchSession`): the issue's labels give the agent's state
 * (the step, `question`, `done`, `failed`; `libs/domain/src/swf/workflow-labels.value-object.ts`), which the VM's
 * metadata `hunt-agent` records for Hunt's lists, and the poller's record comment holds the pipeline's state. Each poll
 * loads the pipeline from it, applies an intent of `Pipeline` and saves it back once the GitHub calls that go with the
 * intent are done. At an agent step (plan, implement, verify, gate, pr) the poller sends the step's prompt once the relay is
 * idle (`swf/relay-status.utils.ts`), then waits for the agent's step result, a comment with `<!-- hunt:step {…} -->`
 * (`libs/domain/src/swf/step-result.utils.ts`); the result moves the issue to the next step's label (`acceptResult`),
 * and findings of verify send it back to implement. A turn that ends without a result gets one reminder (`nudgePrompt`);
 * when the next turn ends the same way, the issue is marked as failed. At a poller step the poller watches the pull
 * request: `review` waits for its checks and the Claude review's verdict (a failing check or blocking findings go back
 * to implement), `human-review` for a person's approval (a change request goes back to implement) and `merge` updates
 * the branch when it is behind and squash-merges it; then the issue gets `swf:done` and moves to DONE_STATUS in its
 * projects. These steps need GitHub only, so they go on while the idle sweeper keeps the session's VM suspended. While
 * the issue is labelled `swf:question`, the poller watches it for the answer: a comment by someone other than the app's
 * bot user after the agent's question (`newAnswers` in `swf/issue-thread.utils.ts`) goes to the agent as a prompt
 * (`answerPrompt`), which tells it to take the label back to the step; a VM that stopped meanwhile, or one whose step
 * has a prompt pending, is started first through the session VM service. An answer given in a Hunt desktop needs none
 * of this: the agent takes the label back itself. No prompt goes to a session a Hunt desktop is connected to, since a
 * person is working with the agent there. Delivered answers are remembered only in memory: after a restart of the
 * poller a session may get an answer a second time. What the poller comments on GitHub is `swf/swf-comments.utils.ts`.
 *
 * On GitHub the poller and its sessions act as a GitHub App (`swf/github-app.client.ts`). The app's installation tokens
 * are valid for one hour and limited to one repository each: a session's clone, its commits (with the app's bot
 * identity) and its relay get the current one, and every poll hands a renewed token to each running session VM
 * (`hunt-ctl github-token`), so git, Git LFS and `gh` there keep working without a relay restart. One log line per
 * decision, Compute Engine call and command on a session VM goes to the log; tokens and the key never appear in logs or
 * comments (`swf/redaction.utils.ts`). `drain` waits for the setups in progress, `abort` marks their issues as failed.
 */
import type { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import type { PullRequestState } from "../../../../libs/domain/src/swf/pull-request-state.value-object.ts";
import { ReviewVerdict } from "../../../../libs/domain/src/swf/review-verdict.value-object.ts";
import { parseStepResult } from "../../../../libs/domain/src/swf/step-result.utils.ts";
import type { AgentState, SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { WorkflowLabels } from "../../../../libs/domain/src/swf/workflow-labels.value-object.ts";
import type { Compute, Instance } from "../gcp/compute-engine.client.ts";
import type { OptionalSecret } from "../gcp/secret-manager.client.ts";
import type { Transport } from "../session-vm/relay.client.ts";
import type { SessionVmSsh } from "../session-vm/session-vm-ssh.client.ts";
import { AGENT_METADATA, ORIGIN_LABEL, SessionVm } from "../session-vm/session-vm.domain.ts";
import { DEFAULT_TEMPLATE, SILENT, type Origin, type Reporter, type SessionVmService } from "../session-vm/session-vm.service.ts";
import type { AppCredentials, GitHubApp } from "./github-app.client.ts";
import type { GitHub, Issue, IssueComment } from "./github.client.ts";
import { matchingFiles } from "./glob.utils.ts";
import { mentionsOf, newAnswers, newStepResults } from "./issue-thread.utils.ts";
import { PipelineRecordClient } from "./pipeline-record.client.ts";
import { Pipeline, stepSkills } from "./pipeline.domain.ts";
import { checkPrivateFilesArchive, privateFilesSecret } from "./private-files.utils.ts";
import { redact } from "./redaction.utils.ts";
import { relayStatus } from "./relay-status.utils.ts";
import { branchName } from "./session-branch.utils.ts";
import { activeSessionVms, issuesToStart } from "./session-slots.utils.ts";
import {
  changeRequestFinding,
  closedComment,
  failureComment,
  humanReviewComment,
  mergedComment,
  missingPullRequestComment,
  missingSkillsError,
  noPullRequestComment,
  stoppedComment,
} from "./swf-comments.utils.ts";
import { REPOS_ATTRIBUTE, SWF_LABEL, type SwfConfig } from "./swf-config.utils.ts";
import {
  answerPrompt,
  badResultPrompt,
  huntSessionFile,
  nudgePrompt,
  remoteSystemPrompt,
  stepPrompt,
  swfSystemPrompt,
  type PromptFiles,
} from "./swf-prompts.utils.ts";
import { UnusableStepResult } from "./unusable-step-result.error.ts";

export const ORIGIN: Origin = "swf";
/** The `Status` option a claimed issue gets in every project (Projects v2) it is an item of; matched case-insensitively. */
export const IN_PROGRESS_STATUS = "In Progress";
/** The `Status` options the issue gets in its projects (Projects v2) when the pull request opens and when it is merged. */
export const IN_REVIEW_STATUS = "In Review";
export const DONE_STATUS = "Done";
/** The label of a pull request that needs a human's approval before Hunt merges it. */
export const HUMAN_REVIEW_PR_LABEL = "hunt:human-review";
/** The pull request label that asks a person to review, created in the repository when missing. */
const HUMAN_REVIEW_LABEL_SPEC = {
  name: HUMAN_REVIEW_PR_LABEL,
  color: "e99695",
  description: "A person has to approve this pull request before Hunt merges it",
};

/** The secrets the poller runs with: the Claude Code OAuth token of its sessions and the GitHub App's credentials. */
export interface Secrets {
  claude: string;
  app: AppCredentials;
}

export interface PollerDeps {
  /** The configuration from the gateway's instance metadata. Throws for invalid attributes. */
  readConfig(): Promise<SwfConfig>;
  /** The preview domain of the gateway's edge proxy. Throws without one. */
  readDomain(): string;
  secrets(): Promise<Secrets>;
  /** The latest version of the optional secret `name` as bytes, or why there is none. */
  secretBytes(name: string): Promise<OptionalSecret>;
  github: GitHub;
  /** The GitHub App's tokens and identity; its token cache outlives a poll. */
  githubApp: GitHubApp;
  compute: Compute;
  sessionVmService: SessionVmService;
  vm(name: string, zone: string): SessionVmSsh;
  prompts(): PromptFiles;
  sendPrompt(transport: Transport, request: { sessionId: string; cwd: string; text: string }): Promise<string>;
  newId(): string;
  log(message: string, level?: LogLevel): void;
}

/** A session the poller is setting up: enough to mark its issue as failed when the poller has to stop. */
interface Setup {
  key: string;
  repo: Repository;
  issue: number;
  labels: WorkflowLabels;
  sessionId: SessionId;
  isVmCreated: boolean;
  /** The id of the record comment on the issue; 0 until it was created. */
  recordId: number;
  done: Promise<void>;
}

/** What the poller remembers about a session between polls; everything that matters survives in the record comment. */
interface Watched {
  /** The last error of following the session, so that a lasting one is logged once. */
  error: string;
  /** The GitHub token the poller last gave the VM; empty until it gave one or since the VM stopped. */
  token: string;
  /** `createdAt` of the last answer comment delivered to the agent; empty until one was. */
  answeredAt: string;
  /** The last error of starting the VM, so that a lasting one is logged once. */
  startError: string;
  /** The last reason the pipeline waits, so that a lasting one is logged once. */
  waiting: string;
}

/** Everything one poll of a session's pipeline works with. */
interface SessionContext {
  key: string;
  github: GitHub;
  labels: WorkflowLabels;
  sessionVm: SessionVm;
  sessionId: SessionId;
  repo: Repository;
  issue: Issue;
  comments: IssueComment[];
  bot: string;
  /** The id of the record comment that holds `pipeline`. */
  recordId: number;
  pipeline: Pipeline;
  watched: Watched;
}

/** One poll after another; see the module comment. */
export class Poller {
  private readonly deps: PollerDeps;
  private readonly records: PipelineRecordClient;
  /** Setups in progress by VM name; they count towards the limit until Compute Engine lists their VM. */
  private readonly setups = new Map<string, Setup>();
  /** The sessions the poller follows, by VM name. */
  private readonly watched = new Map<string, Watched>();
  /** The VMs the poller is starting for a pending prompt, by VM name. */
  private readonly starts = new Set<string>();
  /** Repositories whose labels exist, by `<repo> <label>`. */
  private readonly labelledRepos = new Set<string>();
  private lastNote = "";
  /** The last error of each repository whose issues could not be listed, so that a lasting one is logged once. */
  private readonly repoErrors = new Map<string, string>();
  /** The Claude Code token last read, for redaction. */
  private claudeToken = "";

  constructor(deps: PollerDeps) {
    this.deps = deps;
    this.records = new PipelineRecordClient(deps.github);
  }

  /** Logs `message` unless it is the same as the last note, so a state that lasts is reported once. */
  private note(message: string, level: LogLevel = "info"): void {
    if (message === this.lastNote) return;
    this.lastNote = message;
    this.deps.log(message, level);
  }

  private redacted(error: unknown): string {
    return redact(messageOf(error), [this.claudeToken, ...this.deps.githubApp.secrets()]);
  }

  /** One poll: claims the issues that get a session now and starts their setups in the background. */
  async cycle(): Promise<void> {
    let config: SwfConfig;
    let domain: string;
    try {
      config = await this.deps.readConfig();
      if (config.repos.length === 0) {
        this.note(`idle: the instance metadata ${REPOS_ATTRIBUTE} lists no repositories`);
        return;
      }
      domain = this.deps.readDomain();
    } catch (error) {
      this.note(`idle: ${this.redacted(error)}`, "error");
      return;
    }
    let secrets: Secrets;
    let vms: Instance[];
    try {
      secrets = await this.deps.secrets();
      this.claudeToken = secrets.claude;
      vms = await this.deps.compute.listByLabel(ORIGIN_LABEL, ORIGIN);
    } catch (error) {
      this.note(`poll failed: ${this.redacted(error)}`, "error");
      return;
    }
    const github = this.deps.github;
    const labels = WorkflowLabels.of(SWF_LABEL);
    await this.watchSessions(github, labels, vms);
    const active = activeSessionVms(vms, this.setups.keys());
    const issuesByRepo: { repo: Repository; issues: Issue[] }[] = [];
    for (const repo of config.repos) {
      try {
        issuesByRepo.push({ repo, issues: await github.openIssues(repo, labels.requested) });
        this.repoErrors.delete(repo.slug);
      } catch (error) {
        const message = this.redacted(error);
        if (this.repoErrors.get(repo.slug) !== message) {
          this.deps.log(`${repo.slug}: ${message}`, "error");
        }
        this.repoErrors.set(repo.slug, message);
      }
    }
    const { start, waiting } = issuesToStart(issuesByRepo, config.maxSessions - active.size);
    if (waiting.length > 0) {
      const keys = waiting.map(({ repo, issue }) => `${repo.slug}#${issue.number}`).join(", ");
      this.note(`waiting: ${keys}; ${active.size} of ${config.maxSessions} sessions are up`);
    } else if (start.length === 0) {
      this.note(`polling ${config.repos.map((repo) => repo.slug).join(", ")}: no open issues labelled ${labels.requested}`);
    }
    for (const { repo, issue } of start) {
      await this.claimAndStart(domain, secrets.claude, github, labels, repo, issue);
    }
  }

  /**
   * Hands every running session VM that is not being set up the current GitHub token of its repository when it
   * changed, and drives its pipeline; the poller steps of a stopped VM's session go on without the VM, and a stopped VM
   * whose agent has a prompt pending (an answer, or the next step) is started. A failure with one VM is logged once.
   */
  private async watchSessions(github: GitHub, labels: WorkflowLabels, vms: Instance[]): Promise<void> {
    const listed = new Set<string>();
    for (const instance of vms) {
      const sessionVm = SessionVm.fromInstance(instance);
      const sessionId = sessionVm?.sessionId;
      const issue = sessionVm?.issue ?? null;
      if (!sessionVm || !sessionId || issue === null || this.setups.has(sessionVm.name)) continue;
      listed.add(sessionVm.name);
      const watched = this.watched.get(sessionVm.name) ?? { error: "", token: "", answeredAt: "", startError: "", waiting: "" };
      this.watched.set(sessionVm.name, watched);
      try {
        if (sessionVm.isRunning) {
          await this.watchSession(github, labels, sessionVm, sessionId, Repository.fromSlug(sessionVm.repo), issue, watched);
        } else {
          watched.token = "";
          if (sessionVm.isOff && !this.starts.has(sessionVm.name)) {
            await this.watchStoppedSession(github, labels, sessionVm, sessionId, Repository.fromSlug(sessionVm.repo), issue, watched);
          }
        }
        watched.error = "";
      } catch (error) {
        const message = this.redacted(error);
        if (watched.error !== message) {
          this.deps.log(`${sessionVm.repo}#${issue}: ${message}`, "error");
        }
        watched.error = message;
      }
    }
    for (const vm of this.watched.keys()) {
      if (!listed.has(vm)) {
        this.watched.delete(vm);
      }
    }
  }

  /** The issue, its comments, the bot's login and the pipeline; null when the session has none to drive. */
  private async loadContext(
    github: GitHub,
    labels: WorkflowLabels,
    sessionVm: SessionVm,
    sessionId: SessionId,
    repo: Repository,
    issueNumber: number,
    watched: Watched,
  ): Promise<{ context: SessionContext; state: SwfStep | "question" } | null> {
    const key = `${repo.slug}#${issueNumber}`;
    const issue = await github.issue(repo, issueNumber);
    const state: AgentState | null = labels.agentStateOf(issue);
    if (state !== null && sessionVm.agent !== state) {
      await this.deps.sessionVmService.recordSession(sessionVm.zone, sessionId, { [AGENT_METADATA]: state });
      this.deps.log(`${key}: the agent is ${state}`);
    }
    if (!issue || state === "done" || state === "failed") return null;
    const comments = await github.comments(repo, issueNumber);
    const bot = (await this.deps.githubApp.identity()).name;
    const found = await this.records.find(repo, issueNumber, bot, comments);
    if (!found) {
      this.waitOnce(watched, key, "the issue has no pipeline record comment of the poller; the session predates the pipeline and is left alone", "warn");
      return null;
    }
    const { commentId: recordId, pipeline } = found;
    const context: SessionContext = { key, github, labels, sessionVm, sessionId, repo, issue, comments, bot, recordId, pipeline, watched };
    if (state === null) {
      // A label lost on the way, or taken off by a person: the record knows the step.
      this.deps.log(`${key}: the issue carries no label of the workflow; setting ${labels.step(pipeline.step)} from the pipeline record`, "warn");
      await this.relabel(context, pipeline.step);
      return { context, state: pipeline.step };
    }
    return { context, state };
  }

  /** Logs `reason` once while it lasts. */
  private waitOnce(watched: Watched, key: string, reason: string, level: LogLevel = "info"): void {
    if (watched.waiting === reason) return;
    watched.waiting = reason;
    this.deps.log(`${key}: ${reason}`, level);
  }

  /**
   * Gives the VM the repository's GitHub token unless it has it, records the agent's state in the VM and drives the
   * pipeline: delivers an answer while the issue is labelled question, else runs the current step. See the module comment.
   */
  private async watchSession(
    github: GitHub,
    labels: WorkflowLabels,
    sessionVm: SessionVm,
    sessionId: SessionId,
    repo: Repository,
    issueNumber: number,
    watched: Watched,
  ): Promise<void> {
    const key = `${repo.slug}#${issueNumber}`;
    const token = await this.deps.githubApp.tokenFor(repo);
    if (token !== watched.token) {
      await this.deps.vm(sessionVm.name, sessionVm.zone).huntCtl(["github-token", sessionId.id], `${token}\n`);
      watched.token = token;
      this.deps.log(`${key}: gave the VM a fresh GitHub token`);
    }
    const loaded = await this.loadContext(github, labels, sessionVm, sessionId, repo, issueNumber, watched);
    if (!loaded) return;
    const { context, state } = loaded;
    if (state === "question") {
      await this.deliverAnswer(context);
      return;
    }
    if (state !== context.pipeline.step) {
      // The agent moved the label back after a question, or a person moved it: the record is the pipeline's truth.
      this.deps.log(`${key}: the issue is labelled ${labels.step(state)} but the pipeline is at ${context.pipeline.step}; relabelling`, "warn");
      await this.relabel(context, context.pipeline.step);
    }
    if (context.pipeline.waitsForAgent) {
      await this.driveAgentStep(context);
    } else {
      await this.drivePollerStep(context);
    }
  }

  /**
   * An agent step: acts on a new step result (the next step, or back to implement), else sends the step's prompt when
   * none was sent, else reminds an agent whose turn ended without a result once and fails the issue the second time.
   */
  private async driveAgentStep(context: SessionContext): Promise<void> {
    const { key, repo, recordId, issue, comments, bot, pipeline, labels, sessionVm, sessionId } = context;
    const results = newStepResults(comments, bot, pipeline.lastResultId);
    const vm = this.deps.vm(sessionVm.name, sessionVm.zone);
    if (results.length > 0) {
      const last = results[results.length - 1];
      const step = pipeline.step;
      try {
        pipeline.acceptResult(parseStepResult(last.body), last.id);
      } catch (error) {
        if (!(error instanceof UnusableStepResult)) throw error;
        await this.dismissResult(context, vm, last.id, error.message);
        return;
      }
      this.deps.log(`${key}: the agent reported the step ${step}; the pipeline goes on with ${pipeline.step}`);
      await this.enterStep(context, step);
      return;
    }
    const status = relayStatus(await vm.huntCtl(["status", sessionId.id]));
    if (!status || status.turn !== "idle" || status.clientConnected) return;
    if (pipeline.isPromptPending) {
      const text = stepPrompt(this.deps.prompts(), repo, issue, comments, sessionVm.branch, labels, pipeline);
      const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: status.worktree, text });
      pipeline.recordPrompt(status.lastTurnEndedAt ?? 0);
      await this.records.save(repo, recordId, pipeline);
      this.deps.log(`${key}: sent the prompt of the step ${pipeline.step}${pipeline.escalate ? " (escalation)" : ""} (prompt ${outcome})`);
      return;
    }
    const lastTurnEndedAt = status.lastTurnEndedAt;
    if (lastTurnEndedAt === null || !pipeline.hasTurnEndedSincePrompt(lastTurnEndedAt)) return;
    if (!pipeline.reminded) {
      const text = nudgePrompt(this.deps.prompts().swfNudge, repo, issue.number, labels, pipeline.step);
      const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: status.worktree, text });
      pipeline.remind(lastTurnEndedAt);
      await this.records.save(repo, recordId, pipeline);
      this.deps.log(`${key}: the agent ended its turn without a result for ${pipeline.step}; reminded it (prompt ${outcome})`);
      return;
    }
    this.deps.log(`${key}: the agent ended its turn again without a result for ${pipeline.step}; marking the issue as failed`, "warn");
    await this.failIssue(key, context.github, repo, issue.number, labels, pipeline.step, stoppedComment(pipeline.step, sessionVm.name));
  }

  /**
   * Tells the agent on `vm`, once its relay is idle and no desktop is connected, why the step result in the comment
   * `resultId` is unusable (`problem`); the pipeline stays at its step.
   */
  private async dismissResult(context: SessionContext, vm: SessionVmSsh, resultId: number, problem: string): Promise<void> {
    const { key, repo, recordId, pipeline, sessionId } = context;
    const status = relayStatus(await vm.huntCtl(["status", sessionId.id]));
    if (!status || status.turn !== "idle" || status.clientConnected) return;
    const text = badResultPrompt(this.deps.prompts().swfBadResult, problem);
    const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: status.worktree, text });
    pipeline.dismissResult(resultId, status.lastTurnEndedAt ?? 0);
    await this.records.save(repo, recordId, pipeline);
    this.deps.log(`${key}: the step result of ${pipeline.step} is unusable (${problem}); told the agent (prompt ${outcome})`, "warn");
  }

  /** A poller step: review, human-review or merge, from the state of the pull request. */
  private async drivePollerStep(context: SessionContext): Promise<void> {
    const { key, github, repo, recordId, issue, labels, pipeline, watched, bot } = context;
    const step = pipeline.step;
    if (pipeline.pullRequest === null) {
      await this.failIssue(key, github, repo, issue.number, labels, step, noPullRequestComment());
      return;
    }
    const pullRequest = await github.pullRequest(repo, pipeline.pullRequest);
    if (!pullRequest) {
      await this.failIssue(key, github, repo, issue.number, labels, step, missingPullRequestComment(pipeline.pullRequest));
      return;
    }
    if (pullRequest.isMerged) {
      await this.finish(context, pullRequest);
      return;
    }
    if (pullRequest.isClosed) {
      await this.failIssue(key, github, repo, issue.number, labels, step, closedComment(pullRequest.number));
      return;
    }
    switch (step) {
      case "review": {
        const outcome = pullRequest.reviewOutcome(ReviewVerdict.latestIn(await github.comments(repo, pullRequest.number)));
        if (outcome.kind === "wait") {
          this.waitOnce(watched, key, `review: ${outcome.reason}`);
        } else if (outcome.kind === "fix") {
          this.deps.log(`${key}: the review of #${pullRequest.number} found something; back to implement`);
          pipeline.sendBackToImplement(outcome.findings);
          await this.enterStep(context, step);
        } else if (outcome.kind === "clean") {
          pipeline.passReview();
          this.deps.log(`${key}: #${pullRequest.number} passed its checks and the Claude review; the pipeline goes on with ${pipeline.step}`);
          await this.enterStep(context, step);
        }
        return;
      }
      case "human-review": {
        const outcome = pipeline.humanReviewOutcome(await github.reviews(repo, pullRequest.number), bot);
        if (outcome.kind === "wait") {
          this.waitOnce(watched, key, `human-review: waiting for a person to approve #${pullRequest.number}`);
        } else if (outcome.kind === "changes") {
          const inline = await github.reviewComments(repo, pullRequest.number, outcome.review.id);
          const finding = changeRequestFinding(pullRequest.number, outcome.review, inline);
          this.deps.log(`${key}: ${outcome.review.author} requested changes on #${pullRequest.number}; back to implement`);
          pipeline.handleChangeRequest(outcome.review.id, finding);
          await this.enterStep(context, step);
        } else {
          this.deps.log(`${key}: #${pullRequest.number} was approved by ${outcome.by.join(", ")}; the pipeline goes on with merge`);
          pipeline.approve();
          await this.enterStep(context, step);
        }
        return;
      }
      case "merge": {
        const outcome = pullRequest.mergeOutcome(pipeline.mergeSha);
        if (outcome.kind === "wait") {
          this.waitOnce(watched, key, `merge: ${outcome.reason}`);
        } else if (outcome.kind === "update") {
          await github.updateBranch(repo, pullRequest.number);
          pipeline.noteMergeRequested(pullRequest.headSha);
          await this.records.save(repo, recordId, pipeline);
          this.deps.log(`${key}: #${pullRequest.number} is behind its base; updating the branch`);
        } else if (outcome.kind === "merge") {
          await github.merge(repo, pullRequest.number);
          pipeline.noteMergeRequested(pullRequest.headSha);
          await this.records.save(repo, recordId, pipeline);
          this.deps.log(`${key}: merged #${pullRequest.number}`);
        } else if (outcome.kind === "fix") {
          this.deps.log(`${key}: #${pullRequest.number} conflicts with its base; back to implement`);
          pipeline.sendBackToImplement(outcome.findings);
          await this.enterStep(context, step);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Carries out on GitHub what the pipeline's move from the step `from` to its current one brings with it, then saves
   * it: the issue's label; the first review moves the issue to IN_REVIEW_STATUS; every review checks the pull request's
   * files against the repository's `humanReviewPaths` and, when a person has to review, labels the pull request and
   * mentions the people once.
   */
  private async enterStep(context: SessionContext, from: SwfStep): Promise<void> {
    const { key, github, repo, recordId, issue, pipeline, watched } = context;
    if (pipeline.step === "review" && pipeline.pullRequest !== null) {
      if (from === "pr") {
        await this.moveToStatus(github, key, repo, issue.number, IN_REVIEW_STATUS);
      }
      if (!pipeline.humanReview && pipeline.humanReviewPaths.length > 0) {
        const matched = matchingFiles(await github.pullRequestFiles(repo, pipeline.pullRequest), pipeline.humanReviewPaths);
        if (matched.length > 0) {
          const files = `${matched.slice(0, 5).join(", ")}${matched.length > 5 ? ", …" : ""}`;
          this.deps.log(`${key}: #${pipeline.pullRequest} changes ${files}, which always needs a person`);
          pipeline.requireHumanReview();
        }
      }
      if (pipeline.humanReview) {
        await this.askForHumanReview(context, pipeline.pullRequest);
        pipeline.noteReviewersNotified();
      }
    }
    await this.relabel(context, pipeline.step);
    await this.records.save(repo, recordId, pipeline);
    watched.waiting = "";
  }

  /** Labels the pull request, asks the issue's assignees to review and mentions them, the latter once per issue. */
  private async askForHumanReview(context: SessionContext, pullRequest: number): Promise<void> {
    const { key, github, repo, issue, pipeline } = context;
    const current = await github.pullRequest(repo, pullRequest);
    if (current && !current.labels.includes(HUMAN_REVIEW_PR_LABEL)) {
      await github.ensureLabel(repo, HUMAN_REVIEW_LABEL_SPEC);
      await github.addLabels(repo, pullRequest, [HUMAN_REVIEW_PR_LABEL]);
    }
    if (pipeline.notified) return;
    const people = mentionsOf(issue);
    await github.requestReviewers(repo, pullRequest, people);
    await github.comment(repo, pullRequest, humanReviewComment(people, issue.number));
    this.deps.log(`${key}: asked ${people.map((login) => `@${login}`).join(", ") || "nobody (no assignee or author)"} to review #${pullRequest}`);
  }

  /** Replaces the issue's workflow labels with the label of `step`; the new label comes first, so none is ever missing. */
  private async relabel(context: SessionContext, step: SwfStep): Promise<void> {
    const { github, repo, issue, labels } = context;
    const target = labels.step(step);
    if (!issue.labels.includes(target)) {
      await github.addLabels(repo, issue.number, [target]);
    }
    const carried = labels.carriedBy(issue);
    for (const label of carried) {
      if (label !== target) {
        await github.removeLabel(repo, issue.number, label);
      }
    }
    issue.labels = [...issue.labels.filter((label) => !carried.includes(label)), target];
  }

  /** The merged pull request ends the pipeline: `<label>:done`, DONE_STATUS in the projects and a comment. */
  private async finish(context: SessionContext, pullRequest: PullRequestState): Promise<void> {
    const { key, github, repo, issue, labels } = context;
    for (const label of labels.carriedBy(issue)) {
      await github.removeLabel(repo, issue.number, label);
    }
    await github.addLabels(repo, issue.number, [labels.done]);
    await github.comment(repo, issue.number, mergedComment(pullRequest.number));
    await this.moveToStatus(github, key, repo, issue.number, DONE_STATUS);
    this.deps.log(`${key}: done, #${pullRequest.number} is merged`);
  }

  /**
   * Sends the answers that arrived on the issue since the agent's question to the agent, unless its relay is busy or a
   * desktop is connected; the prompt tells the agent to take the label back to the step.
   */
  private async deliverAnswer(context: SessionContext): Promise<void> {
    const { repo, recordId, issue, comments, bot, labels, pipeline, watched, sessionVm, sessionId } = context;
    const answers = newAnswers(comments, bot, watched.answeredAt);
    if (answers.length === 0) return;
    const vm = this.deps.vm(sessionVm.name, sessionVm.zone);
    const status = relayStatus(await vm.huntCtl(["status", sessionId.id]));
    if (!status || status.turn !== "idle" || status.clientConnected) return;
    watched.answeredAt = answers[answers.length - 1].createdAt;
    const text = answerPrompt(this.deps.prompts().swfAnswer, repo, issue.number, answers, labels, pipeline.step);
    const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: status.worktree, text });
    pipeline.noteAnswersDelivered(status.lastTurnEndedAt ?? 0);
    await this.records.save(repo, recordId, pipeline);
    const what = answers.length === 1 ? "an answer arrived on the issue; sent it" : `${answers.length} answers arrived on the issue; sent them`;
    this.deps.log(`${repo.slug}#${issue.number}: ${what} to the agent (prompt ${outcome})`);
  }

  /**
   * Drives a poller step of a session whose VM is off, since it needs GitHub only, and starts the stopped VM of a session
   * whose agent has a prompt pending (an answer arrived on the issue, or the pipeline entered an agent step whose prompt
   * was not sent), in the background; the next poll that lists the VM running sends it.
   */
  private async watchStoppedSession(
    github: GitHub,
    labels: WorkflowLabels,
    sessionVm: SessionVm,
    sessionId: SessionId,
    repo: Repository,
    issueNumber: number,
    watched: Watched,
  ): Promise<void> {
    const loaded = await this.loadContext(github, labels, sessionVm, sessionId, repo, issueNumber, watched);
    if (!loaded) return;
    const { context, state } = loaded;
    let why: string;
    if (state === "question") {
      if (newAnswers(context.comments, context.bot, watched.answeredAt).length === 0) return;
      why = "an answer arrived on the issue";
    } else if (!context.pipeline.waitsForAgent) {
      await this.drivePollerStep(context);
      return;
    } else if (context.pipeline.isPromptPending) {
      why = `the step ${context.pipeline.step} waits for its prompt`;
    } else {
      return;
    }
    const key = `${repo.slug}#${issueNumber}`;
    this.deps.log(`${key}: ${why} while ${sessionVm.name} is ${sessionVm.status.toLowerCase()}; starting it`);
    this.starts.add(sessionVm.name);
    void this.deps.sessionVmService.start(sessionId, SILENT).then(
      () => {
        watched.startError = "";
        this.deps.log(`${key}: ${sessionVm.name} runs again`);
      },
      (error: unknown) => {
        const message = this.redacted(error);
        if (watched.startError !== message) {
          this.deps.log(`${key}: failed to start ${sessionVm.name}: ${message}`, "error");
        }
        watched.startError = message;
      },
    ).finally(() => this.starts.delete(sessionVm.name));
  }

  /** Claims the issue and starts its setup in the background; an issue that cannot be claimed stays for the next poll. */
  private async claimAndStart(domain: string, claudeToken: string, github: GitHub, labels: WorkflowLabels, repo: Repository, issue: Issue): Promise<void> {
    const key = `${repo.slug}#${issue.number}`;
    let comments: IssueComment[];
    try {
      await this.ensureLabels(github, repo, labels);
      comments = await github.comments(repo, issue.number);
      if (!(await github.removeLabel(repo, issue.number, labels.requested))) {
        this.deps.log(`${key}: skipped, its label ${labels.requested} was removed meanwhile`);
        return;
      }
    } catch (error) {
      this.deps.log(`${key}: failed to claim the issue: ${this.redacted(error)}`, "error");
      return;
    }

    const sessionId = SessionId.of(this.deps.newId());
    const branch = branchName(issue);
    this.deps.log(`${key}: claimed; session ${sessionId.id} on ${sessionId.vm.name}, branch ${branch.name}`);
    const setup: Setup = { key, repo, issue: issue.number, labels, sessionId, isVmCreated: false, recordId: 0, done: Promise.resolve() };
    this.setups.set(sessionId.vm.name, setup);
    setup.done = (async () => {
      try {
        await github.addLabels(repo, issue.number, [labels.step("plan")]);
        await this.moveToStatus(github, key, repo, issue.number, IN_PROGRESS_STATUS);
        await this.setUp(setup, domain, claudeToken, branch, issue, comments);
      } catch (error) {
        await this.markFailed(setup, this.redacted(error));
      } finally {
        this.setups.delete(sessionId.vm.name);
      }
    })();
  }

  /** Moves the issue to the `status` column of its projects; a failure, such as a missing permission, is only logged. */
  private async moveToStatus(github: GitHub, key: string, repo: Repository, issue: number, status: string): Promise<void> {
    try {
      const moved = await github.moveToStatus(repo, issue, status);
      if (moved.length > 0) {
        this.deps.log(`${key}: moved to ${status} in ${moved.map((title) => `"${title}"`).join(", ")}`);
      }
    } catch (error) {
      this.deps.log(`${key}: failed to move the issue to ${status} in its projects: ${this.redacted(error)}`, "error");
    }
  }

  private async ensureLabels(github: GitHub, repo: Repository, labels: WorkflowLabels): Promise<void> {
    const key = `${repo.slug} ${labels.requested}`;
    if (this.labelledRepos.has(key)) return;
    for (const label of labels.specs()) {
      await github.ensureLabel(repo, label);
    }
    this.labelledRepos.add(key);
  }

  /** The handoff of the desktop, from the VM to the first prompt; see the module comment. */
  private async setUp(setup: Setup, domain: string, claudeToken: string, branch: BranchName, issue: Issue, comments: IssueComment[]): Promise<void> {
    const { key, repo, sessionId } = setup;
    const log = (message: string) => this.deps.log(`${key}: ${message}`);
    const reporter: Reporter = {
      progress: (step) => {
        if (step === "creatingVm") {
          setup.isVmCreated = true;
        }
      },
      log,
    };
    const request = { sessionId, repo, branch, title: issue.title, issue: issue.number, origin: ORIGIN, owner: "" };
    const provisioned = await this.deps.sessionVmService.provision({ ...request, template: DEFAULT_TEMPLATE, machineType: null }, reporter);
    const vm = this.deps.vm(sessionId.vm.name, provisioned.vm.zone);
    await vm.huntCtl(["install-tools"]);

    // The clone, the commits and the relay act as the app: the token of the moment, since one is valid for an hour only.
    const identity = await this.deps.githubApp.identity();
    const cloneArgs = ["clone", sessionId.id, "--repo", repo.slug, "--branch", branch.name, "--git-name", identity.name, "--git-email", identity.email];
    const cloned = await vm.huntCtl(cloneArgs, `${await this.deps.githubApp.tokenFor(repo)}\n`);
    if (typeof cloned.path !== "string" || !cloned.path) throw new Error("hunt-ctl clone returned no path");
    await this.putPrivateFiles(vm, key, sessionId, repo);
    const sessionConfig = await vm.huntCtl(["session-config", sessionId.id, "--domain", domain]);
    const servicesPrompt = typeof sessionConfig.services_prompt === "string" ? sessionConfig.services_prompt : null;
    const agentMd = typeof sessionConfig.agent_md === "string" ? sessionConfig.agent_md : null;
    const model = typeof sessionConfig.swf_model === "string" ? sessionConfig.swf_model : null;
    const humanReviewPaths = Array.isArray(sessionConfig.swf_human_review_paths)
      ? sessionConfig.swf_human_review_paths.filter((path): path is string => typeof path === "string")
      : [];
    const skills = stepSkills(sessionConfig.swf_skills);
    if (skills.missing) throw new Error(missingSkillsError(skills.missing));
    const pipeline = Pipeline.start(humanReviewPaths, skills.skills);
    setup.recordId = await this.records.create(repo, issue.number, pipeline);
    const prompts = this.deps.prompts();
    const swfPrompt = swfSystemPrompt(prompts.swfSystem, repo, issue.number, branch.name, setup.labels);
    const systemPrompt = remoteSystemPrompt(prompts, sessionId, swfPrompt, servicesPrompt, agentMd);
    await vm.putClaudeFiles(sessionId, { "hunt-session.json": huntSessionFile(sessionId, cloned.path, systemPrompt, model) });
    log(`cloned ${repo.slug} into ${cloned.path}; installing the dependencies`);
    await vm.huntCtl(["deps", sessionId.id]);
    await vm.huntCtl(["start", sessionId.id], `${claudeToken}\n${await this.deps.githubApp.tokenFor(repo)}\n`);
    const status = await vm.huntCtl(["wait", sessionId.id, "--timeout", "180"]);
    if (typeof status.acpSessionId !== "string" || !status.acpSessionId) throw new Error("the relay reports no ACP session");

    const text = stepPrompt(prompts, repo, issue, comments, branch.name, setup.labels, pipeline);
    const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: cloned.path, text });
    pipeline.recordPrompt(0);
    await this.records.save(repo, setup.recordId, pipeline);
    log(`the agent of session ${sessionId.id} plans the issue (prompt ${outcome})`);
  }

  /**
   * Unpacks the repository's private files, the gzipped tar archive in the secret `HUNT_SWF_FILES_<owner>_<repo>`, into
   * the session's worktree; a repository whose secret is absent (no version, or the gateway may not read it) gets
   * none, with a warning in the journal. The archive's content never reaches the log.
   */
  private async putPrivateFiles(vm: SessionVmSsh, key: string, sessionId: SessionId, repo: Repository): Promise<void> {
    const name = privateFilesSecret(repo);
    const secret = await this.deps.secretBytes(name);
    if (!secret.bytes) {
      this.deps.log(`${key}: no private files: the secret ${name} ${secret.absent}`, "warn");
      return;
    }
    checkPrivateFilesArchive(secret.bytes, name);
    await vm.huntCtl(["put-files", sessionId.id], secret.bytes);
    this.deps.log(`${key}: put the private files of ${repo.slug} from the secret ${name} (${secret.bytes.length} bytes) into the worktree`);
  }

  /** Replaces `<label>:plan` with `<label>:failed` and comments the error of the setup; failures here are only logged. */
  private async markFailed(setup: Setup, error: string): Promise<void> {
    const { key, repo, issue, labels, sessionId } = setup;
    this.deps.log(`${key}: failed: ${error}`, "error");
    await this.failIssue(key, this.deps.github, repo, issue, labels, "plan", failureComment(error, setup.isVmCreated ? sessionId.vm.name : null));
  }

  /** Replaces the label of `step` (and a question label) with `<label>:failed` and comments `comment`; failures here are only logged. */
  private async failIssue(key: string, github: GitHub, repo: Repository, issue: number, labels: WorkflowLabels, step: SwfStep, comment: string): Promise<void> {
    const steps: [string, () => Promise<unknown>][] = [
      [`remove ${labels.step(step)}`, () => github.removeLabel(repo, issue, labels.step(step))],
      [`remove ${labels.question}`, () => github.removeLabel(repo, issue, labels.question)],
      [`add ${labels.failed}`, () => github.addLabels(repo, issue, [labels.failed])],
      ["comment on the issue", () => github.comment(repo, issue, comment)],
    ];
    for (const [what, run] of steps) {
      try {
        await run();
      } catch (stepError) {
        this.deps.log(`${key}: failed to ${what}: ${this.redacted(stepError)}`, "error");
      }
    }
  }

  /** Waits until every setup in progress ended. */
  async drain(): Promise<void> {
    await Promise.all([...this.setups.values()].map((setup) => setup.done));
  }

  /** Marks the issues of the setups in progress as failed with `reason`. */
  async abort(reason: string): Promise<void> {
    await Promise.all([...this.setups.values()].map((setup) => this.markFailed(setup, reason)));
  }
}
