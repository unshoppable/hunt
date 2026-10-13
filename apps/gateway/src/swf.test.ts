import { describe, expect, it } from "vitest";
import type { Transport } from "./acpClient.ts";
import type { Compute, Instance, InstanceRequest, MetadataItem } from "./gcp.ts";
import type { GitHub, Issue } from "./github.ts";
import type { SessionVm } from "./sessionVm.ts";
import { Poller, type PollerDeps } from "./swf.ts";
import type { SwfConfig } from "./swfConfig.ts";

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const CLAUDE_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";
const CONFIG: SwfConfig = { repos: ["acme/app"], maxSessions: 2, label: "swf", template: "tpl-hunt-session", machineType: null };
const SESSION_ID = "ab12cd34-0000-4000-8000-000000000001";
const VM = "vm-hunt-s-ab12cd34";

function issue(number: number, title = `Issue ${number}`): Issue {
  return { number, title, body: `Body of ${number}`, author: "alice", createdAt: "2026-10-13T08:00:00Z", url: `https://github.com/acme/app/issues/${number}` };
}

/** A GitHub whose issues are `issues` by repository; every call is recorded as one line. */
function fakeGitHub(issues: Record<string, Issue[]>, options: { labelGone?: number[] } = {}): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openIssues: async (repo, label) => {
      calls.push(`issues ${repo} ${label}`);
      return issues[repo] ?? [];
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

/** A Compute whose VMs come from `listed`; inserted VMs appear as PROVISIONING, then RUNNING. */
function fakeCompute(listed: Instance[] = [], insertError?: Error): Compute & { calls: string[]; inserted: InstanceRequest[]; metadata: MetadataItem[][] } {
  const calls: string[] = [];
  const inserted: InstanceRequest[] = [];
  const metadata: MetadataItem[][] = [];
  const gets = new Map<string, number>();
  return {
    calls,
    inserted,
    metadata,
    listByLabel: async (key, value) => {
      calls.push(`list ${key}=${value}`);
      return listed;
    },
    get: async (name) => {
      const count = (gets.get(name) ?? 0) + 1;
      gets.set(name, count);
      const status = count < 3 ? "PROVISIONING" : "RUNNING";
      return { name, status, labels: {}, metadata: { fingerprint: `fp${count}`, items: [{ key: "startup-script", value: "#!/bin/sh" }] } };
    },
    insert: async (request) => {
      calls.push(`insert ${request.name}`);
      if (insertError) throw insertError;
      inserted.push(request);
    },
    setMetadata: async (name, fingerprint, items) => {
      calls.push(`metadata ${name} ${fingerprint}`);
      metadata.push(items);
    },
  };
}

/** A session VM that records every hunt-ctl call with its stdin and fails the one named in `failing`. */
function fakeVm(failing?: { command: string; error: Error }) {
  const calls: string[] = [];
  const claudeFiles: Record<string, string>[] = [];
  const vm: SessionVm = {
    run: async () => "",
    huntCtl: async (args, input = "") => {
      calls.push(`hunt-ctl ${args.join(" ")}${input ? ` <<< ${JSON.stringify(String(input))}` : ""}`);
      if (failing?.command === args[0]) throw failing.error;
      switch (args[0]) {
        case "clone":
          return { path: "/home/agent/app" };
        case "session-config":
          return { hunt_md: "# Preview\nStart the UIs." };
        case "wait":
          return { state: "ready", acpSessionId: "acp-9" };
        default:
          return {};
      }
    },
    waitUntilReady: async () => {
      calls.push("wait until ready");
    },
    installBundle: async () => {
      calls.push("install bundle");
    },
    putClaudeFiles: async (id, files) => {
      calls.push(`put-files ${id} --claude ${Object.keys(files).join(",")}`);
      claudeFiles.push(files);
    },
    openRelay: () => ({}) as Transport,
  };
  return { vm, calls, claudeFiles };
}

type Overrides = Omit<Partial<PollerDeps>, "github" | "vm"> & { github?: GitHub; vm?: SessionVm };

function createPoller({ github = fakeGitHub({}), vm = fakeVm().vm, ...overrides }: Overrides = {}) {
  const logs: string[] = [];
  const prompts: { sessionId: string; cwd: string; text: string }[] = [];
  let tokenReads = 0;
  const deps: PollerDeps = {
    readConfig: () => CONFIG,
    readDomain: () => "hunt.example.com",
    tokens: async () => {
      tokenReads++;
      return { github: GITHUB_TOKEN, claude: CLAUDE_TOKEN };
    },
    compute: fakeCompute(),
    prompts: () => ({ remote: "## Remote session\n", gitPush: "### Git\n" }),
    sendPrompt: async (_transport, request) => {
      prompts.push(request);
      return "started";
    },
    newId: () => SESSION_ID,
    sleep: async () => {},
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
    const { poller, logs, tokenReads } = createPoller({ readConfig: () => null, compute });
    await poller.cycle();
    await poller.cycle();
    expect(logs).toEqual(["idle: /etc/hunt/swf.json lists no repositories"]);
    expect(tokenReads()).toBe(0);
    expect(compute.calls).toEqual([]);

    const invalid = createPoller({
      readConfig: () => {
        throw new Error("failed to read /etc/hunt/swf.json: maxSessions: must be a whole number from 0 to 10");
      },
    });
    await invalid.poller.cycle();
    expect(invalid.logs).toEqual(["idle: failed to read /etc/hunt/swf.json: maxSessions: must be a whole number from 0 to 10"]);
  });

  it("starts sessions only while fewer than maxSessions VMs are up, oldest issue first", async () => {
    const listed = [
      { name: "vm-hunt-s-00000001", status: "RUNNING", labels: { "hunt-origin": "swf" }, metadata: { fingerprint: "", items: [] } },
      { name: "vm-hunt-s-00000002", status: "TERMINATED", labels: { "hunt-origin": "swf" }, metadata: { fingerprint: "", items: [] } },
    ];
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
    const github = fakeGitHub({ "acme/app": [issue(12, "Fix login")] });
    const compute = fakeCompute();
    const { vm, calls, claudeFiles } = fakeVm();
    const { poller, logs, prompts } = createPoller({ github, compute, vm });

    await poller.cycle();
    await poller.drain();

    expect(github.calls).toEqual([
      "issues acme/app swf",
      "ensure acme/app swf:running",
      "ensure acme/app swf:done",
      "ensure acme/app swf:failed",
      "comments acme/app#12",
      "unlabel acme/app#12 swf",
      "label acme/app#12 swf:running",
      `comment acme/app#12 Hunt started a session for this issue: preview \`https://ab12cd34.hunt.example.com\` (available once the agent starts the app).\n\nSession \`${SESSION_ID}\` on the VM \`${VM}\`, branch \`hunt/12-fix-login\`.`,
    ]);
    expect(compute.inserted).toEqual([
      { name: VM, template: "tpl-hunt-session", machineType: null, labels: { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" } },
    ]);
    expect(compute.metadata).toEqual([
      [
        { key: "startup-script", value: "#!/bin/sh" },
        { key: "hunt-session-id", value: SESSION_ID },
        { key: "hunt-repo", value: "acme/app" },
        { key: "hunt-branch", value: "hunt/12-fix-login" },
        { key: "hunt-title", value: "Fix login" },
        { key: "hunt-issue", value: "12" },
      ],
    ]);
    expect(calls).toEqual([
      "wait until ready",
      "install bundle",
      `hunt-ctl clone ${SESSION_ID} --repo acme/app --branch hunt/12-fix-login <<< ${JSON.stringify(`${GITHUB_TOKEN}\n`)}`,
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
      systemPromptAppend: "\n\n## Remote session\n\n### Git\n\n### The repository's HUNT.md\n# Preview\nStart the UIs.\n",
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
    const { poller } = createPoller({ github, compute, vm, readConfig: () => ({ ...CONFIG, maxSessions: 1 }), newId: () => `0000000${++ids}-0000-4000-8000-000000000000` });

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
