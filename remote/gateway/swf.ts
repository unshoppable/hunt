/**
 * hunt-swf on the gateway (`hunt-swf.service`): starts a remote session for every open GitHub issue with the label
 * `swf` in the repositories of `/etc/hunt/swf.json` (`swfConfig.ts`), polling every POLL_INTERVAL_MS, since the gateway
 * sits behind IAP and receives no webhooks.
 *
 *   node remote/gateway/swf.ts
 *
 * Per issue, as long as fewer than `maxSessions` of its VMs (label `hunt-origin=swf`) are up: claim the issue first
 * (label `swf` → `swf:running` and a comment with the preview URL), then do what a handoff of the desktop does
 * (`src-tauri/src/remote/handoff.rs`), with a clone from GitHub in place of the push: create the session VM from the
 * instance template, record the session in its metadata, wait for its startup script, install the gateway's own
 * release on it, `hunt-ctl clone`, `session-config`, `hunt-session.json` through `put-files --claude`, `deps`, `start`
 * with the tokens on stdin and `wait`. Then the issue goes to the agent as its first prompt through the relay; the
 * agent opens the pull request and sets `swf:done` or `swf:failed` itself. When the setup fails, the poller sets
 * `swf:failed` with the error and leaves the VM for inspection; Hunt desktops adopt the VM either way.
 *
 * The GitHub token (`hunt-swf-github-token`) and the Claude Code OAuth token (`hunt-swf-claude-token`) come from Secret
 * Manager; project, zone and access token from the metadata server; the preview domain from what `hunt-ctl install`
 * wrote. One log line per decision goes to stdout (journald); tokens never appear in logs or comments. SIGHUP (the
 * unit's reload, after an install) makes the poller exit once the sessions it sets up are running, so that systemd
 * starts the new release; SIGTERM marks those still being set up as failed and exits. Runs on Node 24 through type
 * stripping; no dependencies.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sendPrompt, type Transport } from "./acpClient.ts";
import { createCompute, createMetadata, mergeMetadataItems, readSecret, type Compute, type Instance, type Metadata } from "./gcp.ts";
import { createGitHub, type GitHub, type Issue, type IssueComment } from "./github.ts";
import { sessionVm, type SessionVm } from "./sessionVm.ts";
import { readSwfConfig, SWF_CONFIG_PATH, type SwfConfig } from "./swfConfig.ts";
import {
  activeSessionVms,
  branchName,
  claimComment,
  failureComment,
  firstPrompt,
  huntSessionFile,
  issuesToStart,
  labelSpecs,
  redact,
  remoteSystemPrompt,
  sessionNames,
  swfLabels,
  type RemotePrompts,
  type SessionNames,
  type SwfLabels,
} from "./swfPlan.ts";

export const POLL_INTERVAL_MS = 120_000;
export const ORIGIN_LABEL = "hunt-origin";
export const ORIGIN = "swf";
const DOMAIN_FILE = "/etc/hunt/preview-domain";
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const GITHUB_SECRET = "hunt-swf-github-token";
const CLAUDE_SECRET = "hunt-swf-claude-token";
/** Secrets are read again after this long, so a new version takes effect without a restart. */
const SECRETS_TTL_MS = 10 * 60_000;
const CREATE_TIMEOUT_MS = 2 * 60_000;
const START_TIMEOUT_MS = 6 * 60_000;
const READY_TIMEOUT_MS = 15 * 60_000;
const INSTANCE_POLL_MS = 3_000;
/** How long SIGTERM waits for the issues of unfinished setups to be marked as failed. */
const ABORT_TIMEOUT_MS = 20_000;

export interface Tokens {
  github: string;
  claude: string;
}

export interface PollerDeps {
  /** The configuration; null without one. Throws for an invalid file. */
  readConfig(): SwfConfig | null;
  /** The preview domain of the gateway's edge proxy. Throws without one. */
  readDomain(): string;
  tokens(): Promise<Tokens>;
  github(token: string): GitHub;
  compute: Compute;
  vm(name: string): SessionVm;
  prompts(): RemotePrompts;
  sendPrompt(transport: Transport, request: { sessionId: string; cwd: string; text: string }): Promise<string>;
  newId(): string;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
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

export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** One poll after another; see the module comment. */
export class Poller {
  private readonly deps: PollerDeps;
  /** Setups in progress by VM name; they count towards the limit until Compute Engine lists their VM. */
  private readonly setups = new Map<string, Setup>();
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
  private note(message: string): void {
    if (message === this.lastNote) return;
    this.lastNote = message;
    this.deps.log(message);
  }

  private redacted(error: unknown): string {
    return redact(messageOf(error), this.secrets);
  }

