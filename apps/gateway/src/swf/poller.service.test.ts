import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { PullRequestState } from "../../../../libs/domain/src/swf/pull-request-state.value-object.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { Transport } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import type { Compute, Instance, InstanceRequest, MetadataItem } from "../gcp/compute-engine.client.ts";
import type { GitHub, Issue, IssueComment } from "./github.client.ts";
import { SessionVmService } from "../session-vm/session-vm.service.ts";
import type { ReadyAnswer, SessionVmSsh } from "../session-vm/session-vm-ssh.client.ts";
import type { GitHubApp } from "./github-app.client.ts";
import { Poller, type PollerDeps } from "./poller.service.ts";
import { readSwfConfig, type SwfConfig } from "./swf-config.utils.ts";
import { Pipeline, type PullRequestReview, type Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { closedComment, noAssigneeComment, noAssigneeError, reviewRequestComment, stepSettingsError } from "./swf-comments.utils.ts";
import { ISSUE, settingsWith, started } from "../../../../libs/domain/src/swf/swf.fixtures.ts";
import { StepSettings } from "../../../../libs/domain/src/swf/step-settings.value-object.ts";

/** The poller's clock in the tests: 2026-10-25 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

function readPrompt(name: string): string {
  return readFileSync(new URL(`../../../../libs/domain/prompts/swf/${name}.user-prompt.md`, import.meta.url), "utf8");
}

const GITHUB_TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const BOT_NAME = "hunt-claude[bot]";
const BOT_EMAIL = "4242+hunt-claude[bot]@users.noreply.github.com";
/** The `clone` options of the Git identity: the app commits, the issue's assignee `login` is the author. */
function gitOptions(login: string): string {
  return `--git-name ${BOT_NAME} --git-email ${BOT_EMAIL} --git-author-name ${login} Example --git-author-email 7+${login}@users.noreply.github.com`;
}
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
/** The step settings `hunt-ctl session-config` reports for acme/app: its own plan skill, with a model and effort for plan and another model for implement. */
const REPORTED_SETTINGS = settingsWith({ plan: { skill: "acme-plan", model: "claude-opus-5-5", effort: "high" }, implement: { model: "claude-sonnet-5" } });
/** The step settings of a repository whose hunt.json names its own project statuses, question prefix and merge method. */
const CUSTOM_SETTINGS = new StepSettings({
  ...settingsWith().toJSON(),
  questionPrefix: "QUESTION",
  projectStatus: { inProgress: "Doing", inReview: "Reviewing", done: "Shipped" },
  mergeMethod: "rebase",
});
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** An issue of alice, assigned to her. */
function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  const url = `https://github.com/acme/app/issues/${number}`;
  return { number, title, body: `Body of ${number}`, author: "alice", createdAt: "2026-10-13T08:00:00Z", url, labels, state: "open", assignees: ["alice"] };
}

