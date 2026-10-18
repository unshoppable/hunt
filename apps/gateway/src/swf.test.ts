import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Transport } from "./acpClient.ts";
import type { Compute, Instance, InstanceRequest, Metadata, MetadataItem } from "./gcp.ts";
import type { GitHub, Issue } from "./github.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { SessionVm } from "./sessionVm.ts";
import type { GitHubApp } from "./githubApp.ts";
import { Poller, relayStatus, secretsReader, type PollerDeps } from "./swf.ts";
import { readSwfConfig, type SwfConfig } from "./swfConfig.ts";

const SWF_FIRST = readFileSync(new URL("../prompts/swf-first.user-prompt.md", import.meta.url), "utf8");
const SWF_NUDGE = readFileSync(new URL("../prompts/swf-nudge.user-prompt.md", import.meta.url), "utf8");
const GITHUB_TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const BOT_NAME = "hunt-claude[bot]";
const BOT_EMAIL = "4242+hunt-claude[bot]@users.noreply.github.com";
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
    stop: unexpected,
    setDiskAutoDelete: unexpected,
    delete: unexpected,
    setName: unexpected,
    getDisk: unexpected,
    createSnapshot: unexpected,
    deleteSnapshot: unexpected,
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
      return "";
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

type Overrides = Omit<Partial<PollerDeps>, "github" | "vm" | "orchestrator" | "githubApp"> & { github?: GitHub; vm?: SessionVm; githubApp?: GitHubApp };

