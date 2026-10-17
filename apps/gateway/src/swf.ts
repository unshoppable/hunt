/**
 * hunt-swf on the gateway (`hunt-swf.service`): starts a remote session for every open GitHub issue with the label
 * `swf` in the repositories the gateway's instance metadata lists (`swfConfig.ts`), polling every POLL_INTERVAL_MS,
 * since the gateway sits behind IAP and receives no webhooks.
 *
 *   node /srv/hunt/current/gateway/swf.mjs      (the bundle `nx build gateway` writes)
 *
 * Per issue, as long as fewer than `maxSessions` of its VMs (label `hunt-origin=swf`) are up: claim the issue first
 * (label `swf` → `swf:running` and a comment with the preview URLs), then do what a handoff of the desktop does
 * (`apps/client/src-tauri/src/remote/handoff.rs`), with a clone from GitHub in place of the push: the orchestrator
 * (`orchestrator.ts`) creates the session VM from the instance template, records the session in its metadata, waits for
 * its startup script and installs the session release staged on the gateway; then `install-tools`, `clone`, the
 * repository's private files (the ignored files a handoff copies, such as `.env.private`) from the secret
 * `HUNT_SWF_FILES_<owner>_<repo>` through `put-files`, `session-config`, `hunt-session.json` through `put-files
 * --claude`, `deps`, `start` with the tokens on stdin and `wait`. The session's system prompt holds the steps of the
 * workflow (`prompts/swf.system-prompt.md`: read the
 * issue, ask open questions, comment a plan, implement and check, open the pull request, clean up); then the issue
 * goes to the agent as its first prompt through the relay. The agent opens the pull request and sets `swf:done` or
 * `swf:failed` itself, or asks a question on the issue and sets `swf:question` until the answer arrives. When the setup fails, the poller sets `swf:failed` with the error and leaves the VM for inspection; Hunt
 * desktops adopt the VM either way.
 *
 * Every poll also follows the agent of each running session VM: the issue's labels give the agent's state (`running`,
 * `question`, `done`, `failed`; `swfPlan.ts`), which the VM's metadata `hunt-agent` records for Hunt's lists. While
 * the issue is still labelled `swf:running`, the relay's status (`hunt-ctl status`) tells whether the agent ended its
 * turn without finishing: then the poller reminds it once (`nudgePrompt`) and, when the next turn ends the same way,
 * marks the issue as failed. No reminder goes to a session a Hunt desktop is connected to, since a person is working
 * with the agent there. The reminders are remembered only in memory: after a restart of the poller a session may be
 * reminded once more. Between polls, the reaper (`reaper.ts`) deletes session VMs that have been stopped for more than
 * a week.
 *
 * The GitHub token (`HUNT_SWF_GITHUB_TOKEN`), the Claude Code OAuth token (`HUNT_SWF_CLAUDE_TOKEN`) and the private
 * files of each repository (`HUNT_SWF_FILES_<owner>_<repo>`, a gzipped tar archive, optional) come from Secret
 * Manager; project, zone, access token and configuration from the metadata server; the preview domain from what
 * `hunt-ctl install` wrote (`previewDomain.ts`). One log line per decision, Compute Engine call and command on a
 * session VM goes to the journal (`journal.ts`); tokens never appear in logs or comments. SIGHUP (the unit's reload, after an install) makes the poller exit once the sessions it
 * sets up are running, so that systemd starts the new release; SIGTERM marks those still being set up as failed and
 * exits. Runs on Node 24 through type stripping; no dependencies.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import gitPushPrompt from "../../../libs/domain/prompts/git-push.system-prompt.md?raw";
import questionPrompt from "../../../libs/domain/prompts/question.system-prompt.md?raw";
import remotePrompt from "../../../libs/domain/prompts/remote.system-prompt.md?raw";
import swfFirstPrompt from "../prompts/swf-first.user-prompt.md?raw";
import swfNudgePrompt from "../prompts/swf-nudge.user-prompt.md?raw";
import swfSystemPromptFile from "../prompts/swf.system-prompt.md?raw";
import { messageOf } from "../../../libs/domain/src/errors.ts";
import type { Log, LogLevel } from "../../../libs/domain/src/journal.ts";
import { sendPrompt, type Transport } from "./acpClient.ts";
import { createCompute, createMetadata, metadataValue, readOptionalSecretBytes, readSecret, type Compute, type Instance, type Metadata, type OptionalSecret } from "./gcp.ts";
import { writeLog } from "./journal.ts";
import { createGitHub, type GitHub, type Issue, type IssueComment } from "./github.ts";
import { AGENT_METADATA, DEFAULT_TEMPLATE, ORIGIN_LABEL, Orchestrator, sessionSummary, type Origin, type Reporter } from "./orchestrator.ts";
import { readDomain } from "./previewDomain.ts";
import { Reaper } from "./reaper.ts";
import { ensureSshKey, sessionVm, type SessionVm } from "./sessionVm.ts";
import { readSessionZones } from "./sessionZones.ts";
import { readSwfConfig, REPOS_ATTRIBUTE, SWF_LABEL, type SwfConfig } from "./swfConfig.ts";
import {
  activeSessionVms,
  agentStateOf,
  branchName,
  checkPrivateFilesArchive,
  claimComment,
  failureComment,
  firstPrompt,
  huntSessionFile,
  issuesToStart,
  labelSpecs,
  nudgePrompt,
  privateFilesSecret,
  redact,
  remoteSystemPrompt,
  sessionNames,
  stoppedComment,
  swfLabels,
  swfSystemPrompt,
  type PromptFiles,
  type SessionNames,
  type SwfLabels,
} from "./swfPlan.ts";

export const POLL_INTERVAL_MS = 30_000;
export const ORIGIN: Origin = "swf";
const GITHUB_SECRET = "HUNT_SWF_GITHUB_TOKEN";
const CLAUDE_SECRET = "HUNT_SWF_CLAUDE_TOKEN";
/** Secrets are read again after this long, so a new version takes effect without a restart. */
const SECRETS_TTL_MS = 10 * 60_000;
/** How long SIGTERM waits for the issues of unfinished setups to be marked as failed. */
const ABORT_TIMEOUT_MS = 20_000;

