/**
 * Runs the relay (`main.ts`) as a process with the fake adapter (`fakeAdapter.ts`) for integration tests: the relay's
 * own test and the clients that talk to it, such as hunt-swf's ACP client.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLine } from "../ndjson.ts";

export const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
export const FAKE_ADAPTER = fileURLToPath(new URL("./fakeAdapter.ts", import.meta.url));
export const WAIT_MS = 10_000;

type Message = Record<string, unknown>;

/** A directory for the socket; Unix socket paths are limited to 104 bytes on macOS, so a long TMPDIR is not used. */
export function socketTempDir(): string {
  return mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hunt-relay-"));
}

function readFileSyncOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Polls the relay's status file until `isDone` accepts it. */
export async function waitForStatus(path: string, isDone: (status: Message) => boolean, output: () => string): Promise<Message> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const status = parseLine(readFileSyncOrEmpty(path));
    if (status && isDone(status as Message)) return status as Message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}; relay output:\n${output()}`);
}

export interface RelayProcess {
  child: ChildProcess;
  dir: string;
  socketPath: string;
  statusPath: string;
  /** The messages the fake adapter received, oldest first. */
  adapterMessages(): Message[];
  output(): string;
  /** Kills the relay and removes its directory. */
  dispose(): void;
}

/** Starts the relay with `hunt-session.json` holding `config` (plus `cwd`) and waits until it is ready. */
export async function startRelay(config: Message): Promise<RelayProcess> {
  const dir = socketTempDir();
  const configPath = join(dir, "hunt-session.json");
  const adapterLog = join(dir, "adapter.log");
  writeFileSync(configPath, JSON.stringify({ cwd: dir, ...config }));
  const env = { ...process.env, HOME: dir, HUNT_ADAPTER: FAKE_ADAPTER, HUNT_CONFIG: configPath, HUNT_SOCKET_DIR: dir, FAKE_ADAPTER_LOG: adapterLog };
  const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const relay: RelayProcess = {
    child,
    dir,
    socketPath: join(dir, "relay.sock"),
    statusPath: join(dir, "status.json"),
    adapterMessages: () =>
      readFileSyncOrEmpty(adapterLog)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Message),
    output: () => output,
    dispose: () => {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await waitForStatus(relay.statusPath, (status) => status.state === "ready", relay.output);
  return relay;
}
