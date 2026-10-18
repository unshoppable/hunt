/**
 * The transcript helper of the built session artifact (`session/transcriptHelper.mjs`, `nx build session`) on a Claude
 * Code project folder in a Debian 12 container with Node 24, the base of the session VMs; skipped without a Docker
 * daemon. The helper runs as `agent` with `docker exec --interactive`, as the client runs it over SSH, and the tests
 * change the folder as `agent` while they read the helper's NDJSON from its stdout.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../../dist/apps/session", import.meta.url));
const DOCKER_TIMEOUT_MS = 600_000;
const MESSAGE_TIMEOUT_MS = 5_000;
/** How long the tests wait to be sure that no further message comes. */
const QUIET_MS = 600;
const PROJECT = "/home/agent/.claude/projects/-home-agent-app";

const DOCKERFILE = `FROM node:24-bookworm-slim
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /opt/hunt/node/bin && ln -s /usr/local/bin/node /opt/hunt/node/bin/node
`;
const IMAGE = `hunt-transcript-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

const LINE_1 = '{"type":"user","cwd":"/home/agent/app"}\n';
const LINE_2 = '{"type":"assistant","text":"hi"}\n';

/** A project folder with one transcript of two lines, a tool result and a memory file. */
const SEED = String.raw`
set -euo pipefail
rm -rf "$1"
mkdir -p "$1/abc/tool-results" "$1/memory"
cd "$1"
printf '%s' "$2" >abc.jsonl
printf 'result\n' >abc/tool-results/1.txt
printf '# memory\n' >memory/MEMORY.md
`;

type Message =
  | { t: "ready" }
  | { t: "file"; path: string; offset: number; data: string; size: number }
  | { t: "reset"; path: string }
  | { t: "gone"; path: string }
  | { t: "ack"; id: number; size?: number; error?: string }
  | { t: "error"; message: string };

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

/** The helper's process and the messages it sent that no test took yet. */
class HelperProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly messages: Message[] = [];
  private notify: (() => void) | null = null;
  stderr = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        this.messages.push(JSON.parse(pending.slice(0, newline)) as Message);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      this.notify?.();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Takes messages until `isDone` holds for the taken ones; fails after MESSAGE_TIMEOUT_MS. */
  async takeUntil(isDone: (taken: Message[]) => boolean): Promise<Message[]> {
    const taken: Message[] = [];
    const deadline = Date.now() + MESSAGE_TIMEOUT_MS;
    for (;;) {
      taken.push(...this.messages.splice(0));
      if (isDone(taken)) return taken;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out; got ${JSON.stringify(taken)}; stderr: ${this.stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.notify = null;
    }
  }

  /** Takes every message that arrives within QUIET_MS. */
  async takeQuiet(): Promise<Message[]> {
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    return this.messages.splice(0);
  }
}

/** Whether `messages` hold a `file` message of every one of `paths`. */
function filesOf(...paths: string[]): (messages: Message[]) => boolean {
  return (messages) => paths.every((path) => messages.some((message) => message.t === "file" && message.path === path));
}

describe.skipIf(!hasDocker())("the transcript helper in a Debian container", () => {
  const container = `hunt-transcript-helper-${randomUUID().slice(0, 8)}`;
  let helper: HelperProcess;

  /** Runs `script` with bash in the project folder as `agent`; `args` become $1… */
  function asAgent(script: string, args: string[] = []) {
    const result = docker(["exec", "-u", "agent", "-w", PROJECT, container, "bash", "-c", `set -euo pipefail\n${script}`, "bash", ...args]);
    expect(result.stderr, script).toBe("");
    expect(result.status, script).toBe(0);
    return result.stdout;
  }

  beforeAll(() => {
    if (docker(["image", "inspect", IMAGE]).status !== 0) {
      const built = docker(["build", "--quiet", "--tag", IMAGE, "-"], DOCKERFILE);
      expect(built.stderr + built.stdout).not.toMatch(/ERROR/);
      expect(built.status).toBe(0);
    }
    const started = docker(["run", "--detach", "--rm", "--name", container, "--volume", `${BUNDLE}:/bundle:ro`, IMAGE, "sleep", "infinity"]);
    expect(started.stderr).toBe("");
    expect(docker(["exec", container, "bash", "-c", "mkdir -p /srv/hunt && cp -R /bundle /srv/hunt/current"])).toMatchObject({ status: 0, stderr: "" });
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  beforeEach(async () => {
    expect(docker(["exec", "-u", "agent", container, "bash", "-c", SEED, "bash", PROJECT, LINE_1 + LINE_2])).toMatchObject({ status: 0, stderr: "" });
    const child = spawn("docker", [
      "exec",
      "--interactive",
      "-u",
      "agent",
      container,
      "/opt/hunt/node/bin/node",
      "/srv/hunt/current/session/transcriptHelper.mjs",
      PROJECT,
    ]);
    helper = new HelperProcess(child);
    expect(await helper.takeUntil((messages) => messages.length > 0)).toEqual([{ t: "ready" }]);
  }, 30_000);

  afterEach(async () => {
    const exited = new Promise((resolve) => helper.child.once("exit", resolve));
    helper.child.stdin.end();
    await exited;
    expect(helper.stderr).toBe("");
  });

  it("reports what the client lacks after its sync, then every appended line, and never the memory", async () => {
    asAgent("printf 'early\\n' >>abc/tool-results/1.txt");
    expect(await helper.takeQuiet()).toEqual([]);

    helper.send({ t: "sync", files: { "abc.jsonl": LINE_1.length, "old.jsonl": 10 }, owned: [] });
    const messages = await helper.takeUntil((taken) => taken.some((message) => message.t === "gone"));
    expect(messages).toContainEqual({ t: "file", path: "abc.jsonl", offset: LINE_1.length, data: base64(LINE_2), size: LINE_1.length + LINE_2.length });
    expect(messages).toContainEqual({ t: "file", path: "abc/tool-results/1.txt", offset: 0, data: base64("result\nearly\n"), size: 13 });
    expect(messages).toContainEqual({ t: "gone", path: "old.jsonl" });
    expect(messages.some((message) => message.t === "file" && message.path.startsWith("memory"))).toBe(false);

    const line3 = '{"type":"user","text":"more"}\n';
    asAgent("printf '%s' \"$1\" >>abc.jsonl && printf 'noted\\n' >>memory/MEMORY.md", [line3]);
    const size = LINE_1.length + LINE_2.length + line3.length;
    expect(await helper.takeUntil(filesOf("abc.jsonl"))).toEqual([{ t: "file", path: "abc.jsonl", offset: LINE_1.length + LINE_2.length, data: base64(line3), size }]);
    expect(await helper.takeQuiet()).toEqual([]);
  });

  it("resets a file that shrank or was replaced and reports it from the start", async () => {
    helper.send({ t: "sync", files: { "abc.jsonl": LINE_1.length + LINE_2.length, "abc/tool-results/1.txt": 7 }, owned: [] });
    expect(await helper.takeQuiet()).toEqual([]);

    asAgent("printf '%s' \"$1\" >abc.jsonl", [LINE_1]);
    expect(await helper.takeUntil(filesOf("abc.jsonl"))).toEqual([
      { t: "reset", path: "abc.jsonl" },
      { t: "file", path: "abc.jsonl", offset: 0, data: base64(LINE_1), size: LINE_1.length },
    ]);

    helper.send({ t: "read", path: "abc/tool-results/1.txt", offset: 0 });
    expect(await helper.takeUntil(filesOf("abc/tool-results/1.txt"))).toEqual([{ t: "file", path: "abc/tool-results/1.txt", offset: 0, data: base64("result\n"), size: 7 }]);

    asAgent("rm abc.jsonl");
    expect(await helper.takeUntil((taken) => taken.some((message) => message.t === "gone"))).toEqual([{ t: "gone", path: "abc.jsonl" }]);
  });

  it("appends the client's writes to the files it owns, refuses one at the wrong offset and never reports them", async () => {
    helper.send({ t: "sync", files: { "abc.jsonl": LINE_1.length + LINE_2.length, "abc/tool-results/1.txt": 7 }, owned: ["sub.jsonl"] });
    expect(await helper.takeQuiet()).toEqual([]);

    helper.send({ t: "write", id: 1, path: "sub.jsonl", offset: 0, data: base64(LINE_1), truncate: true });
    helper.send({ t: "write", id: 2, path: "sub.jsonl", offset: LINE_1.length, data: base64(LINE_2), truncate: false });
    helper.send({ t: "write", id: 3, path: "sub.jsonl", offset: 5, data: base64("x\n"), truncate: false });
    helper.send({ t: "write", id: 4, path: "sub/tool-results/2.txt", offset: 0, data: base64("made here\n"), truncate: true });
    const acks = await helper.takeUntil((taken) => taken.filter((message) => message.t === "ack").length === 4);
    expect(acks).toEqual([
      { t: "ack", id: 1, size: LINE_1.length },
      { t: "ack", id: 2, size: LINE_1.length + LINE_2.length },
      { t: "ack", id: 3, error: `sub.jsonl is ${LINE_1.length + LINE_2.length} bytes long, not 5` },
      { t: "ack", id: 4, size: 10 },
    ]);
    expect(asAgent("cat sub.jsonl && stat -c '%a' sub.jsonl && cat sub/tool-results/2.txt")).toBe(`${LINE_1}${LINE_2}600\nmade here\n`);
    expect(await helper.takeQuiet()).toEqual([]);

    // A file the agent writes is still reported, next to the owned ones.
    asAgent("printf 'x\\n' >>abc/tool-results/1.txt");
    expect(await helper.takeUntil(filesOf("abc/tool-results/1.txt"))).toEqual([{ t: "file", path: "abc/tool-results/1.txt", offset: 7, data: base64("x\n"), size: 9 }]);
  });
});