export interface Tokens {
  github: string;
  claude: string;
}

export interface PollerDeps {
  /** The configuration from the gateway's instance metadata. Throws for invalid attributes. */
  readConfig(): Promise<SwfConfig>;
  /** The preview domain of the gateway's edge proxy. Throws without one. */
  readDomain(): string;
  tokens(): Promise<Tokens>;
  /** The latest version of the optional secret `name` as bytes, or why there is none. */
  secretBytes(name: string): Promise<OptionalSecret>;
  github(token: string): GitHub;
  compute: Compute;
  orchestrator: Orchestrator;
  vm(name: string, zone: string): SessionVm;
  prompts(): PromptFiles;
  sendPrompt(transport: Transport, request: { sessionId: string; cwd: string; text: string }): Promise<string>;
  newId(): string;
  log(message: string, level?: LogLevel): void;
}

/** A session the poller is setting up: enough to mark its issue as failed when the poller has to stop. */
interface Setup {
  key: string;
  repo: string;
  issue: number;
  github: GitHub;
  labels: SwfLabels;
  names: SessionNames;
  isVmCreated: boolean;
  done: Promise<void>;
}

/** What the poller remembers about the agent of a running session between polls. */
interface Watched {
  /** The relay's `lastTurnEndedAt` the reminder answered; null while no reminder was sent. */
  remindedAt: number | null;
  /** The last error of following the session, so that a lasting one is logged once. */
  error: string;
}

/** The fields of `hunt-ctl status` the poller reads: the relay's status and the session's worktree. */
interface RelayStatus {
  acpSessionId: string;
  turn: string;
  clientConnected: boolean;
  lastTurnEndedAt: number | null;
  worktree: string;
}

