import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Transport } from "./acpClient.ts";
import type { Compute, Instance, InstanceRequest, MetadataItem } from "./gcp.ts";
import type { GitHub, Issue } from "./github.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { SessionVm } from "./sessionVm.ts";
import { Poller, relayStatus, type PollerDeps } from "./swf.ts";
import { readSwfConfig, type SwfConfig } from "./swfConfig.ts";

const SWF_FIRST = readFileSync(new URL("../prompts/swf-first.user-prompt.md", import.meta.url), "utf8");
const SWF_NUDGE = readFileSync(new URL("../prompts/swf-nudge.user-prompt.md", import.meta.url), "utf8");
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const CLAUDE_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";
const CONFIG: SwfConfig = { repos: ["acme/app"], maxSessions: 2 };
const SESSION_ID = "ab12cd34-0000-4000-8000-000000000001";
const VM = "vm-hunt-s-ab12cd34";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  const url = `https://github.com/acme/app/issues/${number}`;
  return { number, title, body: `Body of ${number}`, author: "alice", createdAt: "2026-10-13T08:00:00Z", url, labels, state: "open" };
}

/**
 * A GitHub whose open issues with the label are `issues` by repository and whose single issues are `lookup` by
 * `<repo>#<number>` (null: deleted); every call is recorded as one line.
 */
function fakeGitHub(issues: Record<string, Issue[]>, options: { labelGone?: number[]; lookup?: Record<string, Issue | null> } = {}): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openIssues: async (repo, label) => {
      calls.push(`issues ${repo} ${label}`);
      return issues[repo] ?? [];
    },
    issue: async (repo, number) => {
      calls.push(`issue ${repo}#${number}`);
      return options.lookup?.[`${repo}#${number}`] ?? null;
    },
    comments: async (repo, number) => {
      calls.push(`comments ${repo}#${number}`);
      return [{ author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Please hurry." }];
    },
    removeLabel: async (repo, number, label) => {
      calls.push(`unlabel ${repo}#${number} ${label}`);
      return !options.labelGone?.includes(number);
    },
    addLabels: async (repo, number, labels) => {
      calls.push(`label ${repo}#${number} ${labels.join(",")}`);
    },
    comment: async (repo, number, body) => {
      calls.push(`comment ${repo}#${number} ${body}`);
    },
    ensureLabel: async (repo, label) => {
      calls.push(`ensure ${repo} ${label.name}`);
    },
  };
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
    operation: async () => ({ isDone: true, error: null }),
    setMetadata: async (_zone, name, fingerprint, items) => {
      calls.push(`metadata ${name} ${fingerprint}`);
      metadata.push(items);
      const instance = vms.get(name)?.instance ?? listed.find((candidate) => candidate.name === name);
      instance!.metadata = { fingerprint: `${fingerprint}+`, items };
    },
    start: unexpected,
    resume: unexpected,
    stop: unexpected,
    setDiskAutoDelete: unexpected,
    delete: unexpected,
  };
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
  const vm: SessionVm = {
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
          return { services_prompt: "### The repository's services\n- `ui`: port 4200\n", agent_md: "# Services\nStart the UIs." };
        case "wait":
          return { state: "ready", acpSessionId: "acp-9" };
        default:
          return {};
      }
    },
    waitUntilReady: async () => {
      calls.push("wait until ready");
    },
    ensureRelease: async () => {
      calls.push("ensure release");
      return { version: "session@1.4.0", protocol: 1 };
    },
    putClaudeFiles: async (id, files) => {
      calls.push(`put-files ${id} --claude ${Object.keys(files).join(",")}`);
      claudeFiles.push(files);
    },
    openRelay: () => ({}) as Transport,
  };
  return { vm, calls, claudeFiles };
}

type Overrides = Omit<Partial<PollerDeps>, "github" | "vm" | "orchestrator"> & { github?: GitHub; vm?: SessionVm };

