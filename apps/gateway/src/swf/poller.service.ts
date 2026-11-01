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
 * `swf-record` with the pipeline, `start` with the tokens on stdin (which enables the swf runner of the VM,
 * `apps/session/src/swf-runner/swf-runner.main.ts`) and `wait`. The session's system prompt holds the protocol of the
 * steps (`libs/domain/prompts/swf/0-system-prompt.md`, `swf/swf-prompts.utils.ts`); the runner sends the prompt of the
 * first step, `plan`. When the setup fails, the poller sets `swf:failed` with the error and leaves the VM for
 * inspection; Hunt desktops adopt the VM either way.
 *
 * Every poll also follows the pipeline of each session VM (`watchSession`): the issue's labels give the agent's state
 * (the step, `question`, `done`, `failed`; `libs/domain/src/swf/workflow-labels.value-object.ts`), which the VM's
 * metadata `hunt-agent` records for Hunt's lists, and the record comment holds the pipeline's state. The record's
 * `version` says who drives the agent steps (plan, implement, verify, gate, pr): the runner on the VM for RUNNER_VERSION
 * and above, which edits the record comment itself, the poller for the records it wrote before the runner existed. For
 * those the poller sends the step's prompt once the relay is idle (`swf/relay-status.utils.ts`), then waits for the
 * agent's step result, a comment with `<!-- hunt:step {…} -->` (`libs/domain/src/swf/step-result.utils.ts`); the result
 * moves the issue to the next step's label (`acceptResult`), and findings of verify send it back to implement. A turn
 * that ends without a result gets one reminder (`nudgePrompt`); when the next turn ends the same way, the issue is
 * marked as failed. The poller steps are the poller's for every record: `review` (prepared once when the runner moved
 * the issue there, `prepareReview`) waits for the pull request's checks and the Claude review's verdict (a failing check
 * or blocking findings go back to implement), `human-review` for a person's approval (a change request goes back to
 * implement) and `merge` updates the branch when it is behind and squash-merges it; then the issue gets `swf:done` and
 * moves to DONE_STATUS in its projects. These steps need GitHub only, so they go on while the idle sweeper keeps the
 * session's VM suspended. While the issue is labelled `swf:question`, the poller watches it for the answer: a comment by
 * someone other than the app's bot user after the agent's question (`newAnswers` in `swf/issue-thread.utils.ts`) goes
 * to the runner's inbox (`hunt-ctl swf-inbox`, `libs/domain/src/swf/swf-inbox.utils.ts`), or for an older record to the
 * agent as a prompt (`answerPrompt`), which tells it to take the label back to the step; a VM that stopped meanwhile, or
 * one whose step has a prompt pending (the runner's next step after a transition the poller made), is started first
 * through the session VM service and gets the pipeline through the inbox. An answer given in a Hunt desktop needs none
 * of this: the agent takes the label back itself. No prompt goes to a session a Hunt desktop is connected to, since a
 * person is working with the agent there. Delivered answers are remembered only in memory: after a restart of the
 * poller a session may get an answer a second time. What the poller comments on GitHub is `swf/swf-comments.utils.ts`.
 *
 * An issue in progress (labelled with a step or the question) whose VM Compute Engine lists no more (the reaper deleted
 * it, or a person did) keeps going without it (`watchIssuesWithoutVm`, one search of GitHub per repository and poll):
 * its poller steps need GitHub only, and its question waits for the answer. Once the pipeline needs the agent again (an
 * agent step, or the answer arrived), the poller replaces the VM (`replaceVm`): a new session VM as in a setup, a clone
 * of the branch the record names, `.hunt/swf/` restored from the record and the step results on the issue (one
 * `swf-record` per run that has a result comment), the step's run ended as `restarted` with a new run of the step
 * (`Pipeline.restart`), the runner started, which sends the step's prompt afresh, and a comment on the issue. A record
 * of version 1 names no branch and is left alone with a warning, since its poller-driven session cannot be rebuilt.
 *
 * On GitHub the poller and its sessions act as a GitHub App (`swf/github-app.client.ts`). The app's installation tokens
 * are valid for one hour and limited to one repository each: a session's clone, its commits (with the app's bot
 * identity) and its relay get the current one, and every poll hands a renewed token to each running session VM
 * (`hunt-ctl github-token`), so git, Git LFS and `gh` there keep working without a relay restart. One log line per
 * decision, Compute Engine call and command on a session VM goes to the log; tokens and the key never appear in logs or
 * comments (`swf/redaction.utils.ts`). `drain` waits for the setups in progress, `abort` marks their issues as failed.
 */
import { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import type { PullRequestState } from "../../../../libs/domain/src/swf/pull-request-state.value-object.ts";
import { ReviewVerdict } from "../../../../libs/domain/src/swf/review-verdict.value-object.ts";
import { parseStepResult } from "../../../../libs/domain/src/swf/step-result.utils.ts";
import type { AgentState, SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { SWF_LABEL, WorkflowLabels } from "../../../../libs/domain/src/swf/workflow-labels.value-object.ts";
import type { Compute, Instance } from "../gcp/compute-engine.client.ts";
import type { OptionalSecret } from "../gcp/secret-manager.client.ts";
import type { Transport } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import type { SessionVmSsh } from "../session-vm/session-vm-ssh.client.ts";
import { AGENT_METADATA, ORIGIN_LABEL, SessionVm } from "../session-vm/session-vm.domain.ts";
import { DEFAULT_TEMPLATE, SILENT, type Origin, type Reporter, type SessionVmService } from "../session-vm/session-vm.service.ts";
import type { AppCredentials, GitHubApp } from "./github-app.client.ts";
import type { GitHub, Issue, IssueComment } from "./github.client.ts";
import { matchingFiles } from "./glob.utils.ts";
import { mentionsOf, newAnswers, newStepResults, resultsOfRuns, type RunResult } from "./issue-thread.utils.ts";
import { PipelineRecordClient } from "./pipeline-record.client.ts";
import { Pipeline, stepSkills } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
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
  replacedVmComment,
} from "./swf-comments.utils.ts";
import { stoppedComment } from "../../../../libs/domain/src/swf/swf-comments.utils.ts";
import { REPOS_ATTRIBUTE, type SwfConfig } from "./swf-config.utils.ts";
import {
  answerPrompt,
  badResultPrompt,
  huntSessionFile,
  nudgePrompt,
  remoteSystemPrompt,
  stepPrompt,
  swfSystemPrompt,
  type PromptFiles,
} from "../../../../libs/domain/src/swf/swf-prompts.utils.ts";
import { answersMessage, pipelineMessage } from "../../../../libs/domain/src/swf/swf-inbox.utils.ts";
import { UnusableStepResult } from "../../../../libs/domain/src/swf/unusable-step-result.error.ts";

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
  /** The current time in ms, the clock of the pipeline's runs. */
  now(): number;
  log(message: string, level?: LogLevel): void;
}

/** A session the poller is setting up: enough to mark its issue as failed when the poller has to stop. */
interface Setup {
  key: string;
  repo: Repository;
  issue: number;
  labels: WorkflowLabels;
  sessionId: SessionId;
  /** The step whose label a failure replaces: plan for a new session, the pipeline's step for a replaced VM. */
  step: SwfStep;
  isVmCreated: boolean;
  /** The id of the record comment on the issue; 0 until it was created. */
  recordId: number;
  done: Promise<void>;
}

/** A session VM with the repository cloned and configured, before `hunt-session.json`, the dependencies and the start. */
interface PreparedVm {
  vm: SessionVmSsh;
  zone: string;
  /** The worktree on the VM. */
  path: string;
  servicesPrompt: string | null;
  agentMd: string | null;
  model: string | null;
  humanReviewPaths: string[];
  /** `swf_skills` of `hunt-ctl session-config`, as reported. */
  skills: unknown;
}

/** What the poller remembers about a session, or an issue without a VM, between polls; everything that matters survives in the record comment. */
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

/** Everything one poll of a session's pipeline works with; the VM and session are null for an issue without a VM. */
interface SessionContext {
  key: string;
  github: GitHub;
  labels: WorkflowLabels;
  sessionVm: SessionVm | null;
  sessionId: SessionId | null;
  repo: Repository;
  issue: Issue;
  comments: IssueComment[];
  bot: string;
  /** The id of the record comment that holds `pipeline`. */
  recordId: number;
  pipeline: Pipeline;
  watched: Watched;
}