/** The relay status of a `hunt-ctl status` result; null while the relay has no ACP session or the worktree is unknown. */
export function relayStatus(result: Record<string, unknown>): RelayStatus | null {
  const status = isRecord(result.status) ? result.status : {};
  const meta = isRecord(result.meta) ? result.meta : {};
  if (typeof status.acpSessionId !== "string" || !status.acpSessionId || typeof meta.worktree !== "string" || !meta.worktree) return null;
  return {
    acpSessionId: status.acpSessionId,
    turn: typeof status.turn === "string" ? status.turn : "",
    clientConnected: status.clientConnected === true,
    lastTurnEndedAt: typeof status.lastTurnEndedAt === "number" ? status.lastTurnEndedAt : null,
    worktree: meta.worktree,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One poll after another; see the module comment. */
export class Poller {
  private readonly deps: PollerDeps;
  /** Setups in progress by VM name; they count towards the limit until Compute Engine lists their VM. */
  private readonly setups = new Map<string, Setup>();
  /** The running sessions the poller follows, by VM name. */
  private readonly watched = new Map<string, Watched>();
  /** Repositories whose labels exist, by `<repo> <label>`. */
  private readonly labelledRepos = new Set<string>();
  private lastNote = "";
  /** The last error of each repository whose issues could not be listed, so that a lasting one is logged once. */
  private readonly repoErrors = new Map<string, string>();
  private secrets: string[] = [];

  constructor(deps: PollerDeps) {
    this.deps = deps;
  }

  /** Logs `message` unless it is the same as the last note, so a state that lasts is reported once. */
  private note(message: string, level: LogLevel = "info"): void {
    if (message === this.lastNote) return;
    this.lastNote = message;
    this.deps.log(message, level);
  }

  private redacted(error: unknown): string {
    return redact(messageOf(error), this.secrets);
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
    let tokens: Tokens;
    let vms: Instance[];
    try {
      tokens = await this.deps.tokens();
      this.secrets = [tokens.github, tokens.claude];
      vms = await this.deps.compute.listByLabel(ORIGIN_LABEL, ORIGIN);
    } catch (error) {
      this.note(`poll failed: ${this.redacted(error)}`, "error");
      return;
    }
    const github = this.deps.github(tokens.github);
    const labels = swfLabels(SWF_LABEL);
    await this.watchSessions(github, labels, vms);
    const active = activeSessionVms(vms, this.setups.keys());
    const issuesByRepo: { repo: string; issues: Issue[] }[] = [];
    for (const repo of config.repos) {
      try {
        issuesByRepo.push({ repo, issues: await github.openIssues(repo, labels.requested) });
        this.repoErrors.delete(repo);
      } catch (error) {
        const message = this.redacted(error);
        if (this.repoErrors.get(repo) !== message) {
          this.deps.log(`${repo}: ${message}`, "error");
        }
        this.repoErrors.set(repo, message);
      }
    }
    const { start, waiting } = issuesToStart(issuesByRepo, config.maxSessions - active.size);
    if (waiting.length > 0) {
      const keys = waiting.map(({ repo, issue }) => `${repo}#${issue.number}`).join(", ");
      this.note(`waiting: ${keys}; ${active.size} of ${config.maxSessions} sessions are up`);
    } else if (start.length === 0) {
      this.note(`polling ${config.repos.join(", ")}: no open issues labelled ${labels.requested}`);
    }
    for (const { repo, issue } of start) {
      await this.claimAndStart(domain, tokens, github, labels, repo, issue);
    }
  }

  /** Follows the agent of every running session VM that is not being set up; a failure with one VM is logged once. */
  private async watchSessions(github: GitHub, labels: SwfLabels, vms: Instance[]): Promise<void> {
    const running = new Set<string>();
    for (const instance of vms) {
      const session = sessionSummary(instance, instance.zone);
      if (!session || session.issue === null || instance.status !== "RUNNING" || this.setups.has(instance.name)) continue;
      running.add(instance.name);
      const watched = this.watched.get(instance.name) ?? { remindedAt: null, error: "" };
      this.watched.set(instance.name, watched);
      try {
        await this.watchSession(github, labels, instance, session.id, session.repo, session.issue, watched);
        watched.error = "";
      } catch (error) {
        const message = this.redacted(error);
        if (watched.error !== message) {
          this.deps.log(`${session.repo}#${session.issue}: ${message}`, "error");
        }
        watched.error = message;
      }
    }
    for (const vm of this.watched.keys()) {
      if (!running.has(vm)) {
        this.watched.delete(vm);
      }
    }
  }

  /**
   * Records the agent's state in the VM and, while the issue is still labelled running, reminds an agent that ended its
   * turn, or marks the issue as failed when the reminded turn ended the same way; see the module comment.
   */
  private async watchSession(github: GitHub, labels: SwfLabels, instance: Instance, id: string, repo: string, issue: number, watched: Watched): Promise<void> {
    const key = `${repo}#${issue}`;
    const state = agentStateOf(await github.issue(repo, issue), labels);
    if (metadataValue(instance, AGENT_METADATA) !== state) {
      await this.deps.orchestrator.recordSession(instance.zone, instance.name, id, { [AGENT_METADATA]: state });
      this.deps.log(`${key}: the agent is ${state}`);
    }
    if (state !== "running") return;
    const vm = this.deps.vm(instance.name, instance.zone);
    const status = relayStatus(await vm.huntCtl(["status", id]));
    if (!status || status.turn !== "idle" || status.clientConnected || status.lastTurnEndedAt === null) return;
    if (watched.remindedAt === null) {
      watched.remindedAt = status.lastTurnEndedAt;
      const text = nudgePrompt(this.deps.prompts().swfNudge, repo, issue, labels);
      const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: status.worktree, text });
      this.deps.log(`${key}: the agent ended its turn with the issue still labelled ${labels.running}; reminded it (prompt ${outcome})`);
    } else if (status.lastTurnEndedAt > watched.remindedAt) {
      watched.remindedAt = status.lastTurnEndedAt;
      this.deps.log(`${key}: the agent ended its turn again with the issue still labelled ${labels.running}; marking the issue as failed`, "warn");
      await this.failIssue(key, github, repo, issue, labels, stoppedComment(instance.name));
    }
  }

  /** Claims the issue and starts its setup in the background; an issue that cannot be claimed stays for the next poll. */
  private async claimAndStart(domain: string, tokens: Tokens, github: GitHub, labels: SwfLabels, repo: string, issue: Issue): Promise<void> {
    const key = `${repo}#${issue.number}`;
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

    const names = sessionNames(this.deps.newId());
    const branch = branchName(issue);
    this.deps.log(`${key}: claimed; session ${names.id} on ${names.vm}, branch ${branch}`);
    const setup: Setup = { key, repo, issue: issue.number, github, labels, names, isVmCreated: false, done: Promise.resolve() };
    this.setups.set(names.vm, setup);
    setup.done = (async () => {
      try {
        await github.addLabels(repo, issue.number, [labels.running]);
        await github.comment(repo, issue.number, claimComment(names, branch, domain));
        await this.setUp(setup, domain, tokens, branch, issue, comments);
      } catch (error) {
        await this.markFailed(setup, this.redacted(error));
      } finally {
        this.setups.delete(names.vm);
      }
    })();
  }

  private async ensureLabels(github: GitHub, repo: string, labels: SwfLabels): Promise<void> {
    const key = `${repo} ${labels.requested}`;
    if (this.labelledRepos.has(key)) return;
    for (const label of labelSpecs(labels)) {
      await github.ensureLabel(repo, label);
    }
    this.labelledRepos.add(key);
  }

  /** The handoff of the desktop, from the VM to the first prompt; see the module comment. */
  private async setUp(setup: Setup, domain: string, tokens: Tokens, branch: string, issue: Issue, comments: IssueComment[]): Promise<void> {
    const { key, repo, names } = setup;
    const log = (message: string) => this.deps.log(`${key}: ${message}`);
    const reporter: Reporter = {
      progress: (step) => {
        if (step === "creatingVm") {
          setup.isVmCreated = true;
        }
      },
      log,
    };
    const request = { id: names.id, repo, branch, title: issue.title, issue: issue.number, origin: ORIGIN, owner: "" };
    const provisioned = await this.deps.orchestrator.provision({ ...request, template: DEFAULT_TEMPLATE, machineType: null }, reporter);
    const vm = this.deps.vm(names.vm, provisioned.vm.zone);
    await vm.huntCtl(["install-tools"]);

    const cloned = await vm.huntCtl(["clone", names.id, "--repo", repo, "--branch", branch], `${tokens.github}\n`);
    if (typeof cloned.path !== "string" || !cloned.path) throw new Error("hunt-ctl clone returned no path");
    await this.putPrivateFiles(vm, key, names.id, repo);
    const sessionConfig = await vm.huntCtl(["session-config", names.id, "--domain", domain]);
    const servicesPrompt = typeof sessionConfig.services_prompt === "string" ? sessionConfig.services_prompt : null;
    const agentMd = typeof sessionConfig.agent_md === "string" ? sessionConfig.agent_md : null;
    const prompts = this.deps.prompts();
    const swfPrompt = swfSystemPrompt(prompts.swfSystem, repo, issue.number, branch, setup.labels);
    const systemPrompt = remoteSystemPrompt(prompts, swfPrompt, servicesPrompt, agentMd);
    await vm.putClaudeFiles(names.id, { "hunt-session.json": huntSessionFile(names.id, cloned.path, systemPrompt) });
    log(`cloned ${repo} into ${cloned.path}; installing the dependencies`);
    await vm.huntCtl(["deps", names.id]);
    await vm.huntCtl(["start", names.id], `${tokens.claude}\n${tokens.github}\n`);
    const status = await vm.huntCtl(["wait", names.id, "--timeout", "180"]);
    if (typeof status.acpSessionId !== "string" || !status.acpSessionId) throw new Error("the relay reports no ACP session");

    const text = firstPrompt(prompts.swfFirst, repo, issue, comments, branch, setup.labels);
    const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: cloned.path, text });
    log(`the agent of session ${names.id} works on the issue (prompt ${outcome})`);
  }

  /**
   * Unpacks the repository's private files, the gzipped tar archive in the secret `HUNT_SWF_FILES_<owner>_<repo>`, into
   * the session's worktree; a repository whose secret is absent (no version, or the gateway may not read it) gets
   * none, with a warning in the journal. The archive's content never reaches the log.
   */
  private async putPrivateFiles(vm: SessionVm, key: string, id: string, repo: string): Promise<void> {
    const name = privateFilesSecret(repo);
    const secret = await this.deps.secretBytes(name);
    if (!secret.bytes) {
      this.deps.log(`${key}: no private files: the secret ${name} ${secret.absent}`, "warn");
      return;
    }
    checkPrivateFilesArchive(secret.bytes, name);
    await vm.huntCtl(["put-files", id], secret.bytes);
    this.deps.log(`${key}: put the private files of ${repo} from the secret ${name} (${secret.bytes.length} bytes) into the worktree`);
  }

  /** Replaces `<label>:running` with `<label>:failed` and comments the error of the setup; failures here are only logged. */
  private async markFailed(setup: Setup, error: string): Promise<void> {
    const { key, repo, issue, github, labels, names } = setup;
    this.deps.log(`${key}: failed: ${error}`, "error");
    await this.failIssue(key, github, repo, issue, labels, failureComment(error, setup.isVmCreated ? names.vm : null));
  }

  /** Replaces `<label>:running` with `<label>:failed` and comments `comment`; failures here are only logged. */
  private async failIssue(key: string, github: GitHub, repo: string, issue: number, labels: SwfLabels, comment: string): Promise<void> {
    const steps: [string, () => Promise<unknown>][] = [
      [`remove ${labels.running}`, () => github.removeLabel(repo, issue, labels.running)],
      [`add ${labels.failed}`, () => github.addLabels(repo, issue, [labels.failed])],
      ["comment on the issue", () => github.comment(repo, issue, comment)],
    ];
    for (const [what, step] of steps) {
      try {
        await step();
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

/** The tokens from Secret Manager, read again after SECRETS_TTL_MS. */
function secretsReader(metadata: Metadata): () => Promise<Tokens> {
  let cached: { tokens: Tokens; readAt: number } | null = null;
  return async () => {
    if (cached && Date.now() - cached.readAt < SECRETS_TTL_MS) return cached.tokens;
    const [github, claude] = await Promise.all([readSecret(metadata, GITHUB_SECRET), readSecret(metadata, CLAUDE_SECRET)]);
    cached = { tokens: { github, claude }, readAt: Date.now() };
    return cached.tokens;
  };
}

/** The prompt files, bundled into the poller at build time. */
function readPrompts(): PromptFiles {
  return {
    remote: remotePrompt,
    gitPush: gitPushPrompt,
    question: questionPrompt,
    swfSystem: swfSystemPromptFile,
    swfFirst: swfFirstPrompt,
    swfNudge: swfNudgePrompt,
  };
}

async function main(): Promise<void> {
  const log: Log = (message, level) => writeLog(redact(message, []), level);
  ensureSshKey("hunt-swf");
  const metadata = createMetadata();
  const location = { project: await metadata.project(), zone: await metadata.zone() };
  const compute = createCompute(metadata, fetch, log);
  const vm = (name: string, zone: string) => sessionVm(name, { project: location.project, zone }, log);
  let wake = () => {};
  let isStopping = false;
  const orchestrator = new Orchestrator({
    compute,
    location,
    zones: () => readSessionZones(location.zone),
    vm,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
  const poller = new Poller({
    readConfig: () => readSwfConfig(metadata),
    readDomain: () => readDomain(),
    tokens: secretsReader(metadata),
    secretBytes: (name) => readOptionalSecretBytes(metadata, name),
    github: (token) => createGitHub(token),
    compute,
    orchestrator,
    vm,
    prompts: readPrompts,
    sendPrompt,
    newId: randomUUID,
    log,
  });
  const reaper = new Reaper({ compute, orchestrator, zone: location.zone, now: Date.now, log });

  process.on("SIGHUP", () => {
    log("reload: exiting once the sessions being set up run");
    isStopping = true;
    wake();
  });
  process.on("SIGTERM", () => {
    log("stopping: marking the sessions being set up as failed");
    const timeout = setTimeout(() => process.exit(0), ABORT_TIMEOUT_MS);
    void poller.abort("the gateway's poller stopped while it set the session up").finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });

  log(`polling every ${POLL_INTERVAL_MS / 1000} s in ${location.project}/${location.zone}`);
  while (!isStopping) {
    try {
      await poller.cycle();
    } catch (error) {
      log(`poll failed: ${redact(messageOf(error), [])}`, "error");
    }
    await reaper.cycle();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await poller.drain();
  process.exit(0);
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    writeLog(redact(messageOf(error), []), "fatal");
    process.exit(1);
  });
}