function createPoller({ github = fakeGitHub({}), vm = fakeVm().vm, compute = fakeCompute(), ...overrides }: Overrides = {}) {
  const logs: string[] = [];
  const prompts: { sessionId: string; cwd: string; text: string }[] = [];
  let tokenReads = 0;
  const orchestrator = new Orchestrator({
    compute,
    location: { project: "medconomy-hunt", zone: "europe-west3-a" },
    zones: () => ["europe-west3-a"],
    vm: () => vm,
    sleep: async () => {},
    now: () => 0,
  });
  const deps: PollerDeps = {
    readConfig: async () => CONFIG,
    readDomain: () => "hunt.example.com",
    tokens: async () => {
      tokenReads++;
      return { github: GITHUB_TOKEN, claude: CLAUDE_TOKEN };
    },
    compute,
    orchestrator,
    prompts: () => ({ remote: "## Remote session\n", gitPush: "### Git\n", swfFirst: SWF_FIRST, swfNudge: SWF_NUDGE }),
    sendPrompt: async (_transport, request) => {
      prompts.push(request);
      return "started";
    },
    newId: () => SESSION_ID,
    log: (message) => logs.push(message),
    ...overrides,
    github: () => github,
    vm: () => vm,
  };
  return { poller: new Poller(deps), logs, prompts, tokenReads: () => tokenReads };
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

  it("claims the issue before anything else and then sets the session up like a handoff", async () => {
    const github = fakeGitHub({ "acme/app": [issue(12, "Fix login", ["swf", "bug"])] });
    const compute = fakeCompute();
    const { vm, calls, claudeFiles } = fakeVm();
    const { poller, logs, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.drain();

    expect(github.calls).toEqual([
      "issues acme/app swf",
      "ensure acme/app swf:running",
      "ensure acme/app swf:question",
      "ensure acme/app swf:done",
      "ensure acme/app swf:failed",
      "comments acme/app#12",
      "unlabel acme/app#12 swf",
      "label acme/app#12 swf:running",
      `comment acme/app#12 Hunt started a session for this issue: previews at \`https://ab12cd34-<port>.hunt.example.com\` once the agent starts the services.\n\nSession \`${SESSION_ID}\` on the VM \`${VM}\`, branch \`fix/general/12-fix-login\`.`,
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
        { key: "hunt-agent", value: "running" },
      ],
    ]);
    expect(calls).toEqual([
      "wait until ready",
      "ensure release",
      "hunt-ctl install-tools",
      `hunt-ctl clone ${SESSION_ID} --repo acme/app --branch fix/general/12-fix-login <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl session-config ${SESSION_ID} --domain hunt.example.com`,
      `put-files ${SESSION_ID} --claude hunt-session.json`,
      `hunt-ctl deps ${SESSION_ID}`,
      `hunt-ctl start ${SESSION_ID} <<< ${JSON.stringify(`${CLAUDE_TOKEN}\n${GITHUB_TOKEN}\n`)}`,
      `hunt-ctl wait ${SESSION_ID} --timeout 180`,
    ]);
    expect(JSON.parse(claudeFiles[0]["hunt-session.json"])).toEqual({
      huntSessionId: SESSION_ID,
      acpSessionId: null,
      cwd: "/home/agent/app",
      systemPromptAppend:
        "\n\n## Remote session\n\n### Git\n\n### The repository's services\n- `ui`: port 4200\n\n" +
        "### The repository's hunt.agent.md\n# Services\nStart the UIs.\n",
      modeId: "bypassPermissions",
      configOptions: {},
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionId: "acp-9", cwd: "/home/agent/app" });
    expect(prompts[0].text).toContain("Work on GitHub issue #12 of acme/app: Fix login");
    expect(prompts[0].text).toContain("**@bob** on 2026-10-13 09:00 UTC:\n\nPlease hurry.");
    expect(logs.at(-1)).toBe(`acme/app#12: the agent of session ${SESSION_ID} works on the issue (prompt started)`);
    expect(logs.join("\n")).not.toContain(GITHUB_TOKEN);
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
    const blocked = new Promise<void>((resolve) => {
      finishSetup = resolve;
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
    expect(github.calls.slice(-3)).toEqual([
      "unlabel acme/app#7 swf:running",
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
  const key = "acme/app#12";

  it("records the state the issue's labels report in the VM, once per change", async () => {
    const listed = [sessionVmOf("running")];
    const github = fakeGitHub({}, { lookup: { [key]: issue(12, "Issue 12", ["swf:question"]) } });
    const compute = fakeCompute(listed);
    const { vm, calls } = fakeVm();
    const { poller, logs, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.cycle();
    expect(compute.calls).toEqual(["list hunt-origin=swf", `metadata ${VM} fp0`, "list hunt-origin=swf"]);
    expect(compute.metadata[0]).toContainEqual({ key: "hunt-agent", value: "question" });
    expect(logs).toContain(`${key}: the agent is question`);
    expect(calls).toEqual([]);
    expect(prompts).toEqual([]);

    github.issue = async () => issue(12, "Issue 12", ["swf:running"]);
    await poller.cycle();
    expect(compute.metadata[1]).toContainEqual({ key: "hunt-agent", value: "running" });
    expect(calls).toEqual([`hunt-ctl status ${SESSION_ID}`]);
  });

  it("counts a closed or deleted issue as done", async () => {
    const compute = fakeCompute([sessionVmOf("running")]);
    const github = fakeGitHub({}, { lookup: { [key]: { ...issue(12, "Issue 12", ["swf:running"]), state: "closed" } } });
    const { poller } = createPoller({ github, compute });
    await poller.cycle();
    expect(compute.metadata[0]).toContainEqual({ key: "hunt-agent", value: "done" });

    const deleted = fakeCompute([sessionVmOf("running")]);
    const { poller: other } = createPoller({ github: fakeGitHub({}, { lookup: { [key]: null } }), compute: deleted });
    await other.cycle();
    expect(deleted.metadata[0]).toContainEqual({ key: "hunt-agent", value: "done" });
  });

  it("reminds an agent that ended its turn with the issue still running once, then marks the issue as failed", async () => {
    let status = statusOf("running", null);
    const github = fakeGitHub({}, { lookup: { [key]: issue(12, "Issue 12", ["swf:running"]) } });
    const compute = fakeCompute([sessionVmOf("running")]);
    const { vm } = fakeVm(undefined, () => status);
    const { poller, logs, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    expect(prompts).toEqual([]);

    status = statusOf("idle", 1_000);
    await poller.cycle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ sessionId: "acp-9", cwd: "/home/agent/app" });
    expect(prompts[0].text.startsWith("Your last turn ended, but issue #12 of acme/app still has the label `swf:running`")).toBe(true);
    expect(logs).toContain(`${key}: the agent ended its turn with the issue still labelled swf:running; reminded it (prompt started)`);

    await poller.cycle();
    status = statusOf("running", 1_000);
    await poller.cycle();
    expect(prompts).toHaveLength(1);
    expect(github.calls.filter((call) => call.startsWith("unlabel"))).toEqual([]);

    status = statusOf("idle", 2_000);
    await poller.cycle();
    expect(prompts).toHaveLength(1);
    expect(github.calls.filter((call) => !call.startsWith("issue"))).toEqual([
      "unlabel acme/app#12 swf:running",
      "label acme/app#12 swf:failed",
      `comment acme/app#12 Hunt's agent ended its turn twice without opening a pull request, asking a question or giving up, so this issue is marked as failed. The VM \`${VM}\` keeps the session: open it in Hunt to see what happened and to continue.`,
    ]);
    expect(logs).toContain(`${key}: the agent ended its turn again with the issue still labelled swf:running; marking the issue as failed`);

    await poller.cycle();
    expect(github.calls.filter((call) => call.startsWith("unlabel"))).toHaveLength(1);
  });

  it("sends no reminder while a desktop is connected to the session, nor to a VM being set up or stopped", async () => {
    const github = fakeGitHub({}, { lookup: { [key]: issue(12, "Issue 12", ["swf:running"]) } });
    const compute = fakeCompute([sessionVmOf("running"), { ...sessionVmOf("running"), name: "vm-hunt-s-00000002", status: "TERMINATED" }]);
    const { vm, calls } = fakeVm(undefined, () => statusOf("idle", 1_000, true));
    const { poller, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    expect(calls).toEqual([`hunt-ctl status ${SESSION_ID}`]);
    expect(prompts).toEqual([]);
    expect(github.calls.filter((call) => call.startsWith("issue "))).toEqual([`issue ${key}`]);
  });

  it("logs a lasting failure to follow a session once and goes on with the other sessions", async () => {
    const github = fakeGitHub({}, { lookup: { [key]: issue(12, "Issue 12", ["swf:running"]) } });
    github.issue = async () => {
      throw new Error("failed to read acme/app#12: HTTP 502 Bad Gateway");
    };
    const compute = fakeCompute([sessionVmOf("running")]);
    const { poller, logs } = createPoller({ github, compute });

    await poller.cycle();
    await poller.cycle();
    expect(logs.filter((line) => line.includes("HTTP 502"))).toEqual([`${key}: failed to read acme/app#12: HTTP 502 Bad Gateway`]);
    expect(logs.at(-1)).toBe("polling acme/app: no open issues labelled swf");
  });
});

describe("relayStatus", () => {
  it("reads the relay's turn and the worktree, and is null without an ACP session or worktree", () => {
    expect(relayStatus(statusOf("idle", 5, true))).toEqual({ acpSessionId: "acp-9", turn: "idle", clientConnected: true, lastTurnEndedAt: 5, worktree: "/home/agent/app" });
    expect(relayStatus({ relay: "stopped", status: {}, meta: { worktree: "/home/agent/app" } })).toBeNull();
    expect(relayStatus({ relay: "running", status: { acpSessionId: "acp-9" }, meta: {} })).toBeNull();
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
    expect(github.calls.slice(-3)).toEqual([
      "unlabel acme/app#11 swf:running",
      "label acme/app#11 swf:failed",
      `comment acme/app#11 Hunt could not start a session for this issue:\n\n\`\`\`\nthe gateway's poller stopped while it set the session up\n\`\`\`\n\nThe VM \`${VM}\` stays for inspection.`,
    ]);
  });
});
