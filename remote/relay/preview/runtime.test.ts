import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlan } from "./contract.ts";
import { sendControlRequest } from "./control.ts";
import { startPreviewRuntime, type PreviewRuntime } from "./runtime.ts";
import type { PreviewStatus } from "./supervisor.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const SERVER = fileURLToPath(new URL("../fixtures/previewServer.ts", import.meta.url));
const SESSION_ID = "7c0c6f2e-1234-4abc-8def-0123456789ab";
const DOMAIN = "preview.example.com";
const WAIT_MS = 10_000;
const run = promisify(execFile);

/** A directory for the socket; Unix socket paths are limited to 104 bytes on macOS, so a long TMPDIR is not used. */
function socketTempDir(): string {
  return mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hunt-preview-"));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function readStatus(stateDir: string): PreviewStatus | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "preview.json"), "utf8")) as PreviewStatus;
  } catch {
    return null;
  }
}

async function waitForStatus(stateDir: string, isDone: (status: PreviewStatus) => boolean): Promise<PreviewStatus> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const status = readStatus(stateDir);
    if (status && isDone(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for preview.json; it holds ${JSON.stringify(readStatus(stateDir))}`);
}

async function getJson(port: number, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return (await response.json()) as Record<string, unknown>;
}

function isListening(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
}

describe("startPreviewRuntime", () => {
  let dir = "";
  let runtime: PreviewRuntime | null = null;

  afterEach(async () => {
    runtime?.kill();
    await runtime?.shutdown();
    runtime = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a plan with bash in the worktree, serves the control socket and answers hunt-preview", async () => {
    dir = socketTempDir();
    const stateDir = join(dir, "preview");
    const worktree = join(dir, "worktree");
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    const port = await freePort();
    const env = { ...process.env, HUNT_SESSION_ID: SESSION_ID, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret", GH_TOKEN: "github_pat_secret" };
    runtime = startPreviewRuntime({ socketDir: dir, stateDir, worktree: () => worktree, env, log: () => {} });
    const socketPath = join(dir, "preview.sock");
    const plan = buildPlan(
      {
        preview: {
          env: { APP_URL: "${HUNT_PREVIEW_URL}/app" },
          prepare: [{ name: "marker", run: "echo prepared > marker.txt && echo step output" }],
          processes: {
            web: { run: `'${process.execPath}' '${SERVER}'`, cwd: "apps/web", port, ready: "/ready", main: true, env: { PORT: String(port) } },
            worker: { run: "echo worker up && sleep 60" },
          },
        },
      },
      { sessionId: SESSION_ID, domain: DOMAIN },
    );

    const applied = await sendControlRequest(socketPath, { op: "apply", plan, dataGeneration: "1" });
    expect(applied).toMatchObject({ ok: true, status: { generation: 1, state: "preparing" } });
    const ready = await waitForStatus(stateDir, (status) => status.state === "ready");

    expect(ready.processes.web).toMatchObject({ state: "ready", restarts: 0 });
    expect(readFileSync(join(worktree, "marker.txt"), "utf8")).toBe("prepared\n");
    const served = await getJson(port, "/env");
    expect(served.cwd).toBe(realpathSync(join(worktree, "apps", "web")));
    expect(served.env).toMatchObject({
      APP_URL: "https://7c0c6f2e.preview.example.com/app",
      HUNT_PREVIEW_URL: "https://7c0c6f2e.preview.example.com",
      [`HUNT_PREVIEW_URL_${port}`]: `https://7c0c6f2e-${port}.preview.example.com`,
      NO_COLOR: "1",
      NX_TUI: "false",
      PORT: String(port),
      HUNT_SESSION_ID: SESSION_ID,
    });
    expect(served.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(served.env).not.toHaveProperty("GH_TOKEN");

    const cliEnv = { ...process.env, HUNT_SOCKET_DIR: dir, HUNT_PREVIEW_STATE_DIR: stateDir };
    const status = await run(process.execPath, [CLI, "status"], { env: cliEnv });
    expect(status.stdout).toContain("preview: ready (generation 1)\nurl: https://7c0c6f2e.preview.example.com\n");
    expect(status.stdout).toMatch(new RegExp(`\\n  web     ready     pid ${ready.processes.web.pid}  https://7c0c6f2e\\.preview\\.example\\.com\\n`));
    expect(status.stdout).toMatch(/\n {2}worker {2}ready {5}pid \d+\n/);
    const setupLog = await run(process.execPath, [CLI, "logs", "setup"], { env: cliEnv });
    expect(setupLog.stdout).toMatch(/prepare step marker: echo prepared.*\nstep output\n.*prepare step marker exited with code 0\n$/s);
    expect((await run(process.execPath, [CLI, "logs", "worker", "--lines", "1"], { env: cliEnv })).stdout).toBe("worker up\n");
    await expect(run(process.execPath, [CLI, "restart", "db"], { env: cliEnv })).rejects.toMatchObject({
      code: 1,
      stderr: "hunt-preview: the preview has no process db; it has web, worker\n",
    });
    await expect(run(process.execPath, [CLI, "logs"], { env: cliEnv })).rejects.toMatchObject({ code: 2 });

    const restarted = await run(process.execPath, [CLI, "restart", "web"], { env: cliEnv });
    expect(restarted.stdout).toMatch(/\n {2}web {5}starting {2}pid \d+ {2}last exit 143 {2}https:/);
    const again = await waitForStatus(stateDir, (candidate) => candidate.state === "ready" && candidate.processes.web.pid !== ready.processes.web.pid);
    expect(again.processes.web.exitCode).toBe(143);

    expect(await sendControlRequest(socketPath, { op: "stop" })).toMatchObject({ ok: true, status: { state: "stopped" } });
    expect(await isListening(port)).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "applied.json"), "utf8"))).toMatchObject({ generation: 1, running: false, dataGeneration: "1" });
    expect(existsSync(join(stateDir, "logs", "web.log"))).toBe(true);
  }, 30_000);
});
