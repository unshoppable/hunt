import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "./files.ts";
import { createLineDecoder, parseLine } from "../../../../libs/domain/src/ndjson.ts";

const HELPER = fileURLToPath(new URL("./statusHelper.ts", import.meta.url));
/** Longer than one poll of the helper. */
const WAIT_MS = 3_000;

type Message = Record<string, unknown>;

interface HelperProcess {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the next message the helper sent. */
  next(): Promise<Message>;
  exited: Promise<number | null>;
}

function startHelper(statusPath: string): HelperProcess {
  const child = spawn(process.execPath, [HELPER, statusPath]);
  const received: Message[] = [];
  let onMessage = () => {};
  const lines = createLineDecoder((line) => {
    received.push(parseLine(line) as Message);
    onMessage();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => lines.push(chunk));
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return {
    child,
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; helper output:\n${output}`)), WAIT_MS);
        onMessage = () => {
          const message = received.shift();
          if (!message) return;
          clearTimeout(timer);
          onMessage = () => {};
          resolve(message);
        };
        onMessage();
      }),
    exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))),
  };
}

function writeStatus(path: string, changes: Message): void {
  const status = { heartbeatAt: Date.now(), state: "ready", error: null, acpSessionId: "acp-1", turn: "idle", clientConnected: true };
  writeJsonAtomic(path, { ...status, lastClientActivityAt: null, lastTurnEndedAt: 1_000, pendingPermissionSince: null, question: true, ...changes });
}

describe("statusHelper", () => {
  let helper: HelperProcess | null = null;
  let dir = "";

  afterEach(() => {
    helper?.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the relay's status when it changes, no turn once the file is gone, and exits when stdin ends", async () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-status-"));
    const statusPath = join(dir, "status.json");
    writeStatus(statusPath, {});
    helper = startHelper(statusPath);

    expect(await helper.next()).toEqual({ t: "ready" });
    expect(await helper.next()).toEqual({ t: "status", turn: "idle", question: true, lastTurnEndedAt: 1_000 });

    // A change the report does not show sends nothing.
    writeStatus(statusPath, { clientConnected: false });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    writeStatus(statusPath, { turn: "running", question: false });
    expect(await helper.next()).toEqual({ t: "status", turn: "running", question: false, lastTurnEndedAt: 1_000 });

    rmSync(statusPath);
    expect(await helper.next()).toEqual({ t: "status", turn: null, question: null, lastTurnEndedAt: null });

    helper.child.stdin.end();
    expect(await helper.exited).toBe(0);
  }, 15_000);
});
