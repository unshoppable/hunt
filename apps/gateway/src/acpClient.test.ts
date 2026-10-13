import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requestMessage, responseMessage, type JsonRpcRequest } from "../../../libs/domain/src/jsonRpc.ts";
import { encodeLine } from "../../../libs/domain/src/ndjson.ts";
import { label, turnOf } from "../../session/src/relay/fixtures/messages.ts";
import { startRelay, waitForStatus, type RelayProcess } from "../../session/src/relay/fixtures/relayProcess.ts";
import { sendPrompt, type Transport } from "./acpClient.ts";

/** A transport over the relay's Unix socket, as `socat - UNIX-CONNECT:…` gives the poller over SSH. */
function socketTransport(path: string): Promise<Transport & { closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    const closed = new Promise<void>((resolveClosed) => socket.once("close", () => resolveClosed()));
    socket.once("connect", () =>
      resolve({
        write: (text) => {
          socket.write(text);
        },
        onData: (listener) => {
          socket.on("data", listener);
        },
        onClose: (listener) => {
          socket.on("close", () => listener());
        },
        close: () => {
          socket.end();
        },
        closed,
      }),
    );
  });
}

/** A transport whose relay answers each request with `answer`; records what the client wrote and whether it closed. */
function scriptedTransport(answer: (request: JsonRpcRequest) => unknown[]) {
  const written: JsonRpcRequest[] = [];
  let receive: (text: string) => void = () => {};
  let closeListener: (reason?: string) => void = () => {};
  const state = { isClosed: false };
  const transport: Transport = {
    write: (text) => {
      const request = JSON.parse(text) as JsonRpcRequest;
      written.push(request);
      queueMicrotask(() => {
        for (const message of answer(request)) {
          receive(encodeLine(message));
        }
      });
    },
    onData: (listener) => {
      receive = listener;
    },
    onClose: (listener) => {
      closeListener = listener;
    },
    close: () => {
      state.isClosed = true;
    },
  };
  return { transport, written, state, hangUp: (reason?: string) => closeListener(reason) };
}

const TURN_IDLE = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } } } };
const TURN_RUNNING = { ...TURN_IDLE, params: { ...TURN_IDLE.params, update: { ...TURN_IDLE.params.update, _meta: { hunt: { turn: "running" } } } } };

describe("sendPrompt against the relay", () => {
  let relay: RelayProcess | null = null;

  afterEach(() => {
    relay?.dispose();
    relay = null;
  });

  it("loads the session, sends the prompt, disconnects once the turn runs, and the relay finishes the turn", async () => {
    relay = await startRelay({ acpSessionId: "acp-1", systemPromptAppend: "Remote." });
    const transport = await socketTransport(relay.socketPath);

    expect(await sendPrompt(transport, { sessionId: "acp-1", cwd: "/home/agent/app", text: "Implement #12" })).toBe("started");
    await transport.closed;

    const status = await waitForStatus(relay.statusPath, (candidate) => candidate.lastTurnEndedAt !== null && candidate.clientConnected === false, relay.output);
    expect(status).toMatchObject({ state: "ready", turn: "idle" });
    const methods = relay.adapterMessages().map((message) => message.method);
    expect(methods).toEqual(["initialize", "session/load", "session/set_mode", "session/prompt"]);
    expect(relay.adapterMessages()[3].params).toEqual({ sessionId: "acp-1", prompt: [{ type: "text", text: "Implement #12" }] });
  }, 30_000);

  it("keeps the prompt of a client that disconnected running, and queues behind a turn that runs", async () => {
    relay = await startRelay({ acpSessionId: "acp-1" });
    // "ask" makes the fake adapter wait for a permission answer, so the turn stays running after the client left.
    const first = await socketTransport(relay.socketPath);
    expect(await sendPrompt(first, { sessionId: "acp-1", cwd: "/x", text: "ask" })).toBe("started");
    await first.closed;
    await waitForStatus(relay.statusPath, (status) => status.turn === "running" && status.clientConnected === false && status.pendingPermissionSince !== null, relay.output);

    const second = await socketTransport(relay.socketPath);
    expect(await sendPrompt(second, { sessionId: "acp-1", cwd: "/x", text: "second" })).toBe("queued");
    await second.closed;

    // Another client answers the permission request; the first turn ends and the queued prompt runs.
    const answering = await socketTransport(relay.socketPath);
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

describe("sendPrompt", () => {
  it("speaks initialize, session/load and session/prompt and reports a started turn", async () => {
    const { transport, written, state } = scriptedTransport((request) => {
      if (request.method === "session/load") return [responseMessage(request.id, { result: {} }), TURN_IDLE];
      if (request.method === "session/prompt") return [TURN_RUNNING];
      return [responseMessage(request.id, { result: { protocolVersion: 1 } })];
    });

    expect(await sendPrompt(transport, { sessionId: "acp-1", cwd: "/home/agent/app", text: "hi" })).toBe("started");
    expect(written.map((request) => [request.id, request.method])).toEqual([
      [1, "initialize"],
      [2, "session/load"],
      [3, "session/prompt"],
    ]);
    expect(written[1].params).toEqual({ sessionId: "acp-1", cwd: "/home/agent/app", mcpServers: [] });
    expect(state.isClosed).toBe(true);
    expect(turnOf(TURN_RUNNING)).toBe("running");
  });

  it("fails with the relay's error for another session and closes the transport", async () => {
    const { transport, state } = scriptedTransport((request) =>
      request.method === "session/load"
        ? [responseMessage(request.id, { error: { code: -32602, message: "the relay serves the session acp-2, not acp-1" } })]
        : [responseMessage(request.id, { result: {} })],
    );

    await expect(sendPrompt(transport, { sessionId: "acp-1", cwd: "/x", text: "hi" })).rejects.toThrow(
      "failed to load the session acp-1: the relay serves the session acp-2, not acp-1",
    );
    expect(state.isClosed).toBe(true);
  });

  it("fails when the connection closes or the relay does not answer in time", async () => {
    const closing = scriptedTransport(() => []);
    const closed = sendPrompt(closing.transport, { sessionId: "acp-1", cwd: "/x", text: "hi" });
    closing.hangUp("exit status 255: Connection refused");
    await expect(closed).rejects.toThrow("failed to initialize the relay connection: the connection to the relay closed: exit status 255: Connection refused");

    const silent = scriptedTransport(() => []);
    await expect(sendPrompt(silent.transport, { sessionId: "acp-1", cwd: "/x", text: "hi", timeoutMs: 20 })).rejects.toThrow(
      "failed to initialize the relay connection: the relay did not answer within 0.02 s",
    );
  });
});
