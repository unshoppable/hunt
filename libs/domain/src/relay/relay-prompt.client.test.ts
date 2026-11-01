import { describe, expect, it } from "vitest";
import { responseMessage, type JsonRpcRequest } from "../shared/json-rpc.utils.ts";
import { encodeLine } from "../shared/ndjson.utils.ts";
import { sendPrompt, turnOf, type Transport } from "./relay-prompt.client.ts";

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

const TURN_IDLE = { jsonrpc: "2.0" as const, method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } } } };
const TURN_RUNNING = { ...TURN_IDLE, params: { ...TURN_IDLE.params, update: { ...TURN_IDLE.params.update, _meta: { hunt: { turn: "running" } } } } };

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
