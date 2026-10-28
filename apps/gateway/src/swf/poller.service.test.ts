import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { PullRequestState } from "../../../../libs/domain/src/swf/pull-request-state.value-object.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { Transport } from "../session-vm/relay.client.ts";
import type { Compute, Instance, InstanceRequest, MetadataItem } from "../gcp/compute-engine.client.ts";
import type { GitHub, Issue, IssueComment } from "./github.client.ts";
import { SessionVmService } from "../session-vm/session-vm.service.ts";
import type { ReadyAnswer, SessionVmSsh } from "../session-vm/session-vm-ssh.client.ts";
import type { GitHubApp } from "./github-app.client.ts";
import { HUMAN_REVIEW_PR_LABEL, Poller, type PollerDeps } from "./poller.service.ts";
import { readSwfConfig, type SwfConfig } from "./swf-config.utils.ts";
import { Pipeline, type PullRequestReview } from "./pipeline.domain.ts";
import { closedComment, humanReviewComment, stoppedComment } from "./swf-comments.utils.ts";
import { SKILLS } from "./swf.fixtures.ts";
import { badResultPrompt } from "./swf-prompts.utils.ts";

function readPrompt(name: string): string {
  return readFileSync(new URL(`../../software-factory/${name}.user-prompt.md`, import.meta.url), "utf8");
}

const GITHUB_TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const BOT_NAME = "hunt-claude[bot]";
const BOT_EMAIL = "4242+hunt-claude[bot]@users.noreply.github.com";
const CLAUDE_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";
const CONFIG: SwfConfig = { repos: [Repository.fromSlug("acme/app")], maxSessions: 2 };
const SESSION_ID = "ab12cd34-0000-4000-8000-000000000001";
const VM = "vm-hunt-s-ab12cd34";
/** The hunt-ctl call that hands the VM the repository's GitHub token. */
const TOKEN_CALL = `hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`;
const KEY = "acme/app#12";
/** The id of the poller's record comment on acme/app#12 in the sessions the tests follow. */
const RECORD_ID = 1000;
/** The id of the first comment the fake GitHub posts. */
const FIRST_POSTED_ID = 5000;
const PULL_REQUEST = 31;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  const url = `https://github.com/acme/app/issues/${number}`;
  return { number, title, body: `Body of ${number}`, author: "alice", createdAt: "2026-10-13T08:00:00Z", url, labels, state: "open", assignees: [] };
}

interface FakeGitHubOptions {
  /** Issues whose label someone else removed meanwhile. */
  labelGone?: number[];
  /** The single issues by `<repo>#<number>` (null: deleted); label changes apply to them. */
  lookup?: Record<string, Issue | null>;
  /** The comments by `<repo>#<number>`; an issue or pull request without an entry has one comment of bob. */
  threads?: Record<string, IssueComment[]>;
  /** The titles of the projects the issue moves in. */
  projects?: string[];
  projectsFail?: boolean;
  /** The pull requests by number; label changes apply to them. */
  pullRequests?: Record<number, PullRequestState>;
  /** The files every pull request changes. */
  files?: string[];
  reviews?: PullRequestReview[];
  /** The inline comments of every review. */
  reviewComments?: string[];
}

type FakeGitHub = GitHub & {
  calls: string[];
  threads: Record<string, IssueComment[]>;
  /** Every edit of a comment, oldest first. */
  updates: { id: number; body: string }[];
};

/**
 * A GitHub whose open issues with the label are `issues` by repository and the rest as `options` scripts it; every call
 * is recorded as one line. Labels added or removed change the stored issues and pull requests, posted comments (by the
 * bot, ids from FIRST_POSTED_ID) and edits change the threads, so a later poll sees them.
 */