interface FakeGitHubOptions {
  /** Issues whose label someone else removed meanwhile. */
  labelGone?: number[];
  /** The open issues in progress (labelled with a step or the question) by repository, as the search lists them. */
  inProgress?: Record<string, Issue[]>;
  /** The single issues by `<repo>#<number>` (null: deleted); label changes apply to them. */
  lookup?: Record<string, Issue | null>;
  /** The comments by `<repo>#<number>`; an issue or pull request without an entry has one comment of bob. */
  threads?: Record<string, IssueComment[]>;
  /** The titles of the projects the issue moves in. */
  projects?: string[];
  projectsFail?: boolean;
  /** The pull requests by number. */
  pullRequests?: Record<number, PullRequestState>;
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
 * is recorded as one line. Labels added or removed change the stored issues, posted comments (by the bot, ids from
 * FIRST_POSTED_ID) and edits change the threads, so a later poll sees them.
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
  };
  return {
    calls,
    threads,
    updates,
    openIssues: async (repo, label) => {
      calls.push(`issues ${repo.slug} ${label}`);
      return issues[repo.slug] ?? [];
    },
    openIssuesWithAny: async (repo) => {
      calls.push(`in-progress ${repo.slug}`);
      return structuredClone(options.inProgress?.[repo.slug] ?? []);
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
    addAssignees: async (repo, number, logins) => {
      calls.push(`assign ${repo.slug}#${number} ${logins.join(",")}`);
    },
    gitIdentity: async (repo, login) => {
      calls.push(`identity ${repo.slug} ${login}`);
      return { name: `${login} Example`, email: `7+${login}@users.noreply.github.com` };
    },
    updateBranch: async (repo, number) => {
      calls.push(`update-branch ${repo.slug}#${number}`);
    },
    merge: async (repo, number, method) => {
      calls.push(`merge ${repo.slug}#${number} ${method}`);
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
  const reads = ["issues ", "in-progress ", "issue ", "comments ", "pull ", "reviews ", "review-comments ", "identity "];
  return github.calls.filter((call) => !reads.some((read) => call.startsWith(read)));
}

/** The record of the last edit of a comment without its runs, which `runsOf` gives; null without a usable one. */
function lastRecord(github: FakeGitHub): Omit<z.infer<typeof Pipeline.schema>, "runs"> | null {
  const pipeline = Pipeline.fromComment(github.updates.at(-1)?.body ?? "")?.pipeline;
  if (!pipeline) return null;
  const { runs: _runs, ...record } = pipeline.toJSON();
  return record;
}

/** `record` without its runs, for the expected side of a comparison with `lastRecord`. */
function withoutRuns<T extends { runs?: unknown }>(record: T): Omit<T, "runs"> {
  const { runs: _runs, ...rest } = record;
  return rest;
}

/** The runs of the record of the last edit of a comment, each as `[n, step, outcome, cause]`. */
function runsOf(github: FakeGitHub): [number, string, string, number | undefined][] {
  return (Pipeline.fromComment(github.updates.at(-1)?.body ?? "")?.pipeline?.runs ?? []).map((run) => [run.n, run.step, run.outcome, run.cause]);
}

/** A VM as Compute Engine lists it, with the template's metadata and `metadata` on top. */
function listedVm(name: string, status: string, labels: Record<string, string> = {}, metadata: Record<string, string> = {}): Instance {
  return {
    name,
    zone: "europe-west3-a",
    status,
    creationTimestamp: "2026-10-13T08:00:00.000-07:00",
    lastStartTimestamp: "",
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

/** A session VM that records every hunt-ctl call with its stdin and fails the one named in `failing`. */
function fakeVm(failing?: { command: string; error: Error }) {
  const calls: string[] = [];
  const claudeFiles: Record<string, string>[] = [];
  const vm: SessionVmSsh = {
    run: async () => "",
    huntCtl: async (args, input = "") => {
      calls.push(`hunt-ctl ${args.join(" ")}${input ? ` <<< ${JSON.stringify(String(input))}` : ""}`);
      if (failing?.command === args[0]) throw failing.error;
      switch (args[0]) {
        case "clone":
          return { path: "/home/agent/app" };
        case "session-config":
          return {
            services_prompt: "### The repository's services\n- `ui`: port 4200\n",
            agent_md: "# Services\nStart the UIs.",
            swf_steps: REPORTED_SETTINGS.toJSON(),
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
  let tokenReads = 0;
  const sessionVmService = new SessionVmService({
    compute,
    monitoring: { runningSeconds: async () => 0 },
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
      swfSystem: "## Issue #{{number}}; questions start with {{questionPrefix}}\n",
      swfPlan: readPrompt("1-plan"),
      swfImplement: readPrompt("2-implement"),
      swfEscalate: readPrompt("2-implement-escalate"),
      swfVerify: readPrompt("3-verify"),
      swfReview: readPrompt("4-review"),
      swfPr: readPrompt("5-pr"),
      swfNudge: readPrompt("nudge"),
      swfContinue: readPrompt("continue"),
      swfAnswer: readPrompt("answer"),
      swfBadResult: readPrompt("bad-result"),
      swfGateFailed: readPrompt("gate-failed"),
      swfGateEscalate: readPrompt("gate-escalate"),
    }),
    newId: () => SESSION_ID,
    now: () => NOW,
    log: (message) => logs.push(message),
    ...overrides,
    github,
    githubApp,
    vm: () => vm,
  };
  return { poller: new Poller(deps), logs, tokenReads: () => tokenReads };
}

/** The pipeline record of acme/app#12, which names its record comment, at `step` with one running run of it, apart from `fields`. */
function recordAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...started(NOW).toJSON(), recordId: RECORD_ID, step, runs: [runOf(1, step)], ...fields });
}

/** The body of a record comment of acme/app#12 at `step`, as a release that wrote records of `version` left it; without one for null. */
function oldRecordComment(step: SwfStep, version: number | null): string {
  return recordAt(step, { pullRequest: PULL_REQUEST }).toComment().replace(/"version":\d+,/, version === null ? "" : `"version":${version},`);
}

/** A run of `step` that started at NOW and still runs, apart from `fields`. */
function runOf(n: number, step: SwfStep, fields: Partial<Run> = {}): Run {
  return { n, step, startedAt: new Date(NOW).toISOString(), endedAt: null, outcome: "running", ...fields };
}

/** The comments of acme/app#12: the poller's record comment with `record`, then `comments`. */
function threadOf(record: Pipeline, ...comments: IssueComment[]): IssueComment[] {
  return [{ id: RECORD_ID, author: BOT_NAME, createdAt: "2026-10-13T08:01:00Z", body: record.toComment() }, ...comments];
}

/** A comment of the agent that carries `result` as its step result. */
function resultComment(id: number, result: Record<string, unknown>, text = "Done."): IssueComment {
  return { id, author: BOT_NAME, createdAt: "2026-10-13T09:00:00Z", body: `${text}\n\n<!-- hunt:step ${JSON.stringify(result)} -->\n` };
}

/** Pull request PULL_REQUEST at HEAD_SHA, open, blocked by GitHub, its checks passed and approved by the repository's review workflow, apart from `fields`. */
function pullRequestOf(fields: Partial<z.input<typeof PullRequestState.schema>> = {}): PullRequestState {
  const url = `https://github.com/acme/app/pull/${PULL_REQUEST}`;
  return new PullRequestState({
    number: PULL_REQUEST,
    url,
    title: "fix: login",
    headSha: HEAD_SHA,
    state: "open",
    mergeState: "BLOCKED",
    reviewDecision: "APPROVED",
    checks: "success",
    labels: [],
    ...fields,
  });
}

function reviewOf(id: number, author: string, state: string, body = ""): PullRequestReview {
  return { id, author, state, body, submittedAt: "2026-10-14T09:00:00Z" };
}

interface SessionOptions extends FakeGitHubOptions {
  /** The issue's labels; the label of the record's step without them. */
  labels?: string[];
  /** The comments on the issue after the record comment. */
  comments?: IssueComment[];
  vmStatus?: string;
}

/**
 * The poller following the VM of session SESSION_ID for acme/app#12, an issue assigned to carol whose thread holds the
 * record comment with `record` and then `comments`; `stored` is the issue as GitHub keeps it, `listed` the VM.
 */
function followSession(record: Pipeline, { labels = [`swf:${record.step}`], comments = [], vmStatus = "RUNNING", ...options }: SessionOptions = {}) {
  const stored: Issue = { ...issue(12, "Issue 12", labels), assignees: ["carol"] };
  const github = fakeGitHub({}, { ...options, lookup: { [KEY]: stored }, threads: { ...options.threads, [KEY]: threadOf(record, ...comments) } });
  const listed = [{ ...sessionVmOf(record.step), status: vmStatus }];
  const compute = fakeCompute(listed);
  const { vm, calls } = fakeVm();
  return { ...createPoller({ github, compute, vm }), github, compute, listed, stored, calls };
}

/**
 * The poller following acme/app#12, an issue in progress whose thread holds the record comment with `record` and then
 * `comments`, while Compute Engine lists no VM at all; a replacement VM would be VM, as the poller creates it.
 */
function followIssueWithoutVm(record: Pipeline, { labels = [`swf:${record.step}`], comments = [], ...options }: Omit<SessionOptions, "vmStatus"> = {}) {
  const stored: Issue = { ...issue(12, "Issue 12", labels), assignees: ["carol"] };
  const github = fakeGitHub({}, { ...options, inProgress: { "acme/app": [stored] }, lookup: { [KEY]: stored }, threads: { ...options.threads, [KEY]: threadOf(record, ...comments) } });
  const compute = fakeCompute([]);
  const { vm, calls } = fakeVm();
  return { ...createPoller({ github, compute, vm }), github, compute, stored, calls };
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

  it("claims the issue with the plan label before anything else, sets the session up like a handoff on the default branch and posts the record once hunt.json's swf settings are known", async () => {
    const github = fakeGitHub({ "acme/app": [issue(12, "Fix login", ["swf", "bug"])] });
    const compute = fakeCompute();
    const { vm, calls, claudeFiles } = fakeVm();
    const { poller, logs } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.drain();

    const labels = ["plan", "implement", "verify", "review", "pr", "pr-gate", "merge", "question", "done", "failed"];
    // The plan step creates the branch; the issue moves to In Progress once the settings of hunt.json are known.
    const planned = Pipeline.start({ ...ISSUE, branch: "" }, REPORTED_SETTINGS, NOW);
    expect(github.calls).toEqual([
      "in-progress acme/app",
      "issues acme/app swf",
      ...labels.map((label) => `ensure acme/app swf:${label}`),
      "unlabel acme/app#12 swf",
      "label acme/app#12 swf:plan",
      "identity acme/app alice",
      `comment acme/app#12 ${planned.toComment()}`,
      `update acme/app ${FIRST_POSTED_ID}`,
      "move acme/app#12 In Progress",
    ]);
    planned.noteRecordComment(FIRST_POSTED_ID);
    expect(compute.inserted).toEqual([
      { name: VM, template: "tpl-hunt-session", machineType: null, labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" } },
    ]);
    expect(compute.metadata).toEqual([
      [
        { key: "startup-script", value: "#!/bin/sh" },
        { key: "hunt-session-id", value: SESSION_ID },
        { key: "hunt-repo", value: "acme/app" },
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
      `hunt-ctl clone ${SESSION_ID} --repo acme/app ${gitOptions("alice")} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl session-config ${SESSION_ID} --domain hunt.example.com`,
      `put-files ${SESSION_ID} --claude hunt-session.json`,
      `hunt-ctl deps ${SESSION_ID}`,
      `hunt-ctl swf-record ${SESSION_ID} <<< ${JSON.stringify(`${JSON.stringify({ pipeline: planned.toJSON() })}\n`)}`,
      `hunt-ctl start ${SESSION_ID} <<< ${JSON.stringify(`${CLAUDE_TOKEN}\n${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl wait ${SESSION_ID} --timeout 180`,
    ]);
    expect(logs).toContain("acme/app#12: no private files: the secret HUNT_SWF_FILES_acme_app has no version");
    expect(JSON.parse(claudeFiles[0]["hunt-session.json"])).toEqual({
      huntSessionId: SESSION_ID,
      acpSessionId: null,
      cwd: "/home/agent/app",
      systemPromptAppend:
        `\n\n## Remote session\n\n### Git\n\n## Questions\n\n## Sessions ${SESSION_ID}\n\n## Issue #12; questions start with ❓ RÜCKFRAGE\n\n### The repository's services\n- \`ui\`: port 4200\n\n` +
        "### The repository's hunt.agent.md\n# Services\nStart the UIs.\n",
      modeId: "bypassPermissions",
      configOptions: { model: "claude-opus-5-5", effort: "high" },
    });
    // The runner on the VM sends the plan prompt; the record names the comment the runner edits.
    expect(lastRecord(github)).toEqual(withoutRuns(planned.toJSON()));
    expect(lastRecord(github)).toMatchObject({ version: 4, recordId: FIRST_POSTED_ID, promptTurn: null });
    expect(github.updates.at(-1)?.body).toContain('"plan":{"skill":"acme-plan","model":"claude-opus-5-5","effort":"high","maxReturns":null,"minSeverity":null,"gate":[]}');
    expect(github.threads[KEY].map((comment) => comment.id)).toEqual([1, FIRST_POSTED_ID]);
    expect(logs.at(-1)).toBe(`acme/app#12: the runner of session ${SESSION_ID} drives the issue, beginning with the plan`);
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

  it("marks an issue without a person assigned as failed before it creates a VM, since the assignee authors the commits", async () => {
    const unassigned = { ...issue(7), assignees: ["dependabot[bot]"] };
    const github = fakeGitHub({ "acme/app": [unassigned] });
    const compute = fakeCompute();
    const { poller } = createPoller({ github, compute });

    await poller.cycle();
    await poller.drain();
    expect(compute.inserted).toEqual([]);
    expect(github.calls.slice(-4)).toEqual([
      "unlabel acme/app#7 swf:plan",
      "unlabel acme/app#7 swf:question",
      "label acme/app#7 swf:failed",
      `comment acme/app#7 Hunt could not start a session for this issue:\n\n\`\`\`\n${noAssigneeError("swf")}\n\`\`\``,
    ]);
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

  it("marks the issue as failed without a record when session-config reports unusable step settings or names no skill for an agent step", async () => {
    const answers: [Record<string, unknown>, string][] = [
      [{ swf_steps: settingsWith({ implement: { skill: null }, review: { skill: null }, pr: { skill: null } }).toJSON() }, "the step settings name no skill for the steps implement, review, pr"],
      [{ swf_steps: settingsWith({ review: { skill: null } }).toJSON() }, "the step settings name no skill for the step review"],
      [{ swf_steps: null }, "the step settings are unusable (Invalid input)"],
      [{}, "the step settings are unusable (Invalid input)"],
    ];
    for (const [answer, problem] of answers) {
      const github = fakeGitHub({ "acme/app": [issue(9)] });
      const { vm, calls } = fakeVm();
      const huntCtl = vm.huntCtl;
      vm.huntCtl = async (args, input) => (args[0] === "session-config" ? answer : huntCtl(args, input));
      const { poller, logs } = createPoller({ github, vm });

      await poller.cycle();
      await poller.drain();
      const expected = stepSettingsError(problem);
      expect(github.calls.slice(-4), problem).toEqual([
        "unlabel acme/app#9 swf:plan",
        "unlabel acme/app#9 swf:question",
        "label acme/app#9 swf:failed",
        `comment acme/app#9 Hunt could not start a session for this issue:\n\n\`\`\`\n${expected}\n\`\`\`\n\nThe VM \`${VM}\` stays for inspection.`,
      ]);
      expect(github.calls.filter((call) => call.includes("hunt:pipeline")), problem).toEqual([]);
      expect(calls.filter((call) => call.startsWith("hunt-ctl deps")), problem).toEqual([]);
      expect(logs, problem).toContain(`acme/app#9: failed: ${expected}`);
    }
  });

  it("starts the session with Claude Code's default model and effort when the plan step sets neither", async () => {
    const github = fakeGitHub({ "acme/app": [issue(12)] });
    const { vm, claudeFiles } = fakeVm();
    const huntCtl = vm.huntCtl;
    const answer = { swf_steps: settingsWith({ implement: { model: "claude-sonnet-5", effort: "max" } }).toJSON() };
    vm.huntCtl = async (args, input) => (args[0] === "session-config" ? answer : huntCtl(args, input));
    const { poller } = createPoller({ github, vm });

    await poller.cycle();
    await poller.drain();
    expect(JSON.parse(claudeFiles[0]["hunt-session.json"])).toMatchObject({ configOptions: {} });
  });

  it("moves the claimed issue to the In Progress status hunt.json names and tells the agent the repository's question prefix", async () => {
    const github = fakeGitHub({ "acme/app": [issue(12)] }, { projects: ["Board"] });
    const { vm, claudeFiles } = fakeVm();
    const huntCtl = vm.huntCtl;
    const answer = { swf_steps: CUSTOM_SETTINGS.toJSON() };
    vm.huntCtl = async (args, input) => (args[0] === "session-config" ? answer : huntCtl(args, input));
    const { poller, logs } = createPoller({ github, vm });

    await poller.cycle();
    await poller.drain();
    expect(github.calls).toContain("move acme/app#12 Doing");
    expect(github.calls).not.toContain("move acme/app#12 In Progress");
    expect(logs).toContain('acme/app#12: moved to Doing in "Board"');
    expect(JSON.parse(claudeFiles[0]["hunt-session.json"]).systemPromptAppend).toContain("## Issue #12; questions start with QUESTION\n");
  });
});

describe("Poller.cycle follows running sessions", () => {
  it("records the state the issue's labels report in the VM, once per change", async () => {
    const session = followSession(recordAt("plan", { promptTurn: 0 }), { labels: ["swf:question"] });

    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.compute.calls).toEqual(["list hunt-origin=swf", `metadata ${VM} fp0`, "list hunt-origin=swf"]);
    expect(session.compute.metadata[0]).toContainEqual({ key: "hunt-agent", value: "question" });
    expect(session.logs).toContain(`${KEY}: the agent is question`);
    expect(session.calls).toEqual([TOKEN_CALL]);

    session.stored.labels = ["swf:plan"];
    await session.poller.cycle();
    expect(session.compute.metadata[1]).toContainEqual({ key: "hunt-agent", value: "plan" });
    expect(session.calls).toEqual([TOKEN_CALL]);
  });

  it("records the branch the plan step named in the VM once the record carries it, once", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 500 }));
    session.listed[0].metadata.items = session.listed[0].metadata.items.filter((item) => item.key !== "hunt-branch");

    await session.poller.cycle();
    expect(session.compute.calls).toEqual(["list hunt-origin=swf", `metadata ${VM} fp0`]);
    expect(session.compute.metadata[0]).toContainEqual({ key: "hunt-branch", value: "feat/general/12-issue-12" });
    expect(session.logs).toContain(`${KEY}: the branch is feat/general/12-issue-12`);

    await session.poller.cycle();
    expect(session.compute.calls).toHaveLength(3);
    expect(session.compute.metadata).toHaveLength(1);
  });

  it("leaves the VM's branch alone while the record names none", async () => {
    const session = followSession(recordAt("plan", { branch: "", promptTurn: 500 }));
    session.listed[0].metadata.items = session.listed[0].metadata.items.filter((item) => item.key !== "hunt-branch");

    await session.poller.cycle();
    expect(session.compute.calls).toEqual(["list hunt-origin=swf"]);
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

    session.github.threads[KEY] = threadOf(recordAt("pr-gate", { pullRequest: PULL_REQUEST }));
    session.stored.labels = ["bug"];
    await session.poller.cycle();
    expect(session.logs.filter((line) => line.includes("no label of the workflow"))).toEqual([
      `${KEY}: the issue carries no label of the workflow; setting swf:pr-gate from the pipeline record`,
    ]);
    expect(writes(session.github).slice(0, 1)).toEqual(["label acme/app#12 swf:pr-gate"]);
  });

  it("leaves a session alone whose record is of an older version or names no version, and says so once", async () => {
    for (const version of [2, 3, null]) {
      const session = followSession(recordAt("pr-gate", { pullRequest: PULL_REQUEST }), { pullRequests: { [PULL_REQUEST]: pullRequestOf() } });
      session.github.threads[KEY][0].body = oldRecordComment("pr-gate", version);

      await session.poller.cycle();
      await session.poller.cycle();
      const warnings = session.logs.filter((line) => line.includes("left alone"));
      expect(warnings, String(version)).toHaveLength(1);
      expect(warnings[0], String(version)).toMatch(new RegExp(`^${KEY}: the pipeline record comment ${RECORD_ID} is left alone: .*version ${version ?? 1}`));
      expect(session.calls, String(version)).toEqual([TOKEN_CALL]);
      expect(writes(session.github), String(version)).toEqual([]);
    }
  });

  it("moves the issue's label back to the step of the record, which is the pipeline's truth", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 1_000 }), { labels: ["bug", "swf:plan"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:plan"]);
    expect(session.stored.labels).toEqual(["bug", "swf:implement"]);
    expect(session.logs).toContain(`${KEY}: the issue is labelled swf:plan but the pipeline is at implement; relabelling`);
  });

  /** acme/app#12 failed at implement: the agent ended its turn twice without a result in the conversation acp-1. */
  function failedAtImplement(): Pipeline {
    const ended = { endedAt: new Date(NOW).toISOString() };
    return recordAt("implement", {
      promptTurn: 1_000,
      reminded: true,
      runs: [runOf(1, "plan", { ...ended, outcome: "passed" }), runOf(2, "implement", { ...ended, outcome: "failed", sessionId: "acp-1" })],
    });
  }

  it("leaves a failed issue alone while it carries the failed label", async () => {
    const session = followSession(failedAtImplement(), { labels: ["swf:failed"] });
    await session.poller.cycle();
    expect(writes(session.github)).toEqual([]);
    expect(session.calls).toEqual([TOKEN_CALL]);
  });

  it("resumes the failed step once a person took the failed label off: a new run, the step's label and the pipeline for the runner", async () => {
    const session = followSession(failedAtImplement(), { labels: ["bug"] });
    await session.poller.cycle();
    const resumed = Pipeline.fromComment(session.github.updates.at(-1)?.body ?? "")?.pipeline;
    expect(resumed?.currentRun).toMatchObject({ n: 3, step: "implement", outcome: "running", resumes: 2 });
    expect(resumed).toMatchObject({ promptTurn: null, reminded: false, resumedConversation: "acp-1" });
    expect(writes(session.github).filter((call) => call.startsWith("label") || call.startsWith("unlabel"))).toEqual(["label acme/app#12 swf:implement"]);
    expect(session.stored.labels).toEqual(["bug", "swf:implement"]);
    expect(session.calls.at(-1)).toMatch(/^hunt-ctl swf-inbox [0-9a-f-]+ <<< .*\\"resumes\\":2/);
    expect(session.logs).toContain(`${KEY}: swf:failed was taken off; the step implement resumes`);

    session.github.threads[KEY] = threadOf(resumed as Pipeline);
    await session.poller.cycle();
    expect(session.calls.filter((call) => call.startsWith("hunt-ctl swf-inbox"))).toHaveLength(1);
  });

  it("starts the stopped VM of a resumed step and hands it the pipeline", async () => {
    const session = followSession(failedAtImplement(), { labels: ["swf:implement"], vmStatus: "SUSPENDED" });
    startable(session.compute, session.listed);
    await session.poller.cycle();
    expect(session.logs).toContain(`${KEY}: the step implement waits for its prompt while ${VM} is suspended; starting it`);
    await settle(session.logs, `${KEY}: ${VM} runs again`);
    expect(session.calls.at(-1)).toMatch(/^hunt-ctl swf-inbox [0-9a-f-]+ <<< .*\\"resumes\\":2/);
  });

  it("follows no VM that names another session's VM", async () => {
    const github = fakeGitHub({}, { lookup: { [KEY]: issue(12, "Issue 12", ["swf:verify"]) }, threads: { [KEY]: threadOf(recordAt("verify")) } });
    const compute = fakeCompute([sessionVmOf("verify"), { ...sessionVmOf("verify"), name: "vm-hunt-s-00000002" }]);
    const { vm, calls } = fakeVm();
    const { poller } = createPoller({ github, compute, vm });

    await poller.cycle();
    expect(calls).toEqual([TOKEN_CALL]);
    expect(github.calls.filter((call) => call.startsWith("issue "))).toEqual([`issue ${KEY}`]);
  });

  /** The thread of acme/app#12 after the record comment: alice's comment and the agent's question after its result 1002. */
  const question: IssueComment[] = [
    { id: 1001, author: "alice", createdAt: "2026-10-13T08:30:00Z", body: "Also the logout." },
    { id: 1003, author: BOT_NAME, createdAt: "2026-10-13T10:00:00Z", body: "**❓ RÜCKFRAGE**\n\n@alice Postgres or SQLite?" },
  ];
  const bobsAnswer: IssueComment = { id: 1004, author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres, please." };

  it("starts the stopped VM of a session whose step waits for its prompt and hands it the pipeline, and leaves one off whose prompt was sent", async () => {
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
    expect(session.calls.filter((call) => call.startsWith("hunt-ctl swf-inbox"))).toHaveLength(1);
    expect(session.calls.at(-1)).toMatch(/^hunt-ctl swf-inbox [0-9a-f-]+ <<< .*\\"kind\\":\\"pipeline\\".*\\"step\\":\\"implement\\"/);

    await session.poller.cycle();
    expect(session.calls.slice(-1)).toEqual([TOKEN_CALL]);
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
      // Lets the start of this poll fail in the background before the next poll.
      await new Promise((resolve) => setImmediate(resolve));
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

  it("leaves the agent steps to the runner on the VM, and says so once", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 500 }));
    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.calls).toEqual([TOKEN_CALL]);
    expect(writes(session.github)).toEqual([]);
    expect(session.logs.filter((line) => line.includes("drives the step"))).toEqual([`${KEY}: the runner on ${VM} drives the step implement`]);

    // A result comment on the issue is the runner's mirror, not a result for the poller.
    session.github.threads[KEY].push(resultComment(1004, { step: "implement", summary: "Done." }));
    await session.poller.cycle();
    expect(writes(session.github)).toEqual([]);
    expect(session.calls).toEqual([TOKEN_CALL]);
  });

  it("hands the answers to the runner's inbox once each, and starts its stopped VM for them", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 500 }), { labels: ["swf:question"], comments: question });
    const thread = session.github.threads[KEY];
    await session.poller.cycle();
    expect(session.calls).toEqual([TOKEN_CALL]);

    thread.push(bobsAnswer);
    await session.poller.cycle();
    const answers = JSON.stringify({ kind: "answers", comments: [{ author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres, please." }] });
    expect(session.calls).toEqual([TOKEN_CALL, `hunt-ctl swf-inbox ${SESSION_ID} <<< ${JSON.stringify(`${answers}\n`)}`]);
    expect(writes(session.github)).toEqual([]);
    expect(session.logs).toContain(`${KEY}: an answer arrived on the issue; handed it to the runner on ${VM}`);
    await session.poller.cycle();
    expect(session.calls).toHaveLength(2);

    const stopped = followSession(recordAt("implement", { promptTurn: 500 }), { labels: ["swf:question"], comments: [...question, bobsAnswer], vmStatus: "TERMINATED" });
    startable(stopped.compute, stopped.listed);
    await stopped.poller.cycle();
    expect(stopped.logs).toContain(`${KEY}: an answer arrived on the issue while ${VM} is terminated; starting it`);
    await settle(stopped.logs, `${KEY}: ${VM} runs again`);
    expect(stopped.calls.at(-1)).toMatch(/^hunt-ctl swf-inbox [0-9a-f-]+ <<< .*\\"kind\\":\\"pipeline\\"/);
    await stopped.poller.cycle();
    expect(stopped.calls.at(-1)).toContain('\\"kind\\":\\"answers\\"');
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
  it("moves the issue to In Review at the first poll after the pull request opened, then waits for the checks of the head commit without asking anyone or the VM", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ checks: "pending", reviewDecision: "REVIEW_REQUIRED" }) };
    const ended = { endedAt: new Date(NOW).toISOString(), outcome: "passed" as const };
    const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, runs: [runOf(1, "pr", ended), runOf(2, "pr-gate")] });
    const session = followSession(record, { pullRequests, projects: ["Board"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["assign acme/app#31 carol", "move acme/app#12 In Review", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual(withoutRuns({ ...record.toJSON(), inReview: true }));
    expect(session.calls).toHaveLength(2);
    expect(session.calls[1]).toMatch(/^hunt-ctl swf-inbox [0-9a-f-]+ <<< .*\\"inReview\\":true/);
    expect(session.logs).toContain(`${KEY}: moved to In Review in "Board"`);
    expect(session.logs).toContain(`${KEY}: pr-gate: the checks of #31 are still running`);

    expect(session.logs).toContain(`${KEY}: assigned #31 to @carol`);

    // Assigned and moved once; the wait goes on without the VM.
    await session.poller.cycle();
    await session.poller.cycle();
    expect(writes(session.github)).toHaveLength(3);
    expect(session.calls).toHaveLength(2);
    expect(session.logs.filter((line) => line.includes("are still running"))).toHaveLength(1);

    // The status is the one hunt.json names, which the record keeps.
    const custom = followSession(recordAt("pr-gate", { pullRequest: PULL_REQUEST, settings: CUSTOM_SETTINGS.toJSON() }), { pullRequests, projects: ["Board"] });
    await custom.poller.cycle();
    expect(writes(custom.github)).toEqual(["assign acme/app#31 carol", "move acme/app#12 Reviewing", `update acme/app ${RECORD_ID}`]);
  });

  it("goes on with merge once the checks are done and GitHub reports the pull request as approved, whatever the checks say", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ checks: "pending", reviewDecision: "REVIEW_REQUIRED" }) };
    const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true });
    const session = followSession(record, { pullRequests });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([]);

    pullRequests[PULL_REQUEST] = pullRequestOf({ mergeState: "UNSTABLE", reviewDecision: "APPROVED", checks: "failure" });
    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:merge", "unlabel acme/app#12 swf:pr-gate", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual(withoutRuns({ ...record, step: "merge" }));
    expect(session.logs).toContain(`${KEY}: #31 was approved by GitHub's review decision; the pipeline goes on with merge`);
    expect(session.calls[0]).toBe(TOKEN_CALL);
    expect(session.calls.at(-1)).toContain('\\"step\\":\\"merge\\"');
  });

  it("asks the issue's people to review once the checks are done without an approval, failed ones too: reviewers and one comment, once per issue", async () => {
    for (const checks of ["success", "failure"] as const) {
      const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true });
      const session = followSession(record, { pullRequests: { [PULL_REQUEST]: pullRequestOf({ checks, reviewDecision: "REVIEW_REQUIRED" }) } });

      await session.poller.cycle();
      expect(writes(session.github), checks).toEqual([
        `request acme/app#${PULL_REQUEST} carol`,
        `comment acme/app#${PULL_REQUEST} ${reviewRequestComment(["carol"], 12)}`,
        `update acme/app ${RECORD_ID}`,
      ]);
      expect(lastRecord(session.github), checks).toEqual(withoutRuns({ ...record, notified: true }));
      expect(session.logs, checks).toContain(`${KEY}: asked @carol to review #31`);
      expect(session.logs, checks).toContain(`${KEY}: pr-gate: waiting for an approval of #31`);
      await session.poller.cycle();
      expect(writes(session.github), checks).toHaveLength(3);
    }

    // Asked once: a pull request that comes back to pr-gate and needs a person again mentions nobody again.
    const again = followSession(recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true, notified: true, returns: { "pr-gate": 1 } }), {
      pullRequests: { [PULL_REQUEST]: pullRequestOf({ reviewDecision: "CHANGES_REQUESTED" }) },
    });
    await again.poller.cycle();
    expect(writes(again.github)).toEqual([]);
  });

  it("drives a record of an earlier release at the retired step checks or human-review as pr-gate and replaces its label with the next step's", async () => {
    for (const former of ["checks", "human-review"]) {
      const pullRequests = { [PULL_REQUEST]: pullRequestOf({ reviewDecision: "REVIEW_REQUIRED", checks: "pending" }) };
      const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true });
      const session = followSession(record, { labels: [`swf:${former}`], pullRequests });
      session.github.threads[KEY][0].body = record.toComment().replaceAll('"step":"pr-gate"', `"step":"${former}"`);

      await session.poller.cycle();
      expect(writes(session.github), former).toEqual([]);
      expect(session.logs, former).toContain(`${KEY}: pr-gate: the checks of #31 are still running`);

      pullRequests[PULL_REQUEST] = pullRequestOf({ mergeState: "CLEAN" });
      await session.poller.cycle();
      expect(writes(session.github), former).toEqual(["label acme/app#12 swf:merge", `unlabel acme/app#12 swf:${former}`, `update acme/app ${RECORD_ID}`]);
      expect(lastRecord(session.github), former).toEqual(withoutRuns({ ...record, step: "merge" }));
    }
  });

  it("waits at pr-gate for a person's approval, ignoring bots and plain comments, then goes on with merge", async () => {
    const reviews = [reviewOf(501, "github-actions[bot]", "CHANGES_REQUESTED", "PR review"), reviewOf(502, "dave", "COMMENTED", "Looks fine so far.")];
    const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true, notified: true });
    const session = followSession(record, { pullRequests: { [PULL_REQUEST]: pullRequestOf({ mergeState: "CLEAN", reviewDecision: null }) }, reviews });

    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.logs.filter((line) => line.includes("waiting for an approval"))).toEqual([`${KEY}: pr-gate: waiting for an approval of #31`]);
    expect(writes(session.github)).toEqual([]);

    reviews.push(reviewOf(503, "carol", "APPROVED"));
    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:merge", "unlabel acme/app#12 swf:pr-gate", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual(withoutRuns({ ...record, step: "merge" }));
    expect(session.logs).toContain(`${KEY}: #31 was approved by carol; the pipeline goes on with merge`);
  });

  it("sends a person's change request at pr-gate back to implement with the review and its inline comments, once", async () => {
    const reviews = [reviewOf(503, "carol", "CHANGES_REQUESTED", "Please rename the index.\n")];
    const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true, notified: true, returns: { "pr-gate": 1 } });
    const session = followSession(record, { pullRequests: { [PULL_REQUEST]: pullRequestOf({ reviewDecision: "CHANGES_REQUESTED" }) }, reviews, reviewComments: ["db/migrations/0007.sql:3: Use a partial index."] });

    await session.poller.cycle();
    expect(session.github.calls).toContain(`review-comments acme/app#${PULL_REQUEST} 503`);
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:pr-gate", `update acme/app ${RECORD_ID}`]);
    const sentBack = lastRecord(session.github)!;
    expect(sentBack).toEqual(withoutRuns({
      ...record,
      step: "implement",
      returns: { "pr-gate": 2 },
      findings: ["@carol requested changes on #31:\nPlease rename the index.\ndb/migrations/0007.sql:3: Use a partial index."],
      handledReview: 503,
    }));
    expect(session.logs).toContain(`${KEY}: carol requested changes on #31; back to implement`);

    session.github.threads[KEY][0].body = new Pipeline({ ...sentBack, step: "pr-gate", runs: [] }).toComment();
    session.stored.labels = ["swf:pr-gate"];
    await session.poller.cycle();
    expect(session.stored.labels).toEqual(["swf:pr-gate"]);
    expect(session.logs.at(-1)).toBe(`${KEY}: pr-gate: a change request on #31 is open`);
  });

  it("merges a clean pull request once per head, then marks the issue as done and moves it to Done", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ mergeState: "CLEAN" }) };
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST, inReview: true }), { pullRequests, projects: ["Board"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([`merge acme/app#${PULL_REQUEST} squash`, `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ step: "merge", mergeSha: HEAD_SHA });
    expect(session.logs).toContain(`${KEY}: merged #31`);
    await session.poller.cycle();
    expect(writes(session.github)).toHaveLength(2);
    expect(session.logs).toContain(`${KEY}: merge: the merge was requested`);

    pullRequests[PULL_REQUEST].state = "merged";
    await session.poller.cycle();
    expect(writes(session.github).slice(2)).toEqual([
      `update acme/app ${RECORD_ID}`,
      "unlabel acme/app#12 swf:merge",
      "label acme/app#12 swf:done",
      "comment acme/app#12 Hunt merged pull request #31.",
      "move acme/app#12 Done",
    ]);
    expect(session.logs).toContain(`${KEY}: moved to Done in "Board"`);
    expect(session.logs).toContain(`${KEY}: done, #31 is merged`);
    expect(runsOf(session.github)).toEqual([[1, "merge", "passed", undefined]]);

    await session.poller.cycle();
    expect(session.compute.metadata.at(-1)).toContainEqual({ key: "hunt-agent", value: "done" });
    expect(writes(session.github)).toHaveLength(7);
  });

  it("merges the way hunt.json says and moves the issue to the Done status it names", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ mergeState: "CLEAN" }) };
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST, inReview: true, settings: CUSTOM_SETTINGS.toJSON() }), { pullRequests, projects: ["Board"] });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([`merge acme/app#${PULL_REQUEST} rebase`, `update acme/app ${RECORD_ID}`]);

    pullRequests[PULL_REQUEST].state = "merged";
    await session.poller.cycle();
    expect(writes(session.github).at(-1)).toBe("move acme/app#12 Shipped");
    expect(session.logs).toContain(`${KEY}: moved to Shipped in "Board"`);
  });

  it("updates the branch of a pull request that is behind its base once per head and merges it once it is clean", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ mergeState: "BEHIND" }) };
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST, inReview: true }), { pullRequests });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([`update-branch acme/app#${PULL_REQUEST}`, `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ mergeSha: HEAD_SHA });
    expect(session.logs).toContain(`${KEY}: #31 is behind its base; updating the branch`);
    await session.poller.cycle();
    expect(writes(session.github)).toHaveLength(2);
    expect(session.logs).toContain(`${KEY}: merge: the branch is being updated`);

    pullRequests[PULL_REQUEST] = pullRequestOf({ headSha: "b".repeat(40), mergeState: "CLEAN" });
    await session.poller.cycle();
    expect(writes(session.github).slice(2)).toEqual([`merge acme/app#${PULL_REQUEST} squash`, `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ mergeSha: "b".repeat(40) });
  });

  it("sends a pull request that conflicts with its base back to implement", async () => {
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST, inReview: true, mergeSha: HEAD_SHA }), { pullRequests: { [PULL_REQUEST]: pullRequestOf({ mergeState: "DIRTY" }) } });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:merge", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual(withoutRuns({
      ...recordAt("implement", { pullRequest: PULL_REQUEST, inReview: true }),
      returns: { merge: 1 },
      findings: ["Merge: the branch conflicts with the base branch; merge the base branch into 0123456's branch, resolve the conflicts and push"],
    }));
    expect(session.logs).toContain(`${KEY}: #31 conflicts with its base; back to implement`);
  });

  it("sends a blocked pull request whose checks are done without an approval from merge back to pr-gate, which asks the people", async () => {
    const record = recordAt("merge", { pullRequest: PULL_REQUEST, inReview: true, mergeSha: HEAD_SHA });
    const session = followSession(record, { pullRequests: { [PULL_REQUEST]: pullRequestOf({ headSha: "b".repeat(40), mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }) } });

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:pr-gate", "unlabel acme/app#12 swf:merge", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toEqual(withoutRuns({ ...record, step: "pr-gate", mergeSha: null }));
    expect(session.logs).toContain(`${KEY}: #31 is blocked (it has no approval); back to pr-gate`);

    await session.poller.cycle();
    expect(writes(session.github).slice(3)).toEqual([
      `request acme/app#${PULL_REQUEST} carol`,
      `comment acme/app#${PULL_REQUEST} ${reviewRequestComment(["carol"], 12)}`,
      `update acme/app ${RECORD_ID}`,
    ]);
    expect(lastRecord(session.github)).toEqual(withoutRuns({ ...record, step: "pr-gate", mergeSha: null, notified: true }));
  });

  it("waits at merge while the checks of a mergeable pull request still run", async () => {
    const session = followSession(recordAt("merge", { pullRequest: PULL_REQUEST, inReview: true }), { pullRequests: { [PULL_REQUEST]: pullRequestOf({ mergeState: "CLEAN", checks: "pending" }) } });

    await session.poller.cycle();
    await session.poller.cycle();
    expect(writes(session.github)).toEqual([]);
    expect(session.logs.filter((line) => line.includes("merge:"))).toEqual([`${KEY}: merge: the checks of the head commit are still running`]);
  });

  it("marks the issue as failed when the pull request was closed without a merge or does not exist", async () => {
    const closed = followSession(recordAt("pr-gate", { pullRequest: PULL_REQUEST }), { pullRequests: { [PULL_REQUEST]: pullRequestOf({ state: "closed" }) } });
    await closed.poller.cycle();
    expect(writes(closed.github)).toEqual([
      "unlabel acme/app#12 swf:pr-gate",
      "unlabel acme/app#12 swf:question",
      "label acme/app#12 swf:failed",
      `comment acme/app#12 ${closedComment(PULL_REQUEST)}`,
    ]);

    const missing = followSession(recordAt("pr-gate", { pullRequest: PULL_REQUEST }));
    await missing.poller.cycle();
    expect(writes(missing.github).at(-1)).toBe("comment acme/app#12 Pull request #31 does not exist (any more), so this issue is marked as failed.");
  });

  it("marks the issue as failed at its first poll in pr-gate when it has no assignee any more, without assigning or moving anything", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ checks: "pending" }) };
    const session = followSession(recordAt("pr-gate", { pullRequest: PULL_REQUEST }), { pullRequests });
    session.stored.assignees = [];

    await session.poller.cycle();
    expect(writes(session.github)).toEqual([
      "unlabel acme/app#12 swf:pr-gate",
      "unlabel acme/app#12 swf:question",
      "label acme/app#12 swf:failed",
      `comment acme/app#12 ${noAssigneeComment(PULL_REQUEST, "swf:failed")}`,
    ]);
  });

  it("drives the poller steps of a session whose VM is off, which need GitHub only, and starts the VM once the pipeline is back at the agent", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ mergeState: "CLEAN" }) };
    const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true, notified: true });
    const session = followSession(record, { pullRequests, reviews: [reviewOf(503, "carol", "APPROVED")], vmStatus: "SUSPENDED" });
    startable(session.compute, session.listed);

    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:merge", "unlabel acme/app#12 swf:pr-gate", `update acme/app ${RECORD_ID}`]);

    pullRequests[PULL_REQUEST].mergeState = "DIRTY";
    await session.poller.cycle();
    expect(lastRecord(session.github)).toMatchObject({ step: "implement", returns: { merge: 1 }, promptTurn: null });
    expect(session.compute.calls.filter((call) => /^(start|resume) /.test(call))).toEqual([]);
    expect(session.calls).toEqual([]);

    await session.poller.cycle();
    expect(session.logs).toContain(`${KEY}: the step implement waits for its prompt while ${VM} is suspended; starting it`);
    await settle(session.logs, `${KEY}: ${VM} runs again`);
    expect(session.compute.calls).toContain(`resume ${VM}`);
  });
});

