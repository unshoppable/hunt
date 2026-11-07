import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { label, textOf, turnOf } from "./fixtures/messages.ts";
import { FAKE_ADAPTER, MAIN, socketTempDir, startRelay, WAIT_MS, waitForStatus, type RelayProcess } from "./fixtures/relay-process.ts";
import { connectRelaySocket, sendPrompt } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import { requestMessage, responseMessage } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { createLineDecoder, encodeLine, parseLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";

type Message = Record<string, unknown>;

interface TestClient {
  send(message: Message): void;
  /** Resolves with the messages received since the last call, up to and including the first one `isLast` accepts. */
  readUntil(isLast: (message: Message) => boolean): Promise<Message[]>;
  close(): void;
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
        close: () => socket.destroy(),
      }),
    );
  });
}

describe("main", () => {
  let relay: ChildProcess | null = null;
  let dir = "";

  afterEach(() => {
    relay?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the adapter, serves several clients at once on the socket and stops cleanly on SIGTERM", async () => {
    dir = socketTempDir();
    const configPath = join(dir, "hunt-session.json");
    const adapterLog = join(dir, "adapter.log");
    const config = { huntSessionId: "7c0c6f2e", acpSessionId: "acp-1", cwd: dir, systemPromptAppend: "Commit locally only.", configOptions: { model: "opus" } };
    writeFileSync(configPath, JSON.stringify(config));
    const mcpServersPath = join(dir, "mcp-servers.json");
    const mcpServers = [{ name: "playwright", command: "/opt/hunt/node/bin/node", args: ["cli.js"], env: [] }];
    writeFileSync(mcpServersPath, JSON.stringify(mcpServers));
    const env = {
      ...process.env,
      HOME: dir,
      HUNT_ADAPTER: FAKE_ADAPTER,
      HUNT_CONFIG: configPath,
      HUNT_SOCKET_DIR: dir,
      HUNT_MCP_SERVERS: mcpServersPath,
      FAKE_ADAPTER_LOG: adapterLog,
    };
    const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
    relay = child;
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    const status = await waitForStatus(join(dir, "status.json"), (candidate) => candidate.state === "ready", () => output);
    expect(status).toMatchObject({ acpSessionId: "acp-1", turn: "idle", clientConnected: false, error: null });

    const first = await connectClient(join(dir, "relay.sock"));
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

    const second = await connectClient(join(dir, "relay.sock"));
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
    expect(permission.id).not.toBe(asked[1].id);

    second.send({ id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    const finished = await second.readUntil((message) => turnOf(message) === "idle");
    expect(finished.map(label)).toEqual(["agent_message_chunk", "turn:idle"]);
    expect(textOf(finished[0])).toBe("allowed: allow");
    const elsewhere = await first.readUntil((message) => turnOf(message) === "idle");
    expect(elsewhere.map(label)).toEqual(["notification:$/cancel_request", "agent_message_chunk", "response:4", "turn:idle"]);
    expect(elsewhere[0].params).toEqual({ requestId: asked[1].id });

    first.close();
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
      mcpServers,
      _meta: {
        systemPrompt: { append: "Commit locally only." },
        claudeCode: {
          emitRawSDKMessages: [{ type: "system", subtype: "task_progress" }, { type: "system", subtype: "task_notification" }],
          options: { thinking: { type: "adaptive", display: "summarized" }, settings: { autoCompactWindow: 400_000 } },
        },
      },
    });
    expect(received.find((message) => message.id === "permission-1")).toMatchObject({ result: { outcome: { optionId: "allow" } } });
    expect(received[received.length - 1]).toEqual({ event: "stdin closed" });
  }, 30_000);
});

describe("sendPrompt over the socket against the relay", () => {
  let relay: RelayProcess | null = null;

  afterEach(() => {
    relay?.dispose();
    relay = null;
  });

  it("loads the session, sends the prompt, disconnects once the turn runs, and the relay finishes the turn", async () => {
    relay = await startRelay({ acpSessionId: "acp-1", systemPromptAppend: "Remote." });
    const transport = await connectRelaySocket(relay.socketPath);

    expect(await sendPrompt(transport, { sessionId: "acp-1", cwd: "/home/agent/app", text: "Implement #12" })).toBe("started");

    const status = await waitForStatus(relay.statusPath, (candidate) => candidate.lastTurnEndedAt !== null && candidate.clientConnected === false, relay.output);
    expect(status).toMatchObject({ state: "ready", turn: "idle" });
    const methods = relay.adapterMessages().map((message) => message.method);
    expect(methods).toEqual(["initialize", "session/load", "session/set_mode", "session/prompt"]);
    expect(relay.adapterMessages()[3].params).toEqual({ sessionId: "acp-1", prompt: [{ type: "text", text: "Implement #12" }] });
  }, 30_000);

  it("keeps the prompt of a client that disconnected running, and queues behind a turn that runs", async () => {
    relay = await startRelay({ acpSessionId: "acp-1" });
    // "ask" makes the fake adapter wait for a permission answer, so the turn stays running after the client left.
    const first = await connectRelaySocket(relay.socketPath);
    expect(await sendPrompt(first, { sessionId: "acp-1", cwd: "/x", text: "ask" })).toBe("started");
    await waitForStatus(relay.statusPath, (status) => status.turn === "running" && status.clientConnected === false && status.pendingPermissionSince !== null, relay.output);

    const second = await connectRelaySocket(relay.socketPath);
    expect(await sendPrompt(second, { sessionId: "acp-1", cwd: "/x", text: "second" })).toBe("queued");

    // Another client answers the permission request; the first turn ends and the queued prompt runs.
    const answering = await connectRelaySocket(relay.socketPath);
    const received: unknown[] = [];
    answering.onData((text) => {
      for (const line of text.split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { method?: string; id?: number };
        received.push(message);
        if (message.method === "session/request_permission") {
          answering.write(encodeLine(responseMessage(message.id ?? 0, { result: { outcome: { outcome: "selected", optionId: "allow" } } })));
        }
      }
    });
    answering.write(encodeLine(requestMessage(1, "session/load", { sessionId: "acp-1", cwd: "/x", mcpServers: [] })));
    await waitForStatus(relay.statusPath, (status) => status.turn === "idle" && status.pendingPermissionSince === null, relay.output);
    answering.close();

    const prompts = relay.adapterMessages().filter((message) => message.method === "session/prompt");
    expect(prompts.map((message) => (message.params as { prompt: { text: string }[] }).prompt[0].text)).toEqual(["ask", "second"]);
    expect(received.map(label)).toContain("request:session/request_permission");
  }, 30_000);
});
