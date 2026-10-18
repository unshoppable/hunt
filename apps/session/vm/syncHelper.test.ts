/**
 * The live file-sync helper of the built session artifact (`session/syncHelper.mjs`, `nx build session`) on a Git
 * worktree in a Debian 12 container with Node 24 and Git, the base of the session VMs; skipped without a Docker daemon.
 * The helper runs as `agent` with `docker exec --interactive`, as the client runs it over SSH, and the tests change the
 * worktree as `agent` while they read the helper's NDJSON from its stdout.
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
const WORKTREE = "/home/agent/app";

const DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash ca-certificates git \\
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /opt/hunt/node/bin && ln -s /usr/local/bin/node /opt/hunt/node/bin/node
`;
const IMAGE = `hunt-sync-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

/** A fresh worktree with one commit: tracked files in two folders, an ignored folder and an ignored file. */
const SEED = String.raw`
set -euo pipefail
rm -rf "$1"
mkdir -p "$1/src/deep" "$1/node_modules/pkg" "$1/empty"
cd "$1"
git init --quiet --initial-branch=main
git config user.name Agent
git config user.email agent@example.com
printf '*.log\nnode_modules/\n' >.gitignore
printf 'readme\n' >README.md
printf 'a\n' >src/a.txt
printf 'c\n' >src/deep/c.txt
printf 'x\n' >node_modules/pkg/index.js
printf 'old\n' >old.log
git add .gitignore README.md src
git commit --quiet -m init
`;

interface State {
  size: number;
  modifiedNs: string;
  executable: boolean;
  link: boolean;
}

interface Report {
  path: string;
  state: State | null;
  listed: boolean;
  data?: string;
  target?: string;
}

type Message =
  | { t: "ready" }
  | { t: "changes"; files: Report[] }
  | { t: "ack"; id: number; files: { path: string; state: State | null }[] }
  | { t: "head" }
  | { t: "resync"; reason: string }
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

/** The reports of every `changes` message among `messages`, by path; a later report of a path wins. */
function reportsOf(messages: Message[]): Map<string, Report> {
  const reports = new Map<string, Report>();
  for (const message of messages) {
    if (message.t !== "changes") continue;
    for (const file of message.files) {
      reports.set(file.path, file);
    }
  }
  return reports;
}

/** Whether `messages` report every one of `paths`. */
function reportsAll(...paths: string[]): (messages: Message[]) => boolean {
  return (messages) => {
    const reports = reportsOf(messages);
    return paths.every((path) => reports.has(path));
  };
}

