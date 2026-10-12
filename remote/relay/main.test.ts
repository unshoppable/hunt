import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { label, textOf, turnOf } from "./fixtures/messages.ts";
import { createLineDecoder, encodeLine, parseLine } from "./ndjson.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const FAKE_ADAPTER = fileURLToPath(new URL("./fixtures/fakeAdapter.ts", import.meta.url));
const WAIT_MS = 10_000;

type Message = Record<string, unknown>;

interface TestClient {
  send(message: Message): void;
  /** Resolves with the messages received since the last call, up to and including the first one `isLast` accepts. */
  readUntil(isLast: (message: Message) => boolean): Promise<Message[]>;
  closed: Promise<void>;
}

/** A directory for the socket; Unix socket paths are limited to 104 bytes on macOS, so a long TMPDIR is not used. */
function socketTempDir(): string {
  return mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hunt-relay-"));
}

function connectClient(path: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const received: Message[] = [];
    let onMessage = () => {};
    const lines = createLineDecoder((line) => {
      received.push(parseLine(line) as Message);
      onMessage();
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => lines.push(chunk));
    socket.once("error", reject);
    const closed = new Promise<void>((resolveClosed) => socket.once("close", () => resolveClosed()));
    socket.once("connect", () =>
      resolve({
        send: (message) => socket.write(encodeLine({ jsonrpc: "2.0", ...message })),
        readUntil: (isLast) =>
          new Promise((resolveRead, rejectRead) => {
            const timer = setTimeout(() => rejectRead(new Error(`timed out; received ${JSON.stringify(received)}`)), WAIT_MS);
            onMessage = () => {
              const index = received.findIndex(isLast);
              if (index === -1) return;
              clearTimeout(timer);
              onMessage = () => {};
              resolveRead(received.splice(0, index + 1));
            };
            onMessage();
          }),
        closed,
      }),
    );
  });
}

async function waitForStatus(path: string, isDone: (status: Message) => boolean, output: () => string): Promise<Message> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const status = parseLine(readFileSyncOrEmpty(path));
    if (status && isDone(status as Message)) return status as Message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}; relay output:\n${output()}`);
}

function readFileSyncOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("main", () => {
  let relay: ChildProcess | null = null;
  let dir = "";

  afterEach(() => {
    relay?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the adapter, serves clients on the socket with takeover and stops cleanly on SIGTERM", async () => {
    dir = socketTempDir();
    const configPath = join(dir, "hunt-session.json");
    const adapterLog = join(dir, "adapter.log");
    const config = { huntSessionId: "7c0c6f2e", acpSessionId: "acp-1", cwd: dir, systemPromptAppend: "Commit locally only.", configOptions: { model: "opus" } };
    writeFileSync(configPath, JSON.stringify(config));
    const env = { ...process.env, HOME: dir, HUNT_ADAPTER: FAKE_ADAPTER, HUNT_CONFIG: configPath, HUNT_SOCKET_DIR: dir, FAKE_ADAPTER_LOG: adapterLog };
    const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
    relay = child;
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    const status = await waitForStatus(join(dir, "status.json"), (candidate) => candidate.state === "ready", () => output);
    expect(status).toMatchObject({ acpSessionId: "acp-1", turn: "idle", clientConnected: false, error: null });

    const first = await connectClient(join(dir, "acp.sock"));
    first.send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { _meta: { terminal_output: true } } } });
    first.send({ id: 2, method: "session/load", params: { sessionId: "acp-1", cwd: "/elsewhere", mcpServers: [] } });
    const loaded = await first.readUntil((message) => turnOf(message) === "idle");
    expect(loaded.map(label)).toEqual(["response:1", "agent_message_chunk", "response:2", "available_commands_update", "turn:idle"]);
    expect(loaded[0].result).toMatchObject({ agentCapabilities: { sessionCapabilities: { resume: {} } } });
    expect(loaded[0].result).not.toMatchObject({ agentCapabilities: { sessionCapabilities: { fork: {} } } });

    first.send({ id: 3, method: "session/prompt", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "hi" }] } });
    const turn = await first.readUntil((message) => turnOf(message) === "idle");
    expect(turn.map(label)).toEqual(["turn:running", "agent_message_chunk", "response:3", "turn:idle"]);
    expect(textOf(turn[1])).toBe("echo: hi");

    first.send({ id: 4, method: "session/prompt", params: { sessionId: "acp-1", prompt: [{ type: "text", text: "ask" }] } });
    const asked = await first.readUntil((message) => message.method === "session/request_permission");
    expect(asked.map(label)).toEqual(["turn:running", "request:session/request_permission"]);

    const second = await connectClient(join(dir, "acp.sock"));
    await first.closed;
    second.send({ id: 1, method: "session/load", params: { sessionId: "acp-1", cwd: "/elsewhere", mcpServers: [] } });
    const replay = await second.readUntil((message) => message.method === "session/request_permission");
    expect(replay.map(label)).toEqual([
      "agent_message_chunk",
      "user_message_chunk",
      "agent_message_chunk",
      "user_message_chunk",
      "response:1",
      "available_commands_update",
      "turn:running",
      "request:session/request_permission",
    ]);
    const permission = replay[replay.length - 1];
    expect(permission.id).not.toBe("permission-1");

    second.send({ id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    const finished = await second.readUntil((message) => turnOf(message) === "idle");
    expect(finished.map(label)).toEqual(["agent_message_chunk", "turn:idle"]);
    expect(textOf(finished[0])).toBe("allowed: allow");

    second.send({ id: 2, method: "session/set_config_option", params: { sessionId: "acp-1", configId: "model", value: "default" } });
    await second.readUntil((message) => message.id === 2);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ ...config, configOptions: { model: "default" } });
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))).toMatchObject({ state: "ready", clientConnected: true, turn: "idle" });

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    const received = readFileSync(adapterLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Message);
    expect(received.find((message) => message.method === "session/load")?.params).toEqual({
      sessionId: "acp-1",
      cwd: dir,
      mcpServers: [],
      _meta: { systemPrompt: { append: "Commit locally only." } },
    });
    expect(received.find((message) => message.id === "permission-1")).toMatchObject({ result: { outcome: { optionId: "allow" } } });
    expect(received[received.length - 1]).toEqual({ event: "stdin closed" });
  }, 30_000);
});