function fakeGitHub(issues: Record<string, Issue[]>, options: FakeGitHubOptions = {}): FakeGitHub {
  const calls: string[] = [];
  const threads = options.threads ?? {};
  const updates: { id: number; body: string }[] = [];
  let nextCommentId = FIRST_POSTED_ID;
  const threadOf = (repo: Repository, number: number): IssueComment[] => {
    threads[`${repo.slug}#${number}`] ??= [{ id: 1, author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Please hurry." }];
    return threads[`${repo.slug}#${number}`];
  };
  const changeLabels = (repo: Repository, number: number, change: (labels: string[]) => string[]) => {
    const stored = options.lookup?.[`${repo.slug}#${number}`];
    if (stored) {
      stored.labels = change(stored.labels);
    }
    const pullRequest = options.pullRequests?.[number];
    if (pullRequest) {
      pullRequest.labels = change(pullRequest.labels);
    }
  };
  return {
    calls,
    threads,
    updates,
    openIssues: async (repo, label) => {
      calls.push(`issues ${repo.slug} ${label}`);
      return issues[repo.slug] ?? [];
    },
    issue: async (repo, number) => {
      calls.push(`issue ${repo.slug}#${number}`);
      const stored = options.lookup?.[`${repo.slug}#${number}`];
      return stored ? structuredClone(stored) : null;
    },
    comments: async (repo, number) => {
      calls.push(`comments ${repo.slug}#${number}`);
      return structuredClone(threadOf(repo, number));
    },
    removeLabel: async (repo, number, label) => {
      calls.push(`unlabel ${repo.slug}#${number} ${label}`);
      changeLabels(repo, number, (labels) => labels.filter((name) => name !== label));
      return !options.labelGone?.includes(number);
    },
    addLabels: async (repo, number, labels) => {
      calls.push(`label ${repo.slug}#${number} ${labels.join(",")}`);
      changeLabels(repo, number, (current) => [...current, ...labels.filter((label) => !current.includes(label))]);
    },
    comment: async (repo, number, body) => {
      calls.push(`comment ${repo.slug}#${number} ${body}`);
      const id = nextCommentId++;
      threadOf(repo, number).push({ id, author: BOT_NAME, createdAt: "2026-10-15T08:00:00Z", body });
      return id;
    },
    updateComment: async (repo, id, body) => {
      calls.push(`update ${repo.slug} ${id}`);
      updates.push({ id, body });
      for (const thread of Object.values(threads)) {
        for (const comment of thread) {
          if (comment.id === id) {
            comment.body = body;
          }
        }
      }
    },
    pullRequest: async (repo, number) => {
      calls.push(`pull ${repo.slug}#${number}`);
      const pullRequest = options.pullRequests?.[number];
      return pullRequest ? new PullRequestState(pullRequest.toJSON()) : null;
    },
    pullRequestFiles: async (repo, number) => {
      calls.push(`files ${repo.slug}#${number}`);
      return [...(options.files ?? [])];
    },
    reviews: async (repo, number) => {
      calls.push(`reviews ${repo.slug}#${number}`);
      return structuredClone(options.reviews ?? []);
    },
    reviewComments: async (repo, number, review) => {
      calls.push(`review-comments ${repo.slug}#${number} ${review}`);
      return [...(options.reviewComments ?? [])];
    },
    requestReviewers: async (repo, number, logins) => {
      calls.push(`request ${repo.slug}#${number} ${logins.join(",")}`);
    },
    updateBranch: async (repo, number) => {
      calls.push(`update-branch ${repo.slug}#${number}`);
    },
    merge: async (repo, number) => {
      calls.push(`merge ${repo.slug}#${number}`);
    },
    ensureLabel: async (repo, label) => {
      calls.push(`ensure ${repo.slug} ${label.name}`);
    },
    moveToStatus: async (repo, number, status) => {
      calls.push(`move ${repo.slug}#${number} ${status}`);
      if (options.projectsFail) throw new Error("HTTP 403 Resource not accessible by integration");
      return options.projects ?? [];
    },
  };
}

/** The calls of `github` that change something on GitHub. */
function writes(github: FakeGitHub): string[] {
  const reads = ["issues ", "issue ", "comments ", "pull ", "files ", "reviews ", "review-comments "];
  return github.calls.filter((call) => !reads.some((read) => call.startsWith(read)));
}

/** The record of the last edit of a comment; null without a usable one. */
function lastRecord(github: FakeGitHub): Pipeline | null {
  return Pipeline.fromComment(github.updates.at(-1)?.body ?? "");
}

/** A VM as Compute Engine lists it, with the template's metadata and `metadata` on top. */
function listedVm(name: string, status: string, labels: Record<string, string> = {}, metadata: Record<string, string> = {}): Instance {
  return {
    name,
    zone: "europe-west3-a",
    status,
    creationTimestamp: "2026-10-13T08:00:00.000-07:00",
    lastStopTimestamp: "",
    lastSuspendedTimestamp: "",
    labels,
    metadata: { fingerprint: "fp0", items: [{ key: "startup-script", value: "#!/bin/sh" }, ...Object.entries(metadata).map(([key, value]) => ({ key, value }))] },
    disks: [],
    machineType: "c4d-standard-8",
  };
}

/** The running VM of session SESSION_ID for acme/app#12, as the poller created it, with the agent state `agent`. */
function sessionVmOf(agent: string): Instance {
  const metadata = { "hunt-session-id": SESSION_ID, "hunt-repo": "acme/app", "hunt-branch": "feat/general/12-issue-12", "hunt-title": "Issue 12", "hunt-issue": "12", "hunt-agent": agent };
  return listedVm(VM, "RUNNING", { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" }, metadata);
}

/** A Compute whose label listing returns `listed`; inserted VMs appear as PROVISIONING and run from their third look on. */
function fakeCompute(listed: Instance[] = [], insertError?: Error): Compute & { calls: string[]; inserted: InstanceRequest[]; metadata: MetadataItem[][] } {
  const calls: string[] = [];
  const inserted: InstanceRequest[] = [];
  const metadata: MetadataItem[][] = [];
  const vms = new Map<string, { instance: Instance; looks: number }>();
  const unexpected = async (name: string) => {
    throw new Error(`unexpected call for ${name}`);
  };
  return {
    calls,
    inserted,
    metadata,
    list: async () => listed,
    listByLabel: async (key, value) => {
      calls.push(`list ${key}=${value}`);
      return listed;
    },
    locate: async (name) => {
      const vm = vms.get(name);
      return vm ? structuredClone(vm.instance) : null;
    },
    get: async (_zone, name) => {
      const vm = vms.get(name);
      if (!vm) return listed.find((instance) => instance.name === name) ?? null;
      vm.looks++;
      vm.instance.status = vm.looks < 3 ? "PROVISIONING" : "RUNNING";
      return structuredClone(vm.instance);
    },
    insert: async (zone, request) => {
      calls.push(`insert ${request.name}`);
      if (insertError) throw insertError;
      inserted.push(request);
      vms.set(request.name, { instance: listedVm(request.name, "PROVISIONING", request.labels), looks: 0 });
      return { name: "operation-1", zone };
    },
    waitOperation: async () => ({ isDone: true, error: null }),
    setMetadata: async (_zone, name, fingerprint, items) => {
      calls.push(`metadata ${name} ${fingerprint}`);
      metadata.push(items);
      const instance = vms.get(name)?.instance ?? listed.find((candidate) => candidate.name === name);
      instance!.metadata = { fingerprint: `${fingerprint}+`, items };
    },
    start: unexpected,
    resume: unexpected,
    suspend: unexpected,
    stop: unexpected,
    setDiskAutoDelete: unexpected,
    delete: unexpected,
    setName: unexpected,
    getDisk: unexpected,
    createSnapshot: unexpected,
    deleteSnapshot: unexpected,
  };
}

/** Lets Compute Engine start or resume the listed VMs: `locate` finds them, and a start or resume makes one run. */
function startable(compute: ReturnType<typeof fakeCompute>, listed: Instance[]): void {
  compute.locate = async (name) => listed.find((instance) => instance.name === name) ?? null;
  for (const verb of ["start", "resume"] as const) {
    compute[verb] = async (zone, name) => {
      compute.calls.push(`${verb} ${name}`);
      listed.find((instance) => instance.name === name)!.status = "RUNNING";
      return { name: `operation-${verb}`, zone };
    };
  }
}

/** Lets the background start of a VM run until `logs` holds `line`, for at most ten turns of the event loop. */
async function settle(logs: string[], line: string): Promise<void> {
  for (let turn = 0; turn < 10 && !logs.includes(line); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The `hunt-ctl status` result of a relay whose last turn ended at `lastTurnEndedAt` (null: none ended yet). */
function statusOf(turn: "running" | "idle", lastTurnEndedAt: number | null, clientConnected = false): Record<string, unknown> {
  return { relay: "running", status: { state: "ready", acpSessionId: "acp-9", turn, clientConnected, lastTurnEndedAt }, meta: { worktree: "/home/agent/app" } };
}

/**
 * A session VM that records every hunt-ctl call with its stdin, fails the one named in `failing` and answers `status`
 * with the result of `status()`.
 */
function fakeVm(failing?: { command: string; error: Error }, status: () => Record<string, unknown> = () => statusOf("running", null)) {
  const calls: string[] = [];
  const claudeFiles: Record<string, string>[] = [];
  const vm: SessionVmSsh = {
    run: async () => "",
    huntCtl: async (args, input = "") => {
      calls.push(`hunt-ctl ${args.join(" ")}${input ? ` <<< ${JSON.stringify(String(input))}` : ""}`);
      if (failing?.command === args[0]) throw failing.error;
      switch (args[0]) {
        case "status":
          return status();
        case "clone":
          return { path: "/home/agent/app" };
        case "session-config":
          return {
            services_prompt: "### The repository's services\n- `ui`: port 4200\n",
            agent_md: "# Services\nStart the UIs.",
            swf_model: "claude-opus-5-5",
            swf_human_review_paths: ["**/migrations/**", 7],
            swf_skills: { ...SKILLS, plan: "acme-plan", review: "nope" },
          };
        case "wait":
          return { state: "ready", acpSessionId: "acp-9" };
        default:
          return {};
      }
    },
    waitUntilReady: async () => {
      calls.push("wait until ready");
      return { installedHash: "", hasSecrets: false };
    },
    ensureRelease: async () => {
      calls.push("ensure release");
      return { version: "session@1.4.0", protocol: 1 };
    },
    putClaudeFiles: async (sessionId, files) => {
      calls.push(`put-files ${sessionId.id} --claude ${Object.keys(files).join(",")}`);
      claudeFiles.push(files);
    },
    idleDecision: async () => "keep: a turn is running",
    openRelay: () => ({}) as Transport,
  };
  return { vm, calls, claudeFiles };
}

/** A GitHub App whose installation token for every repository is the last one given to `setToken`. */
function fakeGitHubApp(): GitHubApp & { setToken(token: string): void } {
  let token = GITHUB_TOKEN;
  const minted = [token];
  return {
    setToken: (next) => {
      token = next;
      minted.push(next);
    },
    tokenFor: async () => token,
    identity: async () => ({ name: BOT_NAME, email: BOT_EMAIL }),
    secrets: () => [...minted],
  };
}

type Overrides = Omit<Partial<PollerDeps>, "github" | "vm" | "sessionVmService" | "githubApp"> & { github?: GitHub; vm?: SessionVmSsh; githubApp?: GitHubApp };

function createPoller({ github = fakeGitHub({}), vm = fakeVm().vm, compute = fakeCompute(), githubApp = fakeGitHubApp(), ...overrides }: Overrides = {}) {
  const logs: string[] = [];
  const prompts: { sessionId: string; cwd: string; text: string }[] = [];
  let tokenReads = 0;
  const sessionVmService = new SessionVmService({
    compute,
    location: { project: "medconomy-hunt", zone: "europe-west3-a" },
    zones: () => ["europe-west3-a"],
    vm: () => vm,
    remoteSecrets: async () => ({}),
    sleep: async () => {},
    now: () => 0,
  });
  const deps: PollerDeps = {
    readConfig: async () => CONFIG,
    readDomain: () => "hunt.example.com",
    secrets: async () => {
      tokenReads++;
      return { claude: CLAUDE_TOKEN, app: { appId: "4711", privateKey: {} as never } };
    },
    secretBytes: async () => ({ absent: "has no version" }),
    compute,
    sessionVmService,
    prompts: () => ({
      remote: "## Remote session\n",
      gitPush: "### Git\n",
      question: "## Questions\n",
      sessions: "## Sessions {{huntSessionId}}\n",
      swfSystem: "## Issue #{{number}} on {{branch}}\n",
      swfPlan: readPrompt("1-plan"),
      swfImplement: readPrompt("2-implement"),
      swfEscalate: readPrompt("2-implement-escalate"),
      swfVerify: readPrompt("3-verify"),
      swfGate: readPrompt("4-gate"),
      swfPr: readPrompt("5-pr"),
      swfNudge: readPrompt("nudge"),
      swfAnswer: readPrompt("answer"),
      swfBadResult: readPrompt("bad-result"),
    }),
    sendPrompt: async (_transport, request) => {
      prompts.push(request);
      return "started";
    },
    newId: () => SESSION_ID,
    log: (message) => logs.push(message),
    ...overrides,
    github,
    githubApp,
    vm: () => vm,
  };
  return { poller: new Poller(deps), logs, prompts, tokenReads: () => tokenReads };
}

/** The pipeline record of acme/app#12 at `step`, a fresh one apart from `fields`. */
function recordAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...Pipeline.start([], SKILLS).toJSON(), step, ...fields });
}

/** The comments of acme/app#12: the poller's record comment with `record`, then `comments`. */
function threadOf(record: Pipeline, ...comments: IssueComment[]): IssueComment[] {
  return [{ id: RECORD_ID, author: BOT_NAME, createdAt: "2026-10-13T08:01:00Z", body: record.toComment() }, ...comments];
}

/** A comment of the agent that carries `result` as its step result. */
function resultComment(id: number, result: Record<string, unknown>, text = "Done."): IssueComment {
  return { id, author: BOT_NAME, createdAt: "2026-10-13T09:00:00Z", body: `${text}\n\n<!-- hunt:step ${JSON.stringify(result)} -->\n` };
}

/** Pull request PULL_REQUEST at HEAD_SHA, open, blocked by GitHub, its checks passed, apart from `fields`. */
function pullRequestOf(fields: Partial<z.input<typeof PullRequestState.schema>> = {}): PullRequestState {
  const url = `https://github.com/acme/app/pull/${PULL_REQUEST}`;
  return new PullRequestState({ number: PULL_REQUEST, url, title: "fix: login", headSha: HEAD_SHA, state: "open", mergeState: "BLOCKED", checks: "success", failingChecks: [], labels: [], ...fields });
}

/** The sticky comment of the Claude review on the pull request, with its verdict for `headSha`. */
function verdictComment(id: number, headSha: string, blocking: number, findings = blocking): IssueComment {
  const verdict = JSON.stringify({ headSha, blocking, findings });
  return { id, author: "github-actions[bot]", createdAt: "2026-10-14T08:00:00Z", body: `## PR review\n\n1. The index lacks a test.\n\n<!-- claude-pr-review:verdict ${verdict} -->\n` };
}

function reviewOf(id: number, author: string, state: string, body = ""): PullRequestReview {
  return { id, author, state, body, submittedAt: "2026-10-14T09:00:00Z" };
}

interface SessionOptions extends FakeGitHubOptions {
  /** The issue's labels; the label of the record's step without them. */
  labels?: string[];
  /** The comments on the issue after the record comment. */
  comments?: IssueComment[];
  /** The relay's `hunt-ctl status`; idle since 1 000 without it. */
  status?: () => Record<string, unknown>;
  vmStatus?: string;
}

/**
 * The poller following the VM of session SESSION_ID for acme/app#12, an issue assigned to carol whose thread holds the
 * record comment with `record` and then `comments`; `stored` is the issue as GitHub keeps it, `listed` the VM.
 */
function followSession(record: Pipeline, { labels = [`swf:${record.step}`], comments = [], status = () => statusOf("idle", 1_000), vmStatus = "RUNNING", ...options }: SessionOptions = {}) {
  const stored: Issue = { ...issue(12, "Issue 12", labels), assignees: ["carol"] };
  const github = fakeGitHub({}, { ...options, lookup: { [KEY]: stored }, threads: { ...options.threads, [KEY]: threadOf(record, ...comments) } });
  const listed = [{ ...sessionVmOf(record.step), status: vmStatus }];
  const compute = fakeCompute(listed);
  const { vm, calls } = fakeVm(undefined, status);
  return { ...createPoller({ github, compute, vm }), github, compute, listed, stored, calls };
}

describe("Poller.cycle", () => {
  it("stays idle without repositories or with an invalid configuration, and says so once", async () => {
    const compute = fakeCompute();
    const { poller, logs, tokenReads } = createPoller({ readConfig: () => readSwfConfig({ attribute: async () => null }), compute });
    await poller.cycle();
    await poller.cycle();
    expect(logs).toEqual(["idle: the instance metadata hunt-swf-repos lists no repositories"]);
    expect(tokenReads()).toBe(0);
    expect(compute.calls).toEqual([]);

    const invalid = createPoller({ readConfig: () => readSwfConfig({ attribute: async (key) => (key === "hunt-swf-repos" ? "acme/app" : "11") }) });
    await invalid.poller.cycle();
    expect(invalid.logs).toEqual(['idle: invalid instance metadata: hunt-swf-max-sessions: "11" is no whole number from 0 to 10']);
  });

  it("starts sessions only while fewer than maxSessions VMs are up, oldest issue first", async () => {
    const listed = [listedVm("vm-hunt-s-00000001", "RUNNING", { "hunt-origin": "swf" }), listedVm("vm-hunt-s-00000002", "TERMINATED", { "hunt-origin": "swf" })];
    const github = fakeGitHub({ "acme/app": [issue(9), issue(4)] });
    const compute = fakeCompute(listed);
    const { poller, logs } = createPoller({ github, compute });

    await poller.cycle();
    await poller.drain();
    expect(compute.inserted.map((request) => request.name)).toEqual([VM]);
    expect(github.calls).toContain("unlabel acme/app#4 swf");
    expect(github.calls).not.toContain("unlabel acme/app#9 swf");
    expect(logs[0]).toBe("waiting: acme/app#9; 1 of 2 sessions are up");
  });

  it("logs the projects the claimed issue moved to In Progress in, and a failed move without failing the setup", async () => {
    const moved = fakeGitHub({ "acme/app": [issue(12, "Fix login", ["swf"])] }, { projects: ["Board", "Sprint"] });
    const movedPoller = createPoller({ github: moved });
    await movedPoller.poller.cycle();
    await movedPoller.poller.drain();
    expect(movedPoller.logs).toContain('acme/app#12: moved to In Progress in "Board", "Sprint"');

    const failing = fakeGitHub({ "acme/app": [issue(12, "Fix login", ["swf"])] }, { projectsFail: true });
    const failingPoller = createPoller({ github: failing });
    await failingPoller.poller.cycle();
    await failingPoller.poller.drain();
    expect(failingPoller.logs).toContain("acme/app#12: failed to move the issue to In Progress in its projects: HTTP 403 Resource not accessible by integration");
    expect(failing.calls).not.toContain("label acme/app#12 swf:failed");
  });

  it("claims the issue with the plan label before anything else, sets the session up like a handoff and posts the record once hunt.json's swf settings are known", async () => {
    const github = fakeGitHub({ "acme/app": [issue(12, "Fix login", ["swf", "bug"])] });
    const compute = fakeCompute();
    const { vm, calls, claudeFiles } = fakeVm();
    const { poller, logs, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.drain();

    const labels = ["plan", "implement", "verify", "gate", "pr", "review", "human-review", "merge", "question", "done", "failed"];
    expect(github.calls).toEqual([
      "issues acme/app swf",
      ...labels.map((label) => `ensure acme/app swf:${label}`),
      "comments acme/app#12",
      "unlabel acme/app#12 swf",
      "label acme/app#12 swf:plan",
      "move acme/app#12 In Progress",
      `comment acme/app#12 ${Pipeline.start(["**/migrations/**"], { ...SKILLS, plan: "acme-plan" }).toComment()}`,
      `update acme/app ${FIRST_POSTED_ID}`,
    ]);
    expect(compute.inserted).toEqual([
      { name: VM, template: "tpl-hunt-session", machineType: null, labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" } },
    ]);
    expect(compute.metadata).toEqual([
      [
        { key: "startup-script", value: "#!/bin/sh" },
        { key: "hunt-session-id", value: SESSION_ID },
        { key: "hunt-repo", value: "acme/app" },
        { key: "hunt-branch", value: "fix/general/12-fix-login" },
        { key: "hunt-title", value: "Fix login" },
        { key: "hunt-issue", value: "12" },
        { key: "hunt-agent", value: "plan" },
      ],
    ]);
    expect(calls).toEqual([
      "wait until ready",
      "ensure release",
      `hunt-ctl put-remote-secrets <<< ${JSON.stringify("{}")}`,
      "hunt-ctl install-tools",
      `hunt-ctl clone ${SESSION_ID} --repo acme/app --branch fix/general/12-fix-login --git-name ${BOT_NAME} --git-email ${BOT_EMAIL} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl session-config ${SESSION_ID} --domain hunt.example.com`,
      `put-files ${SESSION_ID} --claude hunt-session.json`,
      `hunt-ctl deps ${SESSION_ID}`,
      `hunt-ctl start ${SESSION_ID} <<< ${JSON.stringify(`${CLAUDE_TOKEN}\n${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl wait ${SESSION_ID} --timeout 180`,
    ]);
    expect(logs).toContain("acme/app#12: no private files: the secret HUNT_SWF_FILES_acme_app has no version");
    expect(JSON.parse(claudeFiles[0]["hunt-session.json"])).toEqual({
      huntSessionId: SESSION_ID,
      acpSessionId: null,
      cwd: "/home/agent/app",
      systemPromptAppend:
        `\n\n## Remote session\n\n### Git\n\n## Questions\n\n## Sessions ${SESSION_ID}\n\n## Issue #12 on fix/general/12-fix-login\n\n### The repository's services\n- \`ui\`: port 4200\n\n` +
        "### The repository's hunt.agent.md\n# Services\nStart the UIs.\n",
      modeId: "bypassPermissions",
      configOptions: { model: "claude-opus-5-5" },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionId: "acp-9", cwd: "/home/agent/app" });
    expect(prompts[0].text.startsWith("Step `plan` for GitHub issue #12 of acme/app: Fix login\nhttps://github.com/acme/app/issues/12\n")).toBe(true);
    expect(prompts[0].text).toContain("## Comments\n\n**@bob** on 2026-10-13 09:00 UTC:\n\nPlease hurry.\n");
    expect(prompts[0].text).not.toContain("hunt:pipeline");
    expect(prompts[0].text).toContain("Work on the branch `fix/general/12-fix-login`.");
    expect(prompts[0].text).toContain("Invoke the repository's skill `acme-plan` (`.claude/skills/acme-plan/SKILL.md`) first and follow it");
    expect(lastRecord(github)).toEqual({ ...Pipeline.start(["**/migrations/**"], { ...SKILLS, plan: "acme-plan" }).toJSON(), promptTurn: 0 });
    expect(github.updates.at(-1)?.body).toContain(
      "\"skills\":{\"plan\":\"acme-plan\",\"implement\":\"swf-implement\",\"verify\":\"swf-verify\",\"gate\":\"swf-gate\",\"pr\":\"swf-pr\"}",
    );
    expect(github.threads[KEY].map((comment) => comment.id)).toEqual([1, FIRST_POSTED_ID]);
    expect(logs.at(-1)).toBe(`acme/app#12: the agent of session ${SESSION_ID} plans the issue (prompt started)`);
    expect(logs.join("\n")).not.toContain(GITHUB_TOKEN);
  });

  it("unpacks the repository's private files from its secret into the worktree right after the clone", async () => {
    const github = fakeGitHub({ "acme/app": [issue(12, "Fix login")] });
    const { vm, calls } = fakeVm();
    const archive = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("tgz OPENAI_API_KEY=sk-secret")]);
    const secretReads: string[] = [];
    const { poller, logs } = createPoller({
      github,
      vm,
      secretBytes: async (name) => {
        secretReads.push(name);
        return { bytes: archive };
      },
    });

    await poller.cycle();
    await poller.drain();

    expect(secretReads).toEqual(["HUNT_SWF_FILES_acme_app"]);
    const clone = calls.findIndex((call) => call.startsWith("hunt-ctl clone"));
    expect(calls[clone + 1]).toBe(`hunt-ctl put-files ${SESSION_ID} <<< ${JSON.stringify(archive.toString())}`);
    expect(calls[clone + 2]).toBe(`hunt-ctl session-config ${SESSION_ID} --domain hunt.example.com`);
    expect(logs).toContain(`acme/app#12: put the private files of acme/app from the secret HUNT_SWF_FILES_acme_app (${archive.length} bytes) into the worktree`);
    expect(logs.join("\n")).not.toContain("sk-secret");
  });

  it("goes on without private files when the gateway may not read the secret, and says so", async () => {
    const { vm, calls } = fakeVm();
    const { poller, logs } = createPoller({ github: fakeGitHub({ "acme/app": [issue(12, "Fix login")] }), vm, secretBytes: async () => ({ absent: "cannot be read by the gateway: failed to read it: HTTP 403 denied" }) });
    await poller.cycle();
    await poller.drain();
    expect(logs).toContain("acme/app#12: no private files: the secret HUNT_SWF_FILES_acme_app cannot be read by the gateway: failed to read it: HTTP 403 denied");
    expect(calls.some((call) => call.startsWith("hunt-ctl put-files"))).toBe(false);
    expect(calls.at(-1)).toBe(`hunt-ctl wait ${SESSION_ID} --timeout 180`);
  });

  it("fails the issue when the private files cannot be read or are no archive", async () => {
    const denied = createPoller({ github: fakeGitHub({ "acme/app": [issue(12, "Fix login")] }), secretBytes: async () => {
      throw new Error("failed to read the secret HUNT_SWF_FILES_acme_app: HTTP 500 boom");
    } });
    await denied.poller.cycle();
    await denied.poller.drain();
    expect(denied.logs).toContain("acme/app#12: failed: failed to read the secret HUNT_SWF_FILES_acme_app: HTTP 500 boom");

    const text = fakeGitHub({ "acme/app": [issue(12, "Fix login")] });
    const plain = createPoller({ github: text, secretBytes: async () => ({ bytes: Buffer.from("OPENAI_API_KEY=sk-secret\n") }) });
    await plain.poller.cycle();
    await plain.poller.drain();
    expect(plain.logs).toContain(
      "acme/app#12: failed: the secret HUNT_SWF_FILES_acme_app is no gzipped tar archive (tar -czf - <files> | gcloud secrets versions add HUNT_SWF_FILES_acme_app --data-file=-)",
    );
    expect(plain.logs.join("\n")).not.toContain("sk-secret");
    expect(text.calls).toContain("label acme/app#12 swf:failed");
  });

  it("skips an issue whose label someone else removed meanwhile", async () => {
    const github = fakeGitHub({ "acme/app": [issue(5)] }, { labelGone: [5] });
    const compute = fakeCompute();
    const { poller, logs } = createPoller({ github, compute });

    await poller.cycle();
    await poller.drain();
    expect(github.calls.at(-1)).toBe("unlabel acme/app#5 swf");
    expect(compute.calls).toEqual(["list hunt-origin=swf"]);
    expect(logs).toContain("acme/app#5: skipped, its label swf was removed meanwhile");
  });

  it("counts a session being set up until Compute Engine lists its VM", async () => {
    let finishSetup = () => {};
    const blocked = new Promise<ReadyAnswer>((resolve) => {
      finishSetup = () => resolve({ installedHash: "", hasSecrets: false });
    });
    const { vm } = fakeVm();
    vm.waitUntilReady = () => blocked;
    const github = fakeGitHub({ "acme/app": [issue(1), issue(2)] });
    const compute = fakeCompute();
    let ids = 0;
    const newId = () => `0000000${++ids}-0000-4000-8000-000000000000`;
    const { poller } = createPoller({ github, compute, vm, readConfig: async () => ({ ...CONFIG, maxSessions: 1 }), newId });

    await poller.cycle();
    await poller.cycle();
    expect(compute.inserted.map((request) => request.name)).toEqual(["vm-hunt-s-00000001"]);
    finishSetup();
    await poller.drain();
  });

  it("marks the issue as failed with the redacted error and leaves the VM", async () => {
    const github = fakeGitHub({ "acme/app": [issue(7)] });
    const { vm } = fakeVm({ command: "deps", error: new Error(`hunt-ctl: npm ci failed: 403 for https://x-access-token:${GITHUB_TOKEN}@github.com/acme/private.git`) });
    const { poller, logs } = createPoller({ github, vm });

    await poller.cycle();
    await poller.drain();
    const expected = "hunt-ctl: npm ci failed: 403 for https://x-access-token:[redacted]@github.com/acme/private.git";
    expect(github.calls.slice(-4)).toEqual([
      "unlabel acme/app#7 swf:plan",
      "unlabel acme/app#7 swf:question",
      "label acme/app#7 swf:failed",
      `comment acme/app#7 Hunt could not start a session for this issue:\n\n\`\`\`\n${expected}\n\`\`\`\n\nThe VM \`${VM}\` stays for inspection.`,
    ]);
    expect(logs).toContain(`acme/app#7: failed: ${expected}`);
    expect(logs.join("\n")).not.toContain(GITHUB_TOKEN);
  });

  it("names no VM in the failure comment when Compute Engine refused to create it", async () => {
    const github = fakeGitHub({ "acme/app": [issue(8)] });
    const compute = fakeCompute([], new Error("failed to create vm-hunt-s-ab12cd34 from tpl-hunt-session: HTTP 403 QUOTA_EXCEEDED"));
    const { poller } = createPoller({ github, compute });

    await poller.cycle();
    await poller.drain();
    expect(github.calls.at(-1)).toBe(
      "comment acme/app#8 Hunt could not start a session for this issue:\n\n```\nfailed to create vm-hunt-s-ab12cd34 from tpl-hunt-session: HTTP 403 QUOTA_EXCEEDED\n```",
    );
  });

  it("marks the issue as failed without a record when session-config names no skill for an agent step, since Hunt has no default skill", async () => {
    const answers: [Record<string, unknown>, string][] = [
      [{ swf_skills: { plan: "acme-plan", verify: "acme-verify", review: "nope" } }, "the steps implement, gate, pr"],
      [{ swf_skills: {} }, "the steps plan, implement, verify, gate, pr"],
      [{}, "the steps plan, implement, verify, gate, pr"],
      [{ swf_skills: { ...SKILLS, gate: "" } }, "the step gate"],
    ];
    for (const [answer, steps] of answers) {
      const github = fakeGitHub({ "acme/app": [issue(9)] });
      const { vm, calls } = fakeVm();
      const huntCtl = vm.huntCtl;
      vm.huntCtl = async (args, input) => (args[0] === "session-config" ? answer : huntCtl(args, input));
      const { poller, logs, prompts } = createPoller({ github, vm });

      await poller.cycle();
      await poller.drain();
      const expected = `hunt.json names no skill for ${steps} under swf.skills; Hunt has no default skill and asks to add the entries when a session of the repository opens`;
      expect(github.calls.slice(-4), steps).toEqual([
        "unlabel acme/app#9 swf:plan",
        "unlabel acme/app#9 swf:question",
        "label acme/app#9 swf:failed",
        `comment acme/app#9 Hunt could not start a session for this issue:\n\n\`\`\`\n${expected}\n\`\`\`\n\nThe VM \`${VM}\` stays for inspection.`,
      ]);
      expect(github.calls.filter((call) => call.includes("hunt:pipeline")), steps).toEqual([]);
      expect(calls.filter((call) => call.startsWith("hunt-ctl deps")), steps).toEqual([]);
      expect(prompts, steps).toEqual([]);
      expect(logs, steps).toContain(`acme/app#9: failed: ${expected}`);
    }
  });

  it("leaves an issue whose comments cannot be read for the next poll", async () => {
    const github = fakeGitHub({ "acme/app": [issue(3)] });
    github.comments = async () => {
      throw new Error("failed to read the comments of acme/app#3: HTTP 502 Bad Gateway");
    };
    const compute = fakeCompute();
    const { poller, logs } = createPoller({ github, compute });

    await poller.cycle();
    expect(github.calls).not.toContain("unlabel acme/app#3 swf");
    expect(compute.inserted).toEqual([]);
    expect(logs).toContain("acme/app#3: failed to claim the issue: failed to read the comments of acme/app#3: HTTP 502 Bad Gateway");
  });
});

describe("Poller.cycle follows running sessions", () => {
  it("records the state the issue's labels report in the VM, once per change", async () => {
    const session = followSession(recordAt("plan", { promptTurn: 0 }), { labels: ["swf:question"], status: () => statusOf("running", null) });

    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.compute.calls).toEqual(["list hunt-origin=swf", `metadata ${VM} fp0`, "list hunt-origin=swf"]);
    expect(session.compute.metadata[0]).toContainEqual({ key: "hunt-agent", value: "question" });
    expect(session.logs).toContain(`${KEY}: the agent is question`);
    expect(session.calls).toEqual([TOKEN_CALL]);
    expect(session.prompts).toEqual([]);

    session.stored.labels = ["swf:plan"];
    await session.poller.cycle();
    expect(session.compute.metadata[1]).toContainEqual({ key: "hunt-agent", value: "plan" });
    expect(session.calls.slice(1)).toEqual([`hunt-ctl status ${SESSION_ID}`]);
  });

  it("gives every running VM the repository's GitHub token whenever it changed, whatever the agent's state", async () => {
    const github = fakeGitHub({}, { lookup: { [KEY]: { ...issue(12, "Issue 12", ["swf:done"]), state: "closed" } } });
    const compute = fakeCompute([sessionVmOf("done")]);
    const githubApp = fakeGitHubApp();
    const { vm, calls } = fakeVm();
    const { poller, logs } = createPoller({ github, compute, vm, githubApp });

    await poller.cycle();
    await poller.cycle();
    expect(calls).toEqual([TOKEN_CALL]);
    expect(logs.filter((line) => line.includes("fresh"))).toEqual([`${KEY}: gave the VM a fresh GitHub token`]);

    githubApp.setToken("ghs_renewed0123456789abcdefghijklmnopq");
    await poller.cycle();
    await poller.cycle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify("ghs_renewed0123456789abcdefghijklmnopq\n")}`);
    expect(logs.join("\n")).not.toContain("ghs_");
  });

  it("gives a VM that stopped and runs again the token once more", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 1_000 }), { labels: ["swf:question"] });

    await session.poller.cycle();
    expect(session.calls).toEqual([TOKEN_CALL]);
    session.listed[0].status = "TERMINATED";
    await session.poller.cycle();
    expect(session.calls).toEqual([TOKEN_CALL]);
    session.listed[0].status = "RUNNING";
    await session.poller.cycle();
    expect(session.calls).toEqual([TOKEN_CALL, TOKEN_CALL]);
  });

  it("logs a VM that takes no token once and still follows the others", async () => {
    const github = fakeGitHub({}, { lookup: { [KEY]: issue(12, "Issue 12", ["swf:implement"]) } });
    const compute = fakeCompute([sessionVmOf("implement")]);
    const { vm, calls } = fakeVm({ command: "github-token", error: new Error(`failed to run hunt-ctl github-token on ${VM}: exit status 2\nusage: hunt-ctl …`) });
    const { poller, logs } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.cycle();
    expect(calls).toHaveLength(2);
    expect(logs.filter((line) => line.includes("exit status 2"))).toEqual([`${KEY}: failed to run hunt-ctl github-token on ${VM}: exit status 2\nusage: hunt-ctl …`]);
    expect(github.calls.filter((call) => call.startsWith("issue "))).toEqual([]);
  });

  it("counts a closed or deleted issue as done", async () => {
    const compute = fakeCompute([sessionVmOf("implement")]);
    const github = fakeGitHub({}, { lookup: { [KEY]: { ...issue(12, "Issue 12", ["swf:implement"]), state: "closed" } } });
    const { poller } = createPoller({ github, compute });
    await poller.cycle();
    expect(compute.metadata[0]).toContainEqual({ key: "hunt-agent", value: "done" });
    expect(github.calls.filter((call) => call.startsWith("comments"))).toEqual([]);

    const deleted = fakeCompute([sessionVmOf("implement")]);
    const { poller: other } = createPoller({ github: fakeGitHub({}, { lookup: { [KEY]: null } }), compute: deleted });
    await other.cycle();
    expect(deleted.metadata[0]).toContainEqual({ key: "hunt-agent", value: "done" });
  });

  it("leaves a session alone whose issue has no record comment of the bot, and says so once; a lost label is set from the record", async () => {
    const session = followSession(recordAt("implement"));
    session.github.threads[KEY] = [
      { id: 7, author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Please hurry." },
      { id: 8, author: BOT_NAME, createdAt: "2026-10-13T09:01:00Z", body: "Hunt started a session for this issue." },
      { id: 9, author: "mallory", createdAt: "2026-10-13T09:02:00Z", body: recordAt("merge", { pullRequest: PULL_REQUEST }).toComment() },
    ];

    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.logs.filter((line) => line.includes("record comment"))).toEqual([
      `${KEY}: the issue has no pipeline record comment of the poller; the session predates the pipeline and is left alone`,
    ]);

    expect(session.calls).toEqual([TOKEN_CALL]);
    expect(writes(session.github)).toEqual([]);
    expect(session.prompts).toEqual([]);

    session.github.threads[KEY] = threadOf(recordAt("review", { pullRequest: PULL_REQUEST }));
    session.stored.labels = ["bug"];
    await session.poller.cycle();
    expect(session.logs.filter((line) => line.includes("no label of the workflow"))).toEqual([
      `${KEY}: the issue carries no label of the workflow; setting swf:review from the pipeline record`,
    ]);
    expect(writes(session.github).slice(0, 1)).toEqual(["label acme/app#12 swf:review"]);
  });

  it("moves the issue's label back to the step of the record, which is the pipeline's truth", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 1_000 }), { labels: ["bug", "swf:plan"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:plan"]);
    expect(session.stored.labels).toEqual(["bug", "swf:implement"]);
    expect(session.logs).toContain(`${KEY}: the issue is labelled swf:plan but the pipeline is at implement; relabelling`);
    expect(session.prompts).toEqual([]);
  });

  it("sends the prompt of an agent step once the relay is idle and no desktop is connected, and only once", async () => {
    let status = statusOf("running", 1_000);
    const record = recordAt("verify", { lastResultId: 1001 });
    const session = followSession(record, { status: () => status });

    await session.poller.cycle();
    status = statusOf("idle", 1_000, true);
    await session.poller.cycle();
    expect(session.prompts).toEqual([]);

    status = statusOf("idle", 1_000);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toMatchObject({ sessionId: "acp-9", cwd: "/home/agent/app" });
    expect(session.prompts[0].text.startsWith("Step `verify` for issue #12 of acme/app on the branch `feat/general/12-issue-12`.\n")).toBe(true);
    expect(lastRecord(session.github)).toEqual({ ...record, promptTurn: 1_000 });
    expect(session.logs).toContain(`${KEY}: sent the prompt of the step verify (prompt started)`);

    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(writes(session.github)).toEqual([`update acme/app ${RECORD_ID}`]);
  });

  it("sends the escalation in place of the implement prompt, and counts a relay without a finished turn as turn 0", async () => {
    const record = recordAt("review", { attempt: 5, pullRequest: PULL_REQUEST });
    record.sendBackToImplement(["Checks: build failed"]);
    const session = followSession(record, { status: () => statusOf("idle", null) });

    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].text.startsWith("Issue #12 of acme/app went back to `implement` more than 5 times.")).toBe(true);
    expect(session.prompts[0].text).toContain("- Checks: build failed\n");
    expect(lastRecord(session.github)).toMatchObject({ step: "implement", escalate: true, attempt: 0, promptTurn: 0 });
    expect(session.logs).toContain(`${KEY}: sent the prompt of the step implement (escalation) (prompt started)`);
  });

  it("moves the pipeline on a new step result of the bot and sends the next step's prompt at the following poll", async () => {
    let status = statusOf("running", null);
    const plan = resultComment(1001, { step: "plan" }, "## Plan\n\n1. Fix the login.");
    const session = followSession(recordAt("plan", { promptTurn: 0 }), { comments: [plan], status: () => status });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:plan", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual({ ...recordAt("implement"), lastResultId: 1001 });
    expect(session.stored.labels).toEqual(["swf:implement"]);
    expect(session.logs).toContain(`${KEY}: the agent reported the step plan; the pipeline goes on with implement`);
    expect(session.prompts).toEqual([]);

    status = statusOf("idle", 2_000);
    await session.poller.cycle();
    expect(session.compute.metadata.at(-1)).toContainEqual({ key: "hunt-agent", value: "implement" });
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].text.startsWith("Step `implement` for issue #12 of acme/app on the branch `feat/general/12-issue-12`.")).toBe(true);
    expect(session.prompts[0].text).toContain("## Findings to fix\n\n(none)\n");
    expect(lastRecord(session.github)).toEqual({ ...recordAt("implement"), lastResultId: 1001, promptTurn: 2_000 });
  });

  it("sends the issue back to implement when verify reports findings, with the attempt counted, and ignores older results", async () => {
    const implemented = resultComment(1002, { step: "implement", summary: "Fixed the login." });
    const report = resultComment(1003, { step: "verify", findings: ["The logout still fails."] }, "| Criterion | Passed |\n| --- | --- |\n| Logout | no |");
    const session = followSession(recordAt("verify", { attempt: 1, lastResultId: 1002, promptTurn: 2_000 }), { comments: [implemented, report] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:verify", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual({ ...recordAt("implement"), attempt: 2, findings: ["Verify: The logout still fails."], lastResultId: 1003 });

    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].text).toContain("(attempt 2 of 5)");
    expect(session.prompts[0].text).toContain("## Findings to fix\n\n- Verify: The logout still fails.\n");
  });

  it("goes on from a passing verify to the gate and from the gate to the pull request with the gate's judgement", async () => {
    const session = followSession(recordAt("verify", { lastResultId: 1002, promptTurn: 900 }), { comments: [resultComment(1003, { step: "verify", findings: [] })] });

    await session.poller.cycle();
    expect(lastRecord(session.github)).toEqual({ ...recordAt("gate"), lastResultId: 1003 });
    await session.poller.cycle();
    expect(session.prompts[0].text.startsWith("Step `gate` for issue #12 of acme/app on the branch `feat/general/12-issue-12` (pull request: (not opened yet)).")).toBe(true);

    session.github.threads[KEY].push(resultComment(1004, { step: "gate", humanReview: true, risk: "high", reasons: ["It changes the billing."] }));
    await session.poller.cycle();
    expect(session.stored.labels).toEqual(["swf:pr"]);
    expect(lastRecord(session.github)).toEqual({ ...recordAt("pr"), humanReview: true, lastResultId: 1004 });
    expect(session.logs).toContain(`${KEY}: the agent reported the step gate; the pipeline goes on with pr`);
    await session.poller.cycle();
    expect(session.prompts[1].text).toContain("(a person reviews before the merge: yes)");
  });

  it("sends an unusable step result back to the agent once its relay is idle, without moving the pipeline", async () => {
    let status = statusOf("running", 3_000);
    const session = followSession(recordAt("gate", { lastResultId: 1003, promptTurn: 3_000 }), {
      comments: [resultComment(1004, { step: "gate", humanReview: "maybe", risk: "low" })],
      status: () => status,
    });

    await session.poller.cycle();
    expect(session.prompts).toEqual([]);
    expect(writes(session.github)).toEqual([]);

    status = statusOf("idle", 4_000);
    await session.poller.cycle();
    const badResult = badResultPrompt(readPrompt("bad-result"), "humanReview of a gate result must be true or false");
    expect(session.prompts.map((prompt) => prompt.text)).toEqual([badResult]);
    expect(lastRecord(session.github)).toEqual({ ...recordAt("gate"), lastResultId: 1004, promptTurn: 4_000 });
    expect(session.logs).toContain(`${KEY}: the step result of gate is unusable (humanReview of a gate result must be true or false); told the agent (prompt started)`);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);

    session.github.threads[KEY].push(resultComment(1005, { step: "plan" }));
    status = statusOf("idle", 5_000);
    await session.poller.cycle();
    expect(session.prompts[1].text).toBe(badResultPrompt(readPrompt("bad-result"), "the result reports step plan, but the current step is gate"));
    expect(session.stored.labels).toEqual(["swf:gate"]);
    expect(writes(session.github)).toEqual([`update acme/app ${RECORD_ID}`, `update acme/app ${RECORD_ID}`]);
  });

  it("reminds an agent that ended its step's turn without a result once, then marks the issue as failed", async () => {
    let status = statusOf("running", 1_000);
    const session = followSession(recordAt("verify", { lastResultId: 1002, promptTurn: 1_000 }), { status: () => status });

    await session.poller.cycle();
    status = statusOf("idle", 1_000);
    await session.poller.cycle();
    expect(session.prompts).toEqual([]);

    status = statusOf("idle", 2_000);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toMatchObject({ sessionId: "acp-9", cwd: "/home/agent/app" });
    expect(session.prompts[0].text.startsWith("Your last turn ended, but issue #12 of acme/app still has the label `swf:verify`")).toBe(true);
    expect(lastRecord(session.github)).toMatchObject({ step: "verify", reminded: true, promptTurn: 2_000 });
    expect(session.logs).toContain(`${KEY}: the agent ended its turn without a result for verify; reminded it (prompt started)`);

    await session.poller.cycle();
    status = statusOf("running", 2_000);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(writes(session.github)).toEqual([`update acme/app ${RECORD_ID}`]);

    status = statusOf("idle", 3_000);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(writes(session.github)).toEqual([
      `update acme/app ${RECORD_ID}`,
      "unlabel acme/app#12 swf:verify",
      "unlabel acme/app#12 swf:question",
      "label acme/app#12 swf:failed",
      `comment acme/app#12 ${stoppedComment("verify", VM)}`,
    ]);
    expect(session.logs).toContain(`${KEY}: the agent ended its turn again without a result for verify; marking the issue as failed`);

    await session.poller.cycle();
    expect(session.compute.metadata.at(-1)).toContainEqual({ key: "hunt-agent", value: "failed" });
    expect(writes(session.github)).toHaveLength(5);
  });

  it("sends no prompt to a VM that names another session's VM", async () => {
    const github = fakeGitHub({}, { lookup: { [KEY]: issue(12, "Issue 12", ["swf:verify"]) }, threads: { [KEY]: threadOf(recordAt("verify")) } });
    const compute = fakeCompute([sessionVmOf("verify"), { ...sessionVmOf("verify"), name: "vm-hunt-s-00000002" }]);
    const { vm, calls } = fakeVm(undefined, () => statusOf("idle", 1_000, true));
    const { poller, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    expect(calls).toEqual([TOKEN_CALL, `hunt-ctl status ${SESSION_ID}`]);
    expect(prompts).toEqual([]);
    expect(github.calls.filter((call) => call.startsWith("issue "))).toEqual([`issue ${KEY}`]);
  });

  /** The thread of acme/app#12 after the record comment: alice's comment and the agent's question after its result 1002. */
  const question: IssueComment[] = [
    { id: 1001, author: "alice", createdAt: "2026-10-13T08:30:00Z", body: "Also the logout." },
    { id: 1003, author: BOT_NAME, createdAt: "2026-10-13T10:00:00Z", body: "**❓ RÜCKFRAGE**\n\n@alice Postgres or SQLite?" },
  ];
  const bobsAnswer: IssueComment = { id: 1004, author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres, please." };

  it("delivers the answers that arrive on the issue to the waiting agent once each, with the step, not while the relay is busy or a desktop is connected", async () => {
    let status = statusOf("idle", 1_000);
    const record = recordAt("implement", { lastResultId: 1002, promptTurn: 500, reminded: true });
    const session = followSession(record, { labels: ["swf:question"], comments: question, status: () => status });
    const thread = session.github.threads[KEY];

    await session.poller.cycle();
    expect(session.prompts).toEqual([]);
    expect(session.calls).toEqual([TOKEN_CALL]);

    thread.push(bobsAnswer);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toMatchObject({ sessionId: "acp-9", cwd: "/home/agent/app" });
    expect(session.prompts[0].text.startsWith("An answer to your question arrived as a comment on issue #12 of acme/app:\n\n**@bob** on 2026-10-13 10:05 UTC:\n\nPostgres, please.\n\n")).toBe(true);
    expect(session.prompts[0].text).toContain("(`gh issue edit 12 --repo acme/app --remove-label swf:question --add-label swf:implement --title \"<title>\"`)");
    expect(session.prompts[0].text).toContain("then finish the step `implement` you stopped at");
    expect(session.prompts[0].text).not.toContain("logout");
    expect(lastRecord(session.github)).toEqual({ ...record, promptTurn: 1_000, reminded: false });
    expect(session.logs).toContain(`${KEY}: an answer arrived on the issue; sent it to the agent (prompt started)`);

    status = statusOf("running", 1_000);
    await session.poller.cycle();
    status = statusOf("idle", 2_000);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);

    thread.push(
      { id: 1005, author: "carol", createdAt: "2026-10-13T10:10:00Z", body: "With pgvector." },
      { id: 1006, author: "dave", createdAt: "2026-10-13T10:11:00Z", body: "Agreed." },
    );
    status = statusOf("idle", 2_000, true);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    status = statusOf("idle", 2_000);
    await session.poller.cycle();
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1].text).toContain("**@carol** on 2026-10-13 10:10 UTC:\n\nWith pgvector.\n\n---\n\n**@dave** on 2026-10-13 10:11 UTC:\n\nAgreed.");
    expect(session.prompts[1].text).not.toContain("Postgres, please.");
    expect(session.logs).toContain(`${KEY}: 2 answers arrived on the issue; sent them to the agent (prompt started)`);
  });

  it("starts the stopped VM of a waiting agent once its answer arrived and delivers the answer when the VM runs", async () => {
    const session = followSession(recordAt("implement", { lastResultId: 1002, promptTurn: 1_000 }), { labels: ["swf:question"], comments: question, vmStatus: "TERMINATED" });
    const { compute, listed, logs, calls, prompts } = session;
    startable(compute, listed);

    await session.poller.cycle();
    expect(compute.calls.filter((call) => call.startsWith("start"))).toEqual([]);
    expect(calls).toEqual([]);

    session.github.threads[KEY].push(bobsAnswer);
    await session.poller.cycle();
    expect(logs).toContain(`${KEY}: an answer arrived on the issue while ${VM} is terminated; starting it`);
    await settle(logs, `${KEY}: ${VM} runs again`);
    expect(compute.calls.filter((call) => call.startsWith("start"))).toEqual([`start ${VM}`]);
    expect(calls).toEqual(["wait until ready", "ensure release", `hunt-ctl put-remote-secrets <<< ${JSON.stringify("{}")}`]);
    expect(prompts).toEqual([]);

    await session.poller.cycle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("**@bob** on 2026-10-13 10:05 UTC:\n\nPostgres, please.");
    expect(calls.slice(3)).toEqual([TOKEN_CALL, `hunt-ctl status ${SESSION_ID}`]);
  });

  it("starts the stopped VM of a session whose step waits for its prompt, and leaves one off whose prompt was sent", async () => {
    const sent = followSession(recordAt("implement", { lastResultId: 1001, promptTurn: 1_000 }), { vmStatus: "TERMINATED" });
    await sent.poller.cycle();
    expect(sent.compute.calls).toEqual(["list hunt-origin=swf"]);
    expect(sent.calls).toEqual([]);

    const session = followSession(recordAt("implement", { lastResultId: 1001 }), { vmStatus: "SUSPENDED" });
    startable(session.compute, session.listed);
    await session.poller.cycle();
    expect(session.logs).toContain(`${KEY}: the step implement waits for its prompt while ${VM} is suspended; starting it`);
    await settle(session.logs, `${KEY}: ${VM} runs again`);
    expect(session.compute.calls).toContain(`resume ${VM}`);

    await session.poller.cycle();
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].text.startsWith("Step `implement` for issue #12 of acme/app")).toBe(true);
  });

  it("logs a start that keeps failing once and tries again at every poll", async () => {
    const session = followSession(recordAt("implement", { lastResultId: 1002, promptTurn: 1_000 }), {
      labels: ["swf:question"],
      comments: [...question, bobsAnswer],
      vmStatus: "TERMINATED",
    });
    const { compute, logs } = session;
    compute.locate = async (name) => session.listed.find((instance) => instance.name === name) ?? null;
    compute.start = async () => {
      compute.calls.push(`start ${VM}`);
      throw new Error(`failed to start ${VM}: ZONE_RESOURCE_POOL_EXHAUSTED`);
    };

    for (let cycle = 0; cycle < 3; cycle++) {
      await session.poller.cycle();
      for (let turn = 0; turn < 10 && compute.calls.filter((call) => call.startsWith("start")).length <= cycle; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    expect(compute.calls.filter((call) => call.startsWith("start"))).toHaveLength(3);
    expect(logs.filter((line) => line.includes("ZONE_RESOURCE_POOL_EXHAUSTED"))).toEqual([`${KEY}: failed to start ${VM}: failed to start ${VM}: ZONE_RESOURCE_POOL_EXHAUSTED`]);
  });

  it("records the state of a stopped VM whose issue moved on from the question instead of starting it", async () => {
    const listed = [{ ...sessionVmOf("question"), status: "TERMINATED" }];
    const github = fakeGitHub({}, { lookup: { [KEY]: issue(12, "Issue 12", ["swf:done"]) } });
    const compute = fakeCompute(listed);
    const { poller, logs } = createPoller({ github, compute });

    await poller.cycle();
    expect(compute.metadata[0]).toContainEqual({ key: "hunt-agent", value: "done" });
    expect(logs).toContain(`${KEY}: the agent is done`);
    expect(github.calls.filter((call) => call.startsWith("comments"))).toEqual([]);
  });

  it("logs a lasting failure to follow a session once and goes on with the other sessions", async () => {
    const github = fakeGitHub({}, { lookup: { [KEY]: issue(12, "Issue 12", ["swf:implement"]) } });
    github.issue = async () => {
      throw new Error("failed to read acme/app#12: HTTP 502 Bad Gateway");
    };
    const compute = fakeCompute([sessionVmOf("implement")]);
    const { poller, logs } = createPoller({ github, compute });

    await poller.cycle();
    await poller.cycle();
    expect(logs.filter((line) => line.includes("HTTP 502"))).toEqual([`${KEY}: failed to read acme/app#12: HTTP 502 Bad Gateway`]);
    expect(logs.at(-1)).toBe("polling acme/app: no open issues labelled swf");
  });
});