describe.skipIf(!hasDocker())("the sync helper in a Debian container", () => {
  const container = `hunt-sync-helper-${randomUUID().slice(0, 8)}`;
  let helper: HelperProcess;

  /** Runs `script` with bash in the worktree as `agent`; `args` become $1… */
  function asAgent(script: string, args: string[] = []) {
    const result = docker(["exec", "-u", "agent", "-w", WORKTREE, container, "bash", "-c", `set -euo pipefail\n${script}`, "bash", ...args]);
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
    expect(docker(["exec", "-u", "agent", container, "bash", "-c", SEED, "bash", WORKTREE])).toMatchObject({ status: 0, stderr: "" });
    const child = spawn("docker", [
      "exec",
      "--interactive",
      "-u",
      "agent",
      container,
      "/opt/hunt/node/bin/node",
      "/srv/hunt/current/session/syncHelper.mjs",
      WORKTREE,
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

  it("reports a changed file with its content and lstat state", async () => {
    asAgent("printf 'changed\\n' >src/deep/c.txt && chmod +x src/deep/c.txt");
    const reports = reportsOf(await helper.takeUntil(reportsAll("src/deep/c.txt")));
    const stat = asAgent("stat -c '%s %Y' src/deep/c.txt").trim().split(" ");

    const report = reports.get("src/deep/c.txt")!;
    expect(report).toMatchObject({ listed: true, data: base64("changed\n"), state: { size: 8, executable: true, link: false } });
    expect(report.state!.modifiedNs).toMatch(/^\d{19}$/);
    expect(report.state!.modifiedNs.slice(0, 10)).toBe(stat[1]);

    asAgent("ln -s ../README.md src/link");
    expect(reportsOf(await helper.takeUntil(reportsAll("src/link"))).get("src/link")).toMatchObject({
      listed: true,
      target: "../README.md",
      state: { size: 12, link: true },
    });
  });

  it("reports an ignored file as not listed and without content, and its folder not at all", async () => {
    asAgent("printf 'log\\n' >new.log && printf 'y\\n' >node_modules/pkg/other.js && printf 'r\\n' >empty/kept.txt");
    const reports = reportsOf(await helper.takeUntil(reportsAll("new.log", "empty/kept.txt")));

    expect(reports.get("new.log")).toEqual({ path: "new.log", listed: false, state: expect.objectContaining({ size: 4 }) });
    // A folder without listed files is watched as well.
    expect(reports.get("empty/kept.txt")).toMatchObject({ listed: true, data: base64("r\n") });
    expect([...reports.keys()].some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(reportsOf(await helper.takeQuiet()).size).toBe(0);
  });

  it("reports the files of a new folder and every file of a deleted folder as gone", async () => {
    asAgent("mkdir -p lib/one/two && printf '1\\n' >lib/one/a.txt && printf '2\\n' >lib/one/two/b.txt");
    const added = reportsOf(await helper.takeUntil(reportsAll("lib/one/a.txt", "lib/one/two/b.txt")));
    expect(added.get("lib/one/two/b.txt")).toMatchObject({ listed: true, data: base64("2\n") });

    // A file created later in the new folder's subfolder is seen too.
    asAgent("printf '3\\n' >lib/one/two/c.txt");
    expect(reportsOf(await helper.takeUntil(reportsAll("lib/one/two/c.txt"))).get("lib/one/two/c.txt")).toMatchObject({ data: base64("3\n") });

    asAgent("rm -rf lib src");
    const gone = reportsOf(await helper.takeUntil(reportsAll("lib/one/a.txt", "lib/one/two/b.txt", "lib/one/two/c.txt", "src/a.txt", "src/deep/c.txt")));
    for (const path of ["lib/one/a.txt", "lib/one/two/b.txt", "lib/one/two/c.txt", "src/a.txt", "src/deep/c.txt"]) {
      expect(gone.get(path), path).toEqual({ path, state: null, listed: true });
    }

    // A folder that comes back under the same name is watched again.
    asAgent("mkdir src && printf 'again\\n' >src/a.txt");
    expect(reportsOf(await helper.takeUntil(reportsAll("src/a.txt"))).get("src/a.txt")).toMatchObject({ listed: true, data: base64("again\n") });
  });

  it("applies writes, links and deletes, acknowledges their states and does not echo them", async () => {
    helper.send({
      t: "apply",
      id: 1,
      writes: [
        { path: "new/dir/run.sh", data: base64("#!/bin/sh\n"), executable: true, modifiedNs: "1700000000123456789" },
        { path: "src/a.txt", data: base64("from the client\n"), executable: false, modifiedNs: "1700000001000000000" },
        { path: "src", data: "", executable: false, modifiedNs: "1" },
        { path: ".git/config", data: "", executable: false, modifiedNs: "1" },
      ],
      links: [{ path: "README.md", target: "src/a.txt", modifiedNs: "1700000002000000000" }],
      deletes: ["src/deep/c.txt", "missing.txt"],
    });
    const messages = await helper.takeUntil((taken) => taken.some((message) => message.t === "ack"));
    expect(messages.filter((message) => message.t === "error")).toEqual([
      { t: "error", message: 'request 1: skipped writes[3]: path ".git/config" lies inside .git' },
      { t: "error", message: "failed to write src: a folder is in the way" },
    ]);
    const ack = messages.find((message) => message.t === "ack")!;
    expect(ack).toEqual({
      t: "ack",
      id: 1,
      files: [
        { path: "new/dir/run.sh", state: { size: 10, modifiedNs: expect.stringMatching(/^1700000000123456\d{3}$/), executable: true, link: false } },
        { path: "src/a.txt", state: { size: 16, modifiedNs: "1700000001000000000", executable: false, link: false } },
        { path: "src", state: null },
        { path: "README.md", state: { size: 9, modifiedNs: "1700000002000000000", executable: true, link: true } },
        { path: "src/deep/c.txt", state: null },
        { path: "missing.txt", state: null },
      ],
    });
    expect(asAgent("stat -c '%a' new/dir/run.sh && cat src/a.txt && readlink README.md && ls -A src && ls -A new/dir")).toBe(
      "755\nfrom the client\nsrc/a.txt\na.txt\nrun.sh\n",
    );
    expect(await helper.takeQuiet()).toEqual([]);

    // A later change by the agent is reported again, and deleting the last file removes the emptied folders.
    asAgent("printf 'agent\\n' >src/a.txt");
    expect(reportsOf(await helper.takeUntil(reportsAll("src/a.txt"))).get("src/a.txt")).toMatchObject({ data: base64("agent\n") });
    helper.send({ t: "apply", id: 2, deletes: ["new/dir/run.sh"] });
    expect(await helper.takeUntil((taken) => taken.length > 0)).toEqual([{ t: "ack", id: 2, files: [{ path: "new/dir/run.sh", state: null }] }]);
    expect(asAgent("ls -A")).not.toContain("new");
    expect(await helper.takeQuiet()).toEqual([]);
  });

  it("asks for a full sync after a .gitignore change and then follows the new rules", async () => {
    asAgent("printf '*.tmp\\n' >>.gitignore");
    const messages = await helper.takeUntil((taken) => taken.some((message) => message.t === "resync"));
    expect(messages).toContainEqual({ t: "resync", reason: ".gitignore changed" });

    asAgent("printf 't\\n' >src/x.tmp && printf 'l\\n' >src/x.log2");
    const reports = reportsOf(await helper.takeUntil(reportsAll("src/x.tmp", "src/x.log2")));
    expect(reports.get("src/x.tmp")).toMatchObject({ listed: false });
    expect(reports.get("src/x.tmp")).not.toHaveProperty("data");
    expect(reports.get("src/x.log2")).toMatchObject({ listed: true, data: base64("l\n") });

    asAgent("printf 'other\\n' >.git/info/exclude");
    expect(await helper.takeUntil((taken) => taken.some((message) => message.t === "resync"))).toContainEqual({
      t: "resync",
      reason: `${WORKTREE}/.git/info/exclude changed`,
    });
  });

  it("reports a move of HEAD after a commit and a checkout", async () => {
    asAgent("git commit --quiet --allow-empty -m second");
    expect(await helper.takeUntil((taken) => taken.some((message) => message.t === "head"))).toContainEqual({ t: "head" });
    expect(await helper.takeQuiet()).toEqual([]);

    asAgent("git checkout --quiet -b feat/general/x");
    expect(await helper.takeUntil((taken) => taken.some((message) => message.t === "head"))).toContainEqual({ t: "head" });
  });

  it("answers a malformed request with an error and keeps running", async () => {
    helper.send({ t: "write", path: "a" });
    helper.child.stdin.write("{\n");
    expect(await helper.takeUntil((taken) => taken.length >= 2)).toEqual([
      { t: "error", message: 'malformed request: unknown type "write"' },
      { t: "error", message: "malformed request: not JSON" },
    ]);
    helper.send({ t: "apply", id: 9 });
    expect(await helper.takeUntil((taken) => taken.length > 0)).toEqual([{ t: "ack", id: 9, files: [] }]);
  });
});