/** The context of a session whose VM runs, which takes the commands of the poller. */
interface RunningContext extends SessionContext {
  sessionVm: SessionVm;
  sessionId: SessionId;
}

/** One poll after another; see the module comment. */
export class Poller {
  private readonly deps: PollerDeps;
  private readonly records: PipelineRecordClient;
  /** Setups in progress by VM name; they count towards the limit until Compute Engine lists their VM. */
  private readonly setups = new Map<string, Setup>();
  /** The sessions the poller follows, by VM name. */
  private readonly watched = new Map<string, Watched>();
  /** The issues in progress without a VM the poller follows, by `<repo>#<issue>`. */
  private readonly withoutVm = new Map<string, Watched>();
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
    const issuesByRepo: { repo: Repository; issues: Issue[] }[] = [];
    for (const repo of config.repos) {
      try {
        await this.watchIssuesWithoutVm(domain, secrets.claude, github, labels, repo, await github.openIssuesWithAny(repo, labels.inProgress), vms);
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
    // The VMs being replaced count like the ones being set up.
    const active = activeSessionVms(vms, this.setups.keys());
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

  /**
   * The issue, its comments, the bot's login and the pipeline; null when the session has none to drive. `sessionVm` and
   * `sessionId` are null for an issue without a VM.
   */
  private async loadContext(
    github: GitHub,
    labels: WorkflowLabels,
    sessionVm: SessionVm | null,
    sessionId: SessionId | null,
    repo: Repository,
    issueNumber: number,
    watched: Watched,
  ): Promise<{ context: SessionContext; state: SwfStep | "question" } | null> {
    const key = `${repo.slug}#${issueNumber}`;
    const issue = await github.issue(repo, issueNumber);
    const state: AgentState | null = labels.agentStateOf(issue);
    if (state !== null && sessionVm && sessionId && sessionVm.agent !== state) {
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
    const { state } = loaded;
    const context: RunningContext = { ...loaded.context, sessionVm, sessionId };
    if (state === "question") {
      if (context.pipeline.isRunnerDriven) {
        await this.deliverAnswersToRunner(context);
      } else {
        await this.deliverAnswer(context);
      }
      return;
    }
    if (state !== context.pipeline.step) {
      // The agent moved the label back after a question, or a person moved it: the record is the pipeline's truth.
      this.deps.log(`${key}: the issue is labelled ${labels.step(state)} but the pipeline is at ${context.pipeline.step}; relabelling`, "warn");
      await this.relabel(context, context.pipeline.step);
    }
    if (!context.pipeline.waitsForAgent) {
      await this.drivePollerStep(context);
    } else if (context.pipeline.isRunnerDriven) {
      this.waitOnce(watched, key, `the runner on ${sessionVm.name} drives the step ${context.pipeline.step}`);
    } else {
      await this.driveAgentStep(context);
    }
  }

  /**
   * An agent step: acts on a new step result (the next step, or back to implement), else sends the step's prompt when
   * none was sent, else reminds an agent whose turn ended without a result once and fails the issue the second time.
   */
  private async driveAgentStep(context: RunningContext): Promise<void> {
    const { key, repo, recordId, issue, comments, bot, pipeline, labels, sessionVm, sessionId } = context;
    const results = newStepResults(comments, bot, pipeline.lastResultId);
    const vm = this.deps.vm(sessionVm.name, sessionVm.zone);
    if (results.length > 0) {
      const last = results[results.length - 1];
      const step = pipeline.step;
      try {
        pipeline.acceptResult(parseStepResult(last.body), last.id, this.deps.now());
      } catch (error) {
        if (!(error instanceof UnusableStepResult)) throw error;
        await this.dismissResult(context, vm, last.id, error.message);
        return;
      }
      this.deps.log(`${key}: the agent reported the step ${step}; the pipeline goes on with ${pipeline.step}`);
      await this.enterStep(context, step, last.body);
      return;
    }
    const status = relayStatus(await vm.huntCtl(["status", sessionId.id]));
    if (!status || status.turn !== "idle" || status.clientConnected) return;
    if (pipeline.isPromptPending) {
      const text = stepPrompt(this.deps.prompts(), repo, issue, comments, sessionVm.branch, labels, pipeline);
      const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: status.worktree, text });
      pipeline.recordPrompt(status.lastTurnEndedAt ?? 0);
      await this.records.save(repo, recordId, pipeline);
      await this.recordOnVm(context);
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
  private async dismissResult(context: RunningContext, vm: SessionVmSsh, resultId: number, problem: string): Promise<void> {
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
    if (step === "review" && pipeline.isRunnerDriven && !pipeline.reviewPrepared) {
      // The runner moved the issue to review; what entering the review brings with it on GitHub is the poller's.
      await this.prepareReview(context, pipeline.lastEndedRun?.step === "pr");
      pipeline.noteReviewPrepared();
      await this.records.save(repo, recordId, pipeline);
      await this.recordOnVm(context);
    }
    switch (step) {
      case "review": {
        const outcome = pullRequest.reviewOutcome(ReviewVerdict.latestIn(await github.comments(repo, pullRequest.number)));
        if (outcome.kind === "wait") {
          this.waitOnce(watched, key, `review: ${outcome.reason}`);
        } else if (outcome.kind === "fix") {
          this.deps.log(`${key}: the review of #${pullRequest.number} found something; back to implement`);
          pipeline.sendBackToImplement(outcome.findings, this.deps.now());
          await this.enterStep(context, step);
        } else if (outcome.kind === "clean") {
          pipeline.passReview(this.deps.now());
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
          pipeline.handleChangeRequest(outcome.review.id, finding, this.deps.now());
          await this.enterStep(context, step);
        } else {
          this.deps.log(`${key}: #${pullRequest.number} was approved by ${outcome.by.join(", ")}; the pipeline goes on with merge`);
          pipeline.approve(this.deps.now());
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
          pipeline.sendBackToImplement(outcome.findings, this.deps.now());
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
   * it: the issue's label and, for a move into review, `prepareReview`.
   */
  private async enterStep(context: SessionContext, from: SwfStep, resultBody?: string): Promise<void> {
    const { repo, recordId, pipeline, watched } = context;
    if (pipeline.step === "review" && pipeline.pullRequest !== null) {
      await this.prepareReview(context, from === "pr");
      pipeline.noteReviewPrepared();
    }
    await this.relabel(context, pipeline.step);
    await this.records.save(repo, recordId, pipeline);
    const ended = pipeline.lastEndedRun;
    await this.recordOnVm(context, resultBody !== undefined && ended ? { n: ended.n, step: ended.step, body: resultBody } : undefined);
    watched.waiting = "";
  }

  /**
   * What entering the review brings with it on GitHub: the first review (`fromPr`) moves the issue to IN_REVIEW_STATUS;
   * every review checks the pull request's files against the repository's `humanReviewPaths` and, when a person has to
   * review, labels the pull request and mentions the people once. The pipeline is at review with a pull request.
   */
  private async prepareReview(context: SessionContext, fromPr: boolean): Promise<void> {
    const { key, github, repo, issue, pipeline } = context;
    if (pipeline.pullRequest === null) return;
    if (fromPr) {
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

  /** `handPipelineTo` the session's VM while it runs; an issue without a VM, or with one that is off, keeps the pipeline on GitHub only. */
  private async recordOnVm(context: SessionContext, result?: RunResult): Promise<void> {
    const { sessionVm, sessionId } = context;
    if (!sessionVm?.isRunning || !sessionId) return;
    await this.handPipelineTo(context, this.deps.vm(sessionVm.name, sessionVm.zone), sessionId, result);
  }

  /**
   * Hands the pipeline to `vm`, the VM of the session `sessionId`: for a record the poller drives, `hunt-ctl swf-record`
   * mirrors it into `.hunt/swf/` of the worktree (`pipeline.json` and, with `result`, the body of the step result of the
   * run `result.n` as `steps/<nn>-<step>.md`), where the Hunt client reads them; for a record the runner drives,
   * `hunt-ctl swf-inbox` puts it into the runner's inbox, which takes it when it is further than its own
   * (`libs/domain/src/swf/swf-inbox.utils.ts`). The record comment stays the poller's own source, so a failure here is
   * logged and nothing more.
   */
  private async handPipelineTo(context: SessionContext, vm: SessionVmSsh, sessionId: SessionId, result?: RunResult): Promise<void> {
    const { key, pipeline } = context;
    try {
      if (pipeline.isRunnerDriven) {
        await vm.huntCtl(["swf-inbox", sessionId.id], `${JSON.stringify(pipelineMessage(pipeline))}\n`);
      } else {
        await vm.huntCtl(["swf-record", sessionId.id], `${JSON.stringify({ pipeline: pipeline.toJSON(), step: result })}\n`);
      }
    } catch (error) {
      this.deps.log(`${key}: failed to record the pipeline on the VM: ${this.redacted(error)}`, "warn");
    }
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
    const { key, github, repo, issue, labels, recordId, pipeline } = context;
    pipeline.complete(this.deps.now());
    await this.records.save(repo, recordId, pipeline);
    await this.recordOnVm(context);
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
  private async deliverAnswer(context: RunningContext): Promise<void> {
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
   * Hands the answers that arrived on the issue since the agent's question to the runner on the VM (`hunt-ctl swf-inbox`),
   * which sends them to the agent once its relay is idle and no desktop is connected; each answer once.
   */
  private async deliverAnswersToRunner(context: RunningContext): Promise<void> {
    const { key, comments, bot, watched, sessionVm, sessionId } = context;
    const answers = newAnswers(comments, bot, watched.answeredAt);
    if (answers.length === 0) return;
    await this.deps.vm(sessionVm.name, sessionVm.zone).huntCtl(["swf-inbox", sessionId.id], `${JSON.stringify(answersMessage(answers))}\n`);
    watched.answeredAt = answers[answers.length - 1].createdAt;
    const what = answers.length === 1 ? "an answer arrived on the issue; handed it" : `${answers.length} answers arrived on the issue; handed them`;
    this.deps.log(`${key}: ${what} to the runner on ${sessionVm.name}`);
  }

  /**
   * Drives a poller step of a session whose VM is off, since it needs GitHub only, and starts the stopped VM of a session
   * whose agent has a prompt pending (an answer arrived on the issue, or the pipeline entered an agent step whose prompt
   * was not sent), in the background; the next poll that lists the VM running sends it. The started VM gets the pipeline
   * as it stands, since the transitions made while it was off never reached its `.hunt/swf/`.
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
      async () => {
        watched.startError = "";
        await this.handPipelineTo(context, this.deps.vm(sessionVm.name, sessionVm.zone), sessionId);
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
    try {
      await this.ensureLabels(github, repo, labels);
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
    const setup: Setup = { key, repo, issue: issue.number, labels, sessionId, step: "plan", isVmCreated: false, recordId: 0, done: Promise.resolve() };
    this.setups.set(sessionId.vm.name, setup);
    setup.done = (async () => {
      try {
        await github.addLabels(repo, issue.number, [labels.step("plan")]);
        await this.moveToStatus(github, key, repo, issue.number, IN_PROGRESS_STATUS);
        await this.setUp(setup, domain, claudeToken, branch, issue);
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

  /** The handoff of the desktop, from the VM to the runner that sends the first prompt; see the module comment. */
  private async setUp(setup: Setup, domain: string, claudeToken: string, branch: BranchName, issue: Issue): Promise<void> {
    const { key, repo, sessionId } = setup;
    const prepared = await this.prepareVm(setup, domain, branch, issue);
    const skills = stepSkills(prepared.skills);
    if (skills.missing) throw new Error(missingSkillsError(skills.missing));
    const pipeline = Pipeline.start({ repo: repo.slug, number: issue.number, branch: branch.name }, prepared.humanReviewPaths, skills.skills, this.deps.now());
    setup.recordId = await this.records.create(repo, issue.number, pipeline);
    // The runner edits the record comment itself, so the pipeline names it.
    pipeline.noteRecordComment(setup.recordId);
    await this.records.save(repo, setup.recordId, pipeline);
    await this.startSession(setup, prepared, claudeToken, issue, branch, pipeline, []);
    this.deps.log(`${key}: the runner of session ${sessionId.id} drives the issue, beginning with the plan`);
  }

  /**
   * Brings the session's VM up with the repository cloned onto `branch`, the private files and the session's
   * configuration: the first half of a setup, which `startSession` completes once the pipeline is known.
   */
  private async prepareVm(setup: Setup, domain: string, branch: BranchName, issue: Issue): Promise<PreparedVm> {
    const { key, repo, sessionId } = setup;
    const reporter: Reporter = {
      progress: (step) => {
        if (step === "creatingVm") {
          setup.isVmCreated = true;
        }
      },
      log: (message) => this.deps.log(`${key}: ${message}`),
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
    return {
      vm,
      zone: provisioned.vm.zone,
      path: cloned.path,
      servicesPrompt: typeof sessionConfig.services_prompt === "string" ? sessionConfig.services_prompt : null,
      agentMd: typeof sessionConfig.agent_md === "string" ? sessionConfig.agent_md : null,
      model: typeof sessionConfig.swf_model === "string" ? sessionConfig.swf_model : null,
      humanReviewPaths: Array.isArray(sessionConfig.swf_human_review_paths)
        ? sessionConfig.swf_human_review_paths.filter((path): path is string => typeof path === "string")
        : [],
      skills: sessionConfig.swf_skills,
    };
  }

  /**
   * Completes the setup of a prepared VM: `hunt-session.json` with the system prompt, the dependencies, `.hunt/swf/` with
   * `pipeline` and the step results `results` of its runs (one `swf-record` each), then `start`, which enables the
   * runner, and `wait` for the relay's session.
   */
  private async startSession(setup: Setup, prepared: PreparedVm, claudeToken: string, issue: Issue, branch: BranchName, pipeline: Pipeline, results: RunResult[]): Promise<void> {
    const { key, repo, sessionId } = setup;
    const { vm } = prepared;
    const prompts = this.deps.prompts();
    const swfPrompt = swfSystemPrompt(prompts.swfSystem, repo, issue.number, branch.name, setup.labels);
    const systemPrompt = remoteSystemPrompt(prompts, sessionId, swfPrompt, prepared.servicesPrompt, prepared.agentMd);
    await vm.putClaudeFiles(sessionId, { "hunt-session.json": huntSessionFile(sessionId, prepared.path, systemPrompt, prepared.model) });
    this.deps.log(`${key}: cloned ${repo.slug} into ${prepared.path}; installing the dependencies`);
    await vm.huntCtl(["deps", sessionId.id]);
    // The pipeline is on the VM before `start` enables the runner, which drives it from here: its first prompt is the current step's.
    await vm.huntCtl(["swf-record", sessionId.id], `${JSON.stringify({ pipeline: pipeline.toJSON() })}\n`);
    for (const result of results) {
      await vm.huntCtl(["swf-record", sessionId.id], `${JSON.stringify({ pipeline: pipeline.toJSON(), step: result })}\n`);
    }
    await vm.huntCtl(["start", sessionId.id], `${claudeToken}\n${await this.deps.githubApp.tokenFor(repo)}\n`);
    const status = await vm.huntCtl(["wait", sessionId.id, "--timeout", "180"]);
    if (typeof status.acpSessionId !== "string" || !status.acpSessionId) throw new Error("the relay reports no ACP session");
  }

  /**
   * Follows the issues of `repo` in progress (`issues`, labelled with a step or the question) that have no VM: Compute
   * Engine lists none of theirs (`vms`) and no setup is under way for them. A lasting failure with one is logged once.
   */
  private async watchIssuesWithoutVm(domain: string, claudeToken: string, github: GitHub, labels: WorkflowLabels, repo: Repository, issues: Issue[], vms: Instance[]): Promise<void> {
    const withVm = new Set<string>();
    for (const instance of vms) {
      const sessionVm = SessionVm.fromInstance(instance);
      if (sessionVm && sessionVm.issue !== null) {
        withVm.add(`${sessionVm.repo}#${sessionVm.issue}`);
      }
    }
    for (const setup of this.setups.values()) {
      withVm.add(setup.key);
    }
    const followed = new Set<string>();
    for (const issue of issues) {
      const key = `${repo.slug}#${issue.number}`;
      if (withVm.has(key)) continue;
      followed.add(key);
      const watched = this.withoutVm.get(key) ?? { error: "", token: "", answeredAt: "", startError: "", waiting: "" };
      this.withoutVm.set(key, watched);
      try {
        await this.watchIssueWithoutVm(domain, claudeToken, github, labels, repo, issue.number, watched);
        watched.error = "";
      } catch (error) {
        const message = this.redacted(error);
        if (watched.error !== message) {
          this.deps.log(`${key}: ${message}`, "error");
        }
        watched.error = message;
      }
    }
    for (const key of this.withoutVm.keys()) {
      if (key.startsWith(`${repo.slug}#`) && !followed.has(key)) {
        this.withoutVm.delete(key);
      }
    }
  }

  /**
   * Drives the pipeline of an issue without a VM as far as GitHub takes it: a poller step goes on without the VM, a
   * question waits for its answer; once the pipeline needs the agent (an agent step, or the answer arrived), the VM is
   * replaced. A record that names no branch (version 1, driven by the poller) cannot be rebuilt and is left alone.
   */
  private async watchIssueWithoutVm(domain: string, claudeToken: string, github: GitHub, labels: WorkflowLabels, repo: Repository, issueNumber: number, watched: Watched): Promise<void> {
    const loaded = await this.loadContext(github, labels, null, null, repo, issueNumber, watched);
    if (!loaded) return;
    const { context, state } = loaded;
    const { key, pipeline } = context;
    if (!pipeline.waitsForAgent) {
      await this.drivePollerStep(context);
      return;
    }
    if (state === "question" && newAnswers(context.comments, context.bot, "").length === 0) {
      this.waitOnce(watched, key, "the issue has no VM; its question waits for an answer, which needs none");
      return;
    }
    if (pipeline.branch === "") {
      this.waitOnce(watched, key, `the issue has no VM at the step ${pipeline.step} and its record of version ${pipeline.version} names no branch to rebuild one from; left alone`, "warn");
      return;
    }
    await this.relabel(context, pipeline.step);
    this.replaceVm(domain, claudeToken, context);
  }

  /**
   * Replaces the lost VM of the issue in the background, as `claimAndStart` sets a new session up: a new VM with the
   * record's branch cloned, `.hunt/swf/` restored from the record and the step results on the issue, the step's run
   * started over (`Pipeline.restart`) and the runner started, which sends the step's prompt; then a comment on the issue.
   * A failure marks the issue as failed at its step.
   */
  private replaceVm(domain: string, claudeToken: string, context: SessionContext): void {
    const { key, github, labels, repo, issue, comments, bot, recordId, pipeline } = context;
    const sessionId = SessionId.of(this.deps.newId());
    const branch = BranchName.of(pipeline.branch);
    this.deps.log(`${key}: the issue has no VM at the step ${pipeline.step}; replacing it with ${sessionId.vm.name}, session ${sessionId.id}, branch ${branch.name}`);
    const setup: Setup = { key, repo, issue: issue.number, labels, sessionId, step: pipeline.step, isVmCreated: false, recordId, done: Promise.resolve() };
    this.setups.set(sessionId.vm.name, setup);
    setup.done = (async () => {
      try {
        const prepared = await this.prepareVm(setup, domain, branch, issue);
        // A new VM records the agent at plan; this one takes over at the pipeline's step.
        await this.deps.sessionVmService.recordSession(prepared.zone, sessionId, { [AGENT_METADATA]: pipeline.step });
        pipeline.restart(this.deps.now());
        await this.records.save(repo, recordId, pipeline);
        const results = resultsOfRuns(comments, bot, pipeline.runs);
        await this.startSession(setup, prepared, claudeToken, issue, branch, pipeline, results);
        await github.comment(repo, issue.number, replacedVmComment(pipeline.step, sessionId.vm.name));
        this.deps.log(`${key}: ${sessionId.vm.name} replaces the lost VM with ${results.length} step result(s) restored; the runner starts the step ${pipeline.step} over`);
      } catch (error) {
        await this.markFailed(setup, this.redacted(error));
      } finally {
        this.setups.delete(sessionId.vm.name);
      }
    })();
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

  /** Replaces the label of the setup's step with `<label>:failed` and comments the error of the setup; failures here are only logged. */
  private async markFailed(setup: Setup, error: string): Promise<void> {
    const { key, repo, issue, labels, sessionId, step } = setup;
    this.deps.log(`${key}: failed: ${error}`, "error");
    await this.failIssue(key, this.deps.github, repo, issue, labels, step, failureComment(error, setup.isVmCreated ? sessionId.vm.name : null));
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