function createPoller({ github = fakeGitHub({}), vm = fakeVm().vm, compute = fakeCompute(), githubApp = fakeGitHubApp(), ...overrides }: Overrides = {}) {
  const logs: string[] = [];
  const prompts: { sessionId: string; cwd: string; text: string }[] = [];
  let tokenReads = 0;
  const orchestrator = new Orchestrator({
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
    orchestrator,
    prompts: () => ({ remote: "## Remote session\n", gitPush: "### Git\n", question: "## Questions\n", swfSystem: "## Issue #{{number}} on {{branch}}\n", swfFirst: SWF_FIRST, swfNudge: SWF_NUDGE }),
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
        "\n\n## Remote session\n\n### Git\n\n## Questions\n\n## Issue #12 on fix/general/12-fix-login\n\n### The repository's services\n- `ui`: port 4200\n\n" +
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
    const blocked = new Promise<string>((resolve) => {
      finishSetup = () => resolve("");
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
    expect(calls).toEqual([`hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`]);
    expect(prompts).toEqual([]);

    github.issue = async () => issue(12, "Issue 12", ["swf:running"]);
    await poller.cycle();
    expect(compute.metadata[1]).toContainEqual({ key: "hunt-agent", value: "running" });
    expect(calls.slice(1)).toEqual([`hunt-ctl status ${SESSION_ID}`]);
  });

  it("gives every running VM the repository's GitHub token whenever it changed, whatever the agent's state", async () => {
    const github = fakeGitHub({}, { lookup: { [key]: { ...issue(12, "Issue 12", ["swf:done"]), state: "closed" } } });
    const compute = fakeCompute([sessionVmOf("done")]);
    const githubApp = fakeGitHubApp();
    const { vm, calls } = fakeVm();
    const { poller, logs } = createPoller({ github, compute, vm, githubApp });

    await poller.cycle();
    await poller.cycle();
    expect(calls).toEqual([`hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`]);
    expect(logs.filter((line) => line.includes("fresh"))).toEqual([`${key}: gave the VM a fresh GitHub token`]);

    githubApp.setToken("ghs_renewed0123456789abcdefghijklmnopq");
    await poller.cycle();
    await poller.cycle();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify("ghs_renewed0123456789abcdefghijklmnopq\n")}`);
    expect(logs.join("\n")).not.toContain("ghs_");
  });

  it("gives a VM that stopped and runs again the token once more", async () => {
    const listed = [sessionVmOf("running")];
    const github = fakeGitHub({}, { lookup: { [key]: issue(12, "Issue 12", ["swf:question"]) } });
    const compute = fakeCompute(listed);
    const { vm, calls } = fakeVm();
    const { poller } = createPoller({ github, compute, vm });

    await poller.cycle();
    const refresh = `hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`;
    expect(calls).toEqual([refresh]);
    listed[0].status = "TERMINATED";
    await poller.cycle();
    expect(calls).toEqual([refresh]);
    listed[0].status = "RUNNING";
    await poller.cycle();
    expect(calls).toEqual([refresh, refresh]);
  });

  it("logs a VM that takes no token once and still follows the others", async () => {
    const github = fakeGitHub({}, { lookup: { [key]: issue(12, "Issue 12", ["swf:running"]) } });
    const compute = fakeCompute([sessionVmOf("running")]);
    const { vm, calls } = fakeVm({ command: "github-token", error: new Error(`failed to run hunt-ctl github-token on ${VM}: exit status 2\nusage: hunt-ctl …`) });
    const { poller, logs } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.cycle();
    expect(calls).toHaveLength(2);
    expect(logs.filter((line) => line.includes("exit status 2"))).toEqual([`${key}: failed to run hunt-ctl github-token on ${VM}: exit status 2\nusage: hunt-ctl …`]);
    expect(github.calls.filter((call) => call.startsWith("issue "))).toEqual([]);
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
    expect(calls).toEqual([`hunt-ctl github-token ${SESSION_ID} <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`, `hunt-ctl status ${SESSION_ID}`]);
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

describe("secretsReader", () => {
  const metadata: Metadata = { project: async () => "medconomy-hunt", zone: async () => "europe-west3-a", accessToken: async () => "ya29.x", attribute: async () => null };
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  /** A Secret Manager answering the three secrets with `values`, counting the reads. */
  function fakeSecrets(values: Record<string, string>) {
    let reads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      reads++;
      const name = /secrets\/([A-Z_]+)\/versions/.exec(String(input))?.[1] ?? "";
      return Response.json({ payload: { data: Buffer.from(values[name] ?? "").toString("base64") } });
    }) as typeof fetch;
    return { fetchImpl, reads: () => reads };
  }

  it("reads the app's id and key and the Claude token, and reads them again after their ttl", async () => {
    let now = 0;
    const { fetchImpl, reads } = fakeSecrets({ HUNT_SWF_GITHUB_APP_ID: "4711\n", HUNT_SWF_GITHUB_APP_KEY: pem, HUNT_SWF_CLAUDE_TOKEN: CLAUDE_TOKEN });
    const read = secretsReader(metadata, fetchImpl, () => now);
    const secrets = await read();
    expect(secrets.claude).toBe(CLAUDE_TOKEN);
    expect(secrets.app.appId).toBe("4711");
    expect(secrets.app.privateKey.asymmetricKeyType).toBe("rsa");
    now = 9 * 60_000;
    expect(await read()).toBe(secrets);
    expect(reads()).toBe(3);
    now = 11 * 60_000;
    expect(await read()).not.toBe(secrets);
    expect(reads()).toBe(6);
  });

  it("rejects an id that is no number and a key that is no private key, without quoting either", async () => {
    const badId = secretsReader(metadata, fakeSecrets({ HUNT_SWF_GITHUB_APP_ID: "Iv1.abc", HUNT_SWF_GITHUB_APP_KEY: pem, HUNT_SWF_CLAUDE_TOKEN: CLAUDE_TOKEN }).fetchImpl);
    await expect(badId()).rejects.toThrow("failed to read the secret HUNT_SWF_GITHUB_APP_ID: its latest version is no GitHub App id");
    const badKey = secretsReader(metadata, fakeSecrets({ HUNT_SWF_GITHUB_APP_ID: "4711", HUNT_SWF_GITHUB_APP_KEY: "not a key", HUNT_SWF_CLAUDE_TOKEN: CLAUDE_TOKEN }).fetchImpl);
    await expect(badKey()).rejects.toThrow(/^failed to read the secret HUNT_SWF_GITHUB_APP_KEY: its latest version is no private key: (?!.*not a key)/);
  });
});