  /** One poll: claims the issues that get a session now and starts their setups in the background. */
  async cycle(): Promise<void> {
    let config: SwfConfig | null;
    let domain: string;
    try {
      config = this.deps.readConfig();
      if (!config || config.repos.length === 0) {
        this.note(`idle: ${SWF_CONFIG_PATH} lists no repositories`);
        return;
      }
      domain = this.deps.readDomain();
    } catch (error) {
      this.note(`idle: ${this.redacted(error)}`);
      return;
    }
    let tokens: Tokens;
    let vms: Instance[];
    try {
      tokens = await this.deps.tokens();
      this.secrets = [tokens.github, tokens.claude];
      vms = await this.deps.compute.listByLabel(ORIGIN_LABEL, ORIGIN);
    } catch (error) {
      this.note(`poll failed: ${this.redacted(error)}`);
      return;
    }
    const github = this.deps.github(tokens.github);
    const labels = swfLabels(config.label);
    const active = activeSessionVms(vms, this.setups.keys());
    const issuesByRepo: { repo: string; issues: Issue[] }[] = [];
    for (const repo of config.repos) {
      try {
        issuesByRepo.push({ repo, issues: await github.openIssues(repo, labels.requested) });
        this.repoErrors.delete(repo);
      } catch (error) {
        const message = this.redacted(error);
        if (this.repoErrors.get(repo) !== message) {
          this.deps.log(`${repo}: ${message}`);
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
      await this.claimAndStart(config, domain, tokens, github, labels, repo, issue);
    }
  }

  /** Claims the issue and starts its setup in the background; an issue that cannot be claimed stays for the next poll. */
  private async claimAndStart(config: SwfConfig, domain: string, tokens: Tokens, github: GitHub, labels: SwfLabels, repo: string, issue: Issue): Promise<void> {
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
      this.deps.log(`${key}: failed to claim the issue: ${this.redacted(error)}`);
      return;
    }

    const names = sessionNames(this.deps.newId());
    const branch = branchName(issue.number, issue.title);
    this.deps.log(`${key}: claimed; session ${names.id} on ${names.vm}, branch ${branch}`);
    const setup: Setup = { key, repo, issue: issue.number, github, labels, names, isVmCreated: false, done: Promise.resolve() };
    this.setups.set(names.vm, setup);
    setup.done = (async () => {
      try {
        await github.addLabels(repo, issue.number, [labels.running]);
        await github.comment(repo, issue.number, claimComment(names, branch, domain));
        await this.setUp(setup, config, domain, tokens, branch, issue, comments);
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
  private async setUp(setup: Setup, config: SwfConfig, domain: string, tokens: Tokens, branch: string, issue: Issue, comments: IssueComment[]): Promise<void> {
    const { key, repo, names } = setup;
    const log = (message: string) => this.deps.log(`${key}: ${message}`);
    await this.deps.compute.insert({
      name: names.vm,
      template: config.template,
      machineType: config.machineType,
      labels: { "hunt-role": "session", "hunt-session": names.short, [ORIGIN_LABEL]: ORIGIN },
    });
    setup.isVmCreated = true;
    log(`creating ${names.vm} from ${config.template}`);
    await this.waitForInstance(names.vm, (instance) => instance !== null, CREATE_TIMEOUT_MS, "appear");
    await this.setSessionMetadata(names.vm, {
      "hunt-session-id": names.id,
      "hunt-repo": repo,
      "hunt-branch": branch,
      "hunt-title": issue.title,
      "hunt-issue": String(issue.number),
    });
    await this.waitForInstance(names.vm, (instance) => instance?.status === "RUNNING", START_TIMEOUT_MS, "start");
    const vm = this.deps.vm(names.vm);
    await vm.waitUntilReady(READY_TIMEOUT_MS);
    log(`${names.vm} is ready; installing the bundle`);
    await vm.installBundle();

    const cloned = await vm.huntCtl(["clone", names.id, "--repo", repo, "--branch", branch], `${tokens.github}\n`);
    if (typeof cloned.path !== "string" || !cloned.path) throw new Error("hunt-ctl clone returned no path");
    const sessionConfig = await vm.huntCtl(["session-config", names.id, "--domain", domain]);
    const huntMd = typeof sessionConfig.hunt_md === "string" ? sessionConfig.hunt_md : null;
    const systemPrompt = remoteSystemPrompt(this.deps.prompts(), huntMd);
    await vm.putClaudeFiles(names.id, { "hunt-session.json": huntSessionFile(names.id, cloned.path, systemPrompt) });
    log(`cloned ${repo} into ${cloned.path}; installing the dependencies`);
    await vm.huntCtl(["deps", names.id]);
    await vm.huntCtl(["start", names.id], `${tokens.claude}\n${tokens.github}\n`);
    const status = await vm.huntCtl(["wait", names.id, "--timeout", "180"]);
    if (typeof status.acpSessionId !== "string" || !status.acpSessionId) throw new Error("the relay reports no ACP session");

    const text = firstPrompt(repo, issue, comments, branch, setup.labels);
    const outcome = await this.deps.sendPrompt(vm.openRelay(), { sessionId: status.acpSessionId, cwd: cloned.path, text });
    log(`the agent of session ${names.id} works on the issue (prompt ${outcome})`);
  }

  private async waitForInstance(name: string, isDone: (instance: Instance | null) => boolean, timeoutMs: number, what: string): Promise<void> {
    for (let waited = 0; ; waited += INSTANCE_POLL_MS) {
      const instance = await this.deps.compute.get(name);
      if (isDone(instance)) return;
      if (waited >= timeoutMs) throw new Error(`failed to ${what} ${name}: it is still ${instance?.status ?? "missing"} after ${timeoutMs / 60_000} minutes`);
      await this.deps.sleep(INSTANCE_POLL_MS);
    }
  }

  /** Adds `entries` to the VM's metadata, keeping the template's keys; retries when the metadata changed meanwhile. */
  private async setSessionMetadata(name: string, entries: Record<string, string>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const instance = await this.deps.compute.get(name);
      if (!instance) throw new Error(`failed to set the metadata of ${name}: it does not exist`);
      try {
        await this.deps.compute.setMetadata(name, instance.metadata.fingerprint, mergeMetadataItems(instance.metadata.items, entries));
        return;
      } catch (error) {
        if (attempt >= 3 || !messageOf(error).includes("HTTP 412")) throw error;
      }
    }
  }

  /** Replaces `<label>:running` with `<label>:failed` and comments the error; failures here are only logged. */
  private async markFailed(setup: Setup, error: string): Promise<void> {
    const { key, repo, issue, github, labels, names } = setup;
    this.deps.log(`${key}: failed: ${error}`);
    const steps: [string, () => Promise<unknown>][] = [
      [`remove ${labels.running}`, () => github.removeLabel(repo, issue, labels.running)],
      [`add ${labels.failed}`, () => github.addLabels(repo, issue, [labels.failed])],
      ["comment the error", () => github.comment(repo, issue, failureComment(error, setup.isVmCreated ? names.vm : null))],
    ];
    for (const [what, step] of steps) {
      try {
        await step();
      } catch (stepError) {
        this.deps.log(`${key}: failed to ${what}: ${this.redacted(stepError)}`);
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

function readDomain(): string {
  let domain: string;
  try {
    domain = readFileSync(DOMAIN_FILE, "utf8").trim();
  } catch (error) {
    throw new Error(`no preview domain in ${DOMAIN_FILE}: ${messageOf(error)}`);
  }
  if (!DOMAIN_PATTERN.test(domain)) throw new Error(`${DOMAIN_FILE} holds no host name`);
  return domain;
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

/** The remote prompts of the release this poller runs from. */
function readPrompts(): RemotePrompts {
  const read = (name: string) => readFileSync(new URL(`../session/prompts/${name}`, import.meta.url), "utf8");
  return { remote: read("remote.md"), gitPush: read("git-push.md") };
}

/**
 * Creates the SSH key gcloud logs in with, so that two setups that start at once do not both create it. gcloud
 * registers it with OS Login on every connect.
 */
function ensureSshKey(): void {
  const dir = join(homedir(), ".ssh");
  if (existsSync(join(dir, "google_compute_engine"))) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = spawnSync("ssh-keygen", ["-t", "rsa", "-b", "3072", "-N", "", "-C", "hunt-swf", "-q", "-f", join(dir, "google_compute_engine")], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`failed to create the SSH key in ${dir}`);
}

async function main(): Promise<void> {
  const log = (message: string) => console.log(`hunt-swf: ${message}`);
  ensureSshKey();
  const metadata = createMetadata();
  const location = { project: await metadata.project(), zone: await metadata.zone() };
  let wake = () => {};
  let isStopping = false;
  const poller = new Poller({
    readConfig: () => readSwfConfig(),
    readDomain,
    tokens: secretsReader(metadata),
    github: (token) => createGitHub(token),
    compute: createCompute(metadata),
    vm: (name) => sessionVm(name, location),
    prompts: readPrompts,
    sendPrompt,
    newId: randomUUID,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  });

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
      log(`poll failed: ${redact(messageOf(error), [])}`);
    }
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
    console.log(`hunt-swf: ${redact(messageOf(error), [])}`);
    process.exit(1);
  });
}
