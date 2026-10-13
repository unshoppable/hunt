import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signalGroup, spawnShell } from "./shell.ts";
import type { ChildHandle, LogSink } from "./supervisor.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
let dir = "";
/** Started children, whose process groups are killed after the test. */
const started: ChildHandle[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "hunt-shell-")));
});

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.pid !== null) {
      signalGroup(child.pid, "SIGKILL");
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A LogSink that keeps what is written to it. */
function memoryLog(): LogSink & { text(): string } {
  const chunks: Buffer[] = [];
  return {
    write: (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    },
    line: (text) => {
      chunks.push(Buffer.from(`${text}\n`));
    },
    close: () => {},
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function start(run: string, cwd = dir, env: Record<string, string> = ENV): { child: ChildHandle; output: ReturnType<typeof memoryLog> } {
  const output = memoryLog();
  const child = spawnShell({ run, cwd, env, output });
  started.push(child);
  return { child, output };
}

/** Polls `condition` until it holds; fails after `timeoutMs`. */
async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`the condition did not hold within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The processes of the process group `pgid`, as ps lists them. */
function groupMembers(pgid: number): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid);
}

describe("spawnShell", () => {
  it("runs a command line with &&, an assignment prefix and a pipe in the given directory and environment", async () => {
    const run = `GREETING=hello printenv GREETING && echo "$NAME in $(pwd)" && echo to-stderr >&2 && printf 'a\\nb\\n' | wc -l | tr -d ' '`;
    const { child, output } = start(run, dir, { ...ENV, NAME: "web" });

    expect(child.pid).toEqual(expect.any(Number));
    expect(await child.exited).toEqual({ code: 0, error: null });
    await waitUntil(() => output.text().split("\n").length > 4);
    expect(output.text().split("\n").filter(Boolean).sort()).toEqual(["2", "hello", "to-stderr", `web in ${dir}`].sort());
  });

  it("reports the exit code of the command", async () => {
    expect(await start("echo failing && exit 3").child.exited).toEqual({ code: 3, error: null });
  });

  it("reports 128 + the signal number for a process that a signal ended", async () => {
    const { child } = start("sleep 30");

    expect(signalGroup(child.pid!, "SIGTERM")).toBe(true);
    expect(await child.exited).toEqual({ code: 143, error: null });
  });

  it("starts nothing when the directory does not exist and names the directory", async () => {
    const missing = join(dir, "missing");
    const { child } = start("true", missing);

    expect(child.pid).toBeNull();
    expect(await child.exited).toEqual({ code: null, error: `the directory ${missing} does not exist` });
  });
});

describe("signalGroup", () => {
  it("reaches every process of the group, also the ones the command started in the background", async () => {
    const { child } = start("sleep 30 & sleep 30 & wait");
    const pgid = child.pid!;
    await waitUntil(() => groupMembers(pgid).length >= 3);

    expect(signalGroup(pgid, 0)).toBe(true);
    expect(signalGroup(pgid, "SIGTERM")).toBe(true);
    expect(await child.exited).toEqual({ code: 143, error: null });
    await waitUntil(() => !signalGroup(pgid, 0));
    expect(groupMembers(pgid)).toEqual([]);
  });

  it("refuses process group IDs that cannot be a preview's and reports a group that is gone", async () => {
    expect(signalGroup(0, 0)).toBe(false);
    expect(signalGroup(1, 0)).toBe(false);
    expect(signalGroup(-1, 0)).toBe(false);
    expect(signalGroup(2.5, 0)).toBe(false);

    const { child } = start("true");
    await child.exited;

    expect(signalGroup(child.pid!, 0)).toBe(false);
  });
});