describe("Poller.cycle replaces a lost VM", () => {
  const planResult = resultComment(1001, { step: "plan", branch: ISSUE.branch }, "## Plan\n\n1. Fix it.");
  const ended = { endedAt: "2026-10-13T09:00:00.000Z" };
  /** A record at implement after the plan, whose prompt went out on the lost VM. */
  const implementing = (fields: Partial<z.input<typeof Pipeline.schema>> = {}) =>
    recordAt("implement", { lastResultId: 0, promptTurn: 1_000, runs: [runOf(1, "plan", { ...ended, outcome: "passed" }), runOf(2, "implement")], ...fields });
  const restartedRuns: [number, string, string, number | undefined][] = [
    [1, "plan", "passed", undefined],
    [2, "implement", "restarted", undefined],
    [3, "implement", "running", undefined],
  ];

  it("re-provisions the VM of an issue at an agent step like a setup, restores .hunt/swf from the record and the step results, starts the step over and tells the issue", async () => {
    const record = implementing();
    const session = followIssueWithoutVm(record, { comments: [planResult] });
    await session.poller.cycle();
    expect(session.logs).toContain(`${KEY}: the issue has no VM at the step implement; replacing it with ${VM}, session ${SESSION_ID}, branch feat/general/12-issue-12`);
    // A second poll while the replacement is under way starts no second one.
    await session.poller.cycle();
    await session.poller.drain();

    expect(session.compute.inserted.map((request) => request.name)).toEqual([VM]);
    // The VM records the pipeline's step as the agent's state, not the plan of a new session.
    expect(session.compute.metadata.at(-1)).toEqual(
      expect.arrayContaining([
        { key: "hunt-repo", value: "acme/app" },
        { key: "hunt-branch", value: "feat/general/12-issue-12" },
        { key: "hunt-issue", value: "12" },
        { key: "hunt-agent", value: "implement" },
      ]),
    );
    const restarted = new Pipeline(record.toJSON());
    restarted.restart(NOW);
    expect(session.calls).toEqual([
      "wait until ready",
      "ensure release",
      `hunt-ctl put-remote-secrets <<< ${JSON.stringify("{}")}`,
      "hunt-ctl install-tools",
      `hunt-ctl clone ${SESSION_ID} --repo acme/app --branch feat/general/12-issue-12 ${gitOptions("carol")} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl session-config ${SESSION_ID} --domain hunt.example.com`,
      `put-files ${SESSION_ID} --claude hunt-session.json`,
      `hunt-ctl deps ${SESSION_ID}`,
      `hunt-ctl swf-record ${SESSION_ID} <<< ${JSON.stringify(`${JSON.stringify({ pipeline: restarted.toJSON() })}\n`)}`,
      `hunt-ctl swf-record ${SESSION_ID} <<< ${JSON.stringify(`${JSON.stringify({ pipeline: restarted.toJSON(), step: { n: 1, step: "plan", body: planResult.body } })}\n`)}`,
      `hunt-ctl start ${SESSION_ID} <<< ${JSON.stringify(`${CLAUDE_TOKEN}\n${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl wait ${SESSION_ID} --timeout 180`,
    ]);
    // The record keeps everything but the runs and the prompt: the runner sends the step's prompt afresh.
    expect(lastRecord(session.github)).toEqual({ ...withoutRuns(record.toJSON()), promptTurn: null, reminded: false });
    expect(runsOf(session.github)).toEqual(restartedRuns);
    expect(writes(session.github)).toEqual([`update acme/app ${RECORD_ID}`, `comment acme/app#12 Hunt found no VM for this issue any more and replaced it with \`${VM}\`; the step \`implement\` starts over there with what the steps before it left on the issue.`]);
    expect(session.logs).toContain(`${KEY}: ${VM} replaces the lost VM with 1 step result(s) restored; the runner starts the step implement over`);
  });

  it("clones the default branch for an issue whose VM was lost during the plan, which then starts from scratch", async () => {
    const session = followIssueWithoutVm(recordAt("plan", { branch: "", promptTurn: 1_000 }));
    await session.poller.cycle();
    await session.poller.drain();

    expect(session.logs).toContain(`${KEY}: the issue has no VM at the step plan; replacing it with ${VM}, session ${SESSION_ID}, the default branch, since the plan step named no branch yet`);
    expect(session.compute.metadata.at(-1)!.map((item) => item.key)).not.toContain("hunt-branch");
    expect(session.calls).toContain(`hunt-ctl clone ${SESSION_ID} --repo acme/app ${gitOptions("carol")} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`);
    expect(runsOf(session.github)).toEqual([[1, "plan", "restarted", undefined], [2, "plan", "running", undefined]]);
    expect(session.logs).toContain(`${KEY}: ${VM} replaces the lost VM with 0 step result(s) restored; the runner starts the step plan over`);
  });

  it("marks the issue as failed at its step when the replacement fails", async () => {
    const session = followIssueWithoutVm(implementing(), { comments: [planResult] });
    session.compute.insert = async () => {
      throw new Error("quota exceeded");
    };
    await session.poller.cycle();
    await session.poller.drain();
    expect(writes(session.github)).toEqual(["unlabel acme/app#12 swf:implement", "unlabel acme/app#12 swf:question", "label acme/app#12 swf:failed", "comment acme/app#12 Hunt could not start a session for this issue:\n\n```\nquota exceeded\n```"]);
    expect(session.logs).toContain(`${KEY}: failed: quota exceeded`);
  });

  it("drives the poller steps of an issue without a VM on GitHub alone and replaces the VM only once the pipeline is back at the agent", async () => {
    const pullRequests = { [PULL_REQUEST]: pullRequestOf({ reviewDecision: "REVIEW_REQUIRED" }) };
    const reviews: PullRequestReview[] = [];
    const record = recordAt("pr-gate", { pullRequest: PULL_REQUEST, inReview: true, notified: true, runs: [runOf(1, "pr", { ...ended, outcome: "passed" }), runOf(2, "merge", { ...ended, outcome: "passed" }), runOf(3, "pr-gate")] });
    const session = followIssueWithoutVm(record, { pullRequests, reviews, reviewComments: [] });

    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.compute.inserted).toEqual([]);
    expect(session.calls).toEqual([]);
    expect(writes(session.github)).toEqual([]);
    expect(session.logs.filter((line) => line.includes("pr-gate"))).toEqual([`${KEY}: pr-gate: waiting for an approval of #${PULL_REQUEST}`]);

    reviews.push(reviewOf(503, "carol", "CHANGES_REQUESTED", "Rename it"));
    await session.poller.cycle();
    expect(writes(session.github)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:pr-gate", `update acme/app ${RECORD_ID}`]);
    expect(lastRecord(session.github)).toMatchObject({ step: "implement", returns: { "pr-gate": 1 }, promptTurn: null, handledReview: 503 });
    expect(session.compute.inserted).toEqual([]);

    await session.poller.cycle();
    await session.poller.drain();
    expect(session.compute.inserted.map((request) => request.name)).toEqual([VM]);
    expect(runsOf(session.github).slice(2)).toEqual([[3, "pr-gate", "returned", undefined], [4, "implement", "restarted", 3], [5, "implement", "running", undefined]]);
    expect(session.calls.filter((call) => call.startsWith("hunt-ctl swf-record"))).toHaveLength(1);
  });

  it("lets the question of an issue without a VM wait for its answer and replaces the VM once it arrived, with the step's label back", async () => {
    const asked: IssueComment = { id: 1003, author: BOT_NAME, createdAt: "2026-10-13T10:00:00Z", body: "**❓ RÜCKFRAGE**\n\n@alice Postgres or SQLite?" };
    const session = followIssueWithoutVm(implementing(), { labels: ["swf:question"], comments: [planResult, asked] });
    await session.poller.cycle();
    await session.poller.cycle();
    expect(session.compute.inserted).toEqual([]);
    expect(session.logs.filter((line) => line.includes("no VM"))).toEqual([`${KEY}: the issue has no VM; its question waits for an answer, which needs none`]);

    session.github.threads[KEY].push({ id: 1004, author: "bob", createdAt: "2026-10-13T10:05:00Z", body: "Postgres, please." });
    await session.poller.cycle();
    await session.poller.drain();
    expect(session.compute.inserted.map((request) => request.name)).toEqual([VM]);
    expect(writes(session.github).slice(0, 2)).toEqual(["label acme/app#12 swf:implement", "unlabel acme/app#12 swf:question"]);
    expect(runsOf(session.github)).toEqual(restartedRuns);
  });

  it("follows no issue whose VM is listed or being set up", async () => {
    const session = followSession(recordAt("implement", { promptTurn: 500 }), { inProgress: { "acme/app": [{ ...issue(12, "Issue 12", ["swf:implement"]), assignees: ["carol"] }] } });
    await session.poller.cycle();
    expect(session.compute.inserted).toEqual([]);
    expect(session.logs.filter((line) => line.includes("no VM"))).toEqual([]);
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