describe("Poller.cycle drives the pull request", () => {
  const prThread = `acme/app#${PULL_REQUEST}`;

  it("moves the issue to In Review when the pull request opens, without a person when no file needs one", async () => {
    const opened = resultComment(1004, { step: "pr", pullRequest: PULL_REQUEST }, "https://github.com/acme/app/pull/31");
    const record = recordAt("pr", { humanReviewPaths: ["**/migrations/**"], lastResultId: 1003, promptTurn: 3_000 });
    const session = followSession(record, { comments: [opened], pullRequests: { [PULL_REQUEST]: pullRequestOf() }, files: ["README.md", "src/login.ts"], projects: ["Board"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["move acme/app#12 In Review", "label acme/app#12 swf:review", "unlabel acme/app#12 swf:pr", `update acme/app ${RECORD_ID}`]);
    expect(session.github.calls).toContain(`files acme/app#${PULL_REQUEST}`);
    expect(lastRecord(session.github)).toEqual({ ...record, step: "review", promptTurn: null, pullRequest: PULL_REQUEST, lastResultId: 1004 });
    expect(session.logs).toContain(`${KEY}: moved to In Review in "Board"`);
  });

  it("asks a person to review a pull request that changes a file of humanReviewPaths: PR label, reviewers and one comment", async () => {
    const opened = resultComment(1004, { step: "pr", pullRequest: PULL_REQUEST });
    const pullRequests = { [PULL_REQUEST]: pullRequestOf() };
    const record = recordAt("pr", { humanReviewPaths: ["**/migrations/**"], lastResultId: 1003, promptTurn: 3_000 });
    const session = followSession(record, { comments: [opened], pullRequests, files: ["README.md", "apps/api/src/migrations/0007-add-index.ts"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([
      "move acme/app#12 In Review",
      `ensure acme/app ${HUMAN_REVIEW_PR_LABEL}`,
      `label acme/app#${PULL_REQUEST} ${HUMAN_REVIEW_PR_LABEL}`,
      `request acme/app#${PULL_REQUEST} carol`,
      `comment acme/app#${PULL_REQUEST} ${humanReviewComment(["carol"], 12)}`,
      "label acme/app#12 swf:review",
      "unlabel acme/app#12 swf:pr",
      `update acme/app ${RECORD_ID}`,
    ]);
    expect(pullRequests[PULL_REQUEST].labels).toEqual([HUMAN_REVIEW_PR_LABEL]);
    expect(lastRecord(session.github)).toEqual({ ...record, step: "review", promptTurn: null, pullRequest: PULL_REQUEST, humanReview: true, notified: true, lastResultId: 1004 });
    expect(session.logs).toContain(`${KEY}: #31 changes apps/api/src/migrations/0007-add-index.ts, which always needs a person`);
    expect(session.logs).toContain(`${KEY}: asked @carol to review #31`);
  });

  it("asks once: a later review of a pull request a person reviews keeps humanReview and neither labels nor mentions again", async () => {
    const regated = resultComment(1010, { step: "gate", humanReview: false, risk: "low", reasons: ["A small fix."] });
    const record = recordAt("gate", { pullRequest: PULL_REQUEST, humanReview: true, notified: true, attempt: 1, lastResultId: 1009, promptTurn: 5_000 });
    const session = followSession(record, { comments: [regated], pullRequests: { [PULL_REQUEST]: pullRequestOf({ labels: [HUMAN_REVIEW_PR_LABEL] }) } });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:review", "unlabel acme/app#12 swf:gate", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual({ ...record, step: "review", promptTurn: null, lastResultId: 1010 });
  });

  it("waits at review for the checks and a Claude verdict for the head commit, then goes on with merge, without asking the VM", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ checks: "pending" }) };
    const record = recordAt("review", { pullRequest: PULL_REQUEST, lastResultId: 1004 });
    const session = followSession(record, { pullRequests, threads: { [prThread]: [verdictComment(2001, "f".repeat(40), 0)] } });

    await session.poller.cycle();
    expect(session.logs).toContain(`${KEY}: review: the checks of the head commit are still running`);
    pullRequests[PULL_REQUEST].checks = "success";
    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.logs.filter((line) => line.includes("no Claude review verdict"))).toEqual([`${KEY}: review: no Claude review verdict for 0123456 yet`]);
    expect(writes(session.github)).toEqual([]);

    session.github.threads[prThread].push(verdictComment(2002, HEAD_SHA, 0, 1));
    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:merge", "unlabel acme/app#12 swf:review", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual({ ...record, step: "merge" });
    expect(session.logs).toContain(`${KEY}: #31 passed its checks and the Claude review; the pipeline goes on with merge`);
    expect(session.calls).toEqual([TOKEN_CALL]);
    expect(session.prompts).toEqual([]);

    const human = followSession(recordAt("review", { pullRequest: PULL_REQUEST, humanReview: true, notified: true }), {
      pullRequests: { [PULL_REQUEST]: pullRequestOf() },
      threads: { [prThread]: [verdictComment(2002, HEAD_SHA, 0, 3)] },
    });
    await human.poller.cycle();
    expect(human.stored.labels).toEqual(["swf:human-review"]);
    expect(lastRecord(human.github)).toMatchObject({ step: "human-review", humanReview: true });
  });

  it("sends the issue back to implement at review for blocking findings of the Claude review or a failing check", async () => {
    const blocking = followSession(recordAt("review", { pullRequest: PULL_REQUEST, attempt: 1 }), {
      pullRequests: { [PULL_REQUEST]: pullRequestOf({ checks: "pending" }) },
      threads: { [prThread]: [verdictComment(2002, HEAD_SHA, 2)] },
    });
    await blocking.poller.cycle();
    expect(writes(blocking.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:review", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(blocking.github)).toEqual({
      ...recordAt("implement", { pullRequest: PULL_REQUEST }),
      attempt: 2,
      findings: ["Claude review of 0123456 with 2 blocking finding(s):\n\n## PR review\n\n1. The index lacks a test."],
    });
    expect(blocking.logs).toContain(`${KEY}: the review of #31 found something; back to implement`);

    const failing = followSession(recordAt("review", { pullRequest: PULL_REQUEST }), {
      pullRequests: { [PULL_REQUEST]: pullRequestOf({ checks: "failure", failingChecks: ["build", "lint"] }) },
    });
    await failing.poller.cycle();
    expect(lastRecord(failing.github)).toMatchObject({ step: "implement", attempt: 1, findings: ["Checks: build, lint failed on 0123456 (https://github.com/acme/app/pull/31/checks)"] });
    await failing.poller.cycle();
    expect(failing.prompts[0].text).toContain("## Findings to fix\n\n- Checks: build, lint failed on 0123456 (https://github.com/acme/app/pull/31/checks)\n");
  });

  it("waits at human-review for a person's approval, ignoring bots and plain comments, then goes on with merge", async () => {
    const reviews = [reviewOf(501, "github-actions[bot]", "CHANGES_REQUESTED", "PR review"), reviewOf(502, "dave", "COMMENTED", "Looks fine so far.")];
    const record = recordAt("human-review", { pullRequest: PULL_REQUEST, humanReview: true, notified: true });
    const session = followSession(record, { pullRequests: { [PULL_REQUEST]: pullRequestOf() }, reviews });

    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.logs.filter((line) => line.includes("waiting for a person"))).toEqual([`${KEY}: human-review: waiting for a person to approve #31`]);
    expect(writes(session.github)).toEqual([]);

    reviews.push(reviewOf(503, "carol", "APPROVED"));
    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:merge", "unlabel acme/app#12 swf:human-review", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual({ ...record, step: "merge" });
    expect(session.logs).toContain(`${KEY}: #31 was approved by carol; the pipeline goes on with merge`);
  });

  it("sends a person's change request at human-review back to implement with the review and its inline comments, once", async () => {
    const reviews = [reviewOf(503, "carol", "CHANGES_REQUESTED", "Please rename the index.\n")];
    const record = recordAt("human-review", { pullRequest: PULL_REQUEST, humanReview: true, notified: true, attempt: 1 });
    const session = followSession(record, { pullRequests: { [PULL_REQUEST]: pullRequestOf() }, reviews, reviewComments: ["db/migrations/0007.sql:3: Use a partial index."] });

    await session.poller.cycle();
    expect(session.github.calls).toContain(`review-comments acme/app#${PULL_REQUEST} 503`);
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:human-review", `update acme/app ${RECORD_ID}`]);
    const sentBack = lastRecord(session.github)!;
    expect(sentBack).toEqual({
      ...record,
      step: "implement",
      attempt: 2,
      findings: ["@carol requested changes on #31:\nPlease rename the index.\ndb/migrations/0007.sql:3: Use a partial index."],
      handledReview: 503,
    });
    expect(session.logs).toContain(`${KEY}: carol requested changes on #31; back to implement`);
    await session.poller.cycle();
    expect(session.prompts[0].text).toContain("- @carol requested changes on #31:\n  Please rename the index.\n  db/migrations/0007.sql:3: Use a partial index.\n");

    session.github.threads[KEY][0].body = new Pipeline({ ...sentBack.toJSON(), step: "human-review" }).toComment();
    session.stored.labels = ["swf:human-review"];
    await session.poller.cycle();
    expect(session.stored.labels).toEqual(["swf:human-review"]);
    expect(session.logs.at(-1)).toBe(`${KEY}: human-review: waiting for a person to approve #31`);
  });

  it("merges a clean pull request once per head, then marks the issue as done and moves it to Done", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ mergeState: "CLEAN" }) };
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST }), { pullRequests, projects: ["Board"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([`merge acme/app#${PULL_REQUEST}`, `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ step: "merge", mergeSha: HEAD_SHA });
    expect(session.logs).toContain(`${KEY}: merged #31`);
    await session.poller.cycle();
    expect(writes(session.github)).toHaveLength(2);
    expect(session.logs).toContain(`${KEY}: merge: the merge was requested`);

    pullRequests[PULL_REQUEST].state = "merged";
    await session.poller.cycle();
    expect(writes(session.github).slice(2)).toEqual([
      "unlabel acme/app#12 swf:merge",
      "label acme/app#12 swf:done",
      "comment acme/app#12 Hunt merged pull request #31.",
      "move acme/app#12 Done",
    ]);
    expect(session.logs).toContain(`${KEY}: moved to Done in "Board"`);
    expect(session.logs).toContain(`${KEY}: done, #31 is merged`);

    await session.poller.cycle();
    expect(session.compute.metadata.at(-1)).toContainEqual({ key: "hunt-agent", value: "done" });
    expect(writes(session.github)).toHaveLength(6);
  });

  it("updates the branch of a pull request that is behind its base once per head and merges it once it is clean", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ mergeState: "BEHIND" }) };
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST }), { pullRequests });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([`update-branch acme/app#${PULL_REQUEST}`, `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ mergeSha: HEAD_SHA });
    expect(session.logs).toContain(`${KEY}: #31 is behind its base; updating the branch`);
    await session.poller.cycle();
    expect(writes(session.github)).toHaveLength(2);
    expect(session.logs).toContain(`${KEY}: merge: the branch is being updated`);

    pullRequests[PULL_REQUEST] = pullRequestOf({ headSha: "b".repeat(40), mergeState: "CLEAN" });
    await session.poller.cycle();
    expect(writes(session.github).slice(2)).toEqual([`merge acme/app#${PULL_REQUEST}`, `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ mergeSha: "b".repeat(40) });
  });

  it("sends a pull request that conflicts with its base back to implement", async () => {
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST, mergeSha: HEAD_SHA }), { pullRequests: { [PULL_REQUEST]: pullRequestOf({ mergeState: "DIRTY" }) } });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:merge", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual({
      ...recordAt("implement", { pullRequest: PULL_REQUEST }),
      attempt: 1,
      findings: ["Merge: the branch conflicts with the base branch; merge the base branch into 0123456's branch, resolve the conflicts and push"],
    });
    expect(session.logs).toContain(`${KEY}: #31 conflicts with its base; back to implement`);
  });

  it("marks the issue as failed when the pull request was closed without a merge or does not exist", async () => {
    const closed = followSession(recordAt("review", { pullRequest: PULL_REQUEST }), { pullRequests: { [PULL_REQUEST]: pullRequestOf({ state: "closed" }) } });
    await closed.poller.cycle();
    expect(writes(closed.github)).toEqual([
      "unlabel acme/app#12 swf:review",
      "unlabel acme/app#12 swf:question",
      "label acme/app#12 swf:failed",
      `comment acme/app#12 ${closedComment(PULL_REQUEST)}`,
    ]);

    const missing = followSession(recordAt("human-review", { pullRequest: PULL_REQUEST }));
    await missing.poller.cycle();
    expect(writes(missing.github).at(-1)).toBe("comment acme/app#12 Pull request #31 does not exist (any more), so this issue is marked as failed.");
  });

  it("drives the poller steps of a session whose VM is off, which need GitHub only, and starts the VM once the pipeline is back at the agent", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf() };
    const record = recordAt("human-review", { pullRequest: PULL_REQUEST, humanReview: true, notified: true });
    const session = followSession(record, { pullRequests, reviews: [reviewOf(503, "carol", "APPROVED")], vmStatus: "SUSPENDED" });
    startable(session.compute, session.listed);

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:merge", "unlabel acme/app#12 swf:human-review", `update acme/app ${RECORD_ID}`]);

    pullRequests[PULL_REQUEST].mergeState = "DIRTY";
    await session.poller.cycle();
    expect(lastRecord(session.github)).toMatchObject({ step: "implement", attempt: 1, promptTurn: null });
    expect(session.compute.calls.filter((call) => /^(start|resume) /.test(call))).toEqual([]);
    expect(session.calls).toEqual([]);

    await session.poller.cycle();
    expect(session.logs).toContain(`${KEY}: the step implement waits for its prompt while ${VM} is suspended; starting it`);
    await settle(session.logs, `${KEY}: ${VM} runs again`);
    expect(session.compute.calls).toContain(`resume ${VM}`);
  });
});

describe("Poller.abort", () => {
  it("marks the issues of the setups in progress as failed", async () => {
    const { vm } = fakeVm();
    vm.waitUntilReady = () => new Promise(() => {});
    const github = fakeGitHub({ "acme/app": [issue(11)] });
    const { poller } = createPoller({ github, vm });

    await poller.cycle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await poller.abort("the gateway's poller stopped while it set the session up");
    expect(github.calls.slice(-4)).toEqual([
      "unlabel acme/app#11 swf:plan",
      "unlabel acme/app#11 swf:question",
      "label acme/app#11 swf:failed",
      `comment acme/app#11 Hunt could not start a session for this issue:\n\n\`\`\`\nthe gateway's poller stopped while it set the session up\n\`\`\`\n\nThe VM \`${VM}\` stays for inspection.`,
    ]);
  });
});
