import { describe, expect, it } from "vitest";
import type { ConfigChanges, HuntSessionConfig, McpServerEntry } from "./config.ts";
import { label, textOf, turnOf, updateOf } from "./fixtures/messages.ts";
import {
  classify,
  errorOutcome,
  isRecord,
  notificationMessage,
  requestMessage,
  responseMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type Outcome,
} from "./jsonRpc.ts";
import { Relay, type ClientConnection } from "./relay.ts";

const SESSION_ID = "acp-1";
const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "plan", name: "Plan" },
    { id: "bypassPermissions", name: "Bypass permissions" },
  ],
};
const CONFIG_OPTIONS = [{ id: "model", name: "Model", type: "select", currentValue: "default", options: [] }];
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {} },
  },
  agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.89.1" },
  authMethods: [],
};
const MCP_SERVERS: McpServerEntry[] = [
  { name: "playwright", command: "/opt/hunt/node/bin/node", args: ["cli.js", "--headless"], env: [{ name: "PLAYWRIGHT_BROWSERS_PATH", value: "/opt/b" }] },
];
const CONFIG: HuntSessionConfig = {
  acpSessionId: SESSION_ID,
  cwd: "/srv/worktrees/7c0c6f2e",
  systemPromptAppend: "Commit locally only.",
  modeId: "bypassPermissions",
  configOptions: {},
};
const PERMISSION_PARAMS = {
  sessionId: SESSION_ID,
  toolCall: { toolCallId: "tool-1", title: "Write README.md" },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
};
const ALLOWED = { result: { outcome: { outcome: "selected", optionId: "allow" } } };
const END_TURN = { result: { stopReason: "end_turn" } };

/** Answers a request the relay sends to the adapter; a method without a handler is left for the test to answer. */
type AgentScript = Record<string, ((params: Record<string, unknown>) => Outcome) | undefined>;

interface FakeClient extends ClientConnection {
  sent: JsonRpcMessage[];
  isClosed: boolean;
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    sent: [],
    isClosed: false,
    send: (message) => {
      client.sent.push(message);
    },
    close: () => {
      client.isClosed = true;
    },
  };
  return client;
}

function loadRequest(id: JsonRpcId, sessionId = SESSION_ID): JsonRpcRequest {
  return requestMessage(id, "session/load", { sessionId, cwd: "/elsewhere", mcpServers: [], _meta: { systemPrompt: { append: "ignored" } } });
}

function promptRequest(id: JsonRpcId, text: string, sessionId = SESSION_ID): JsonRpcRequest {
  return requestMessage(id, "session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}

function chunk(text: string): Record<string, unknown> {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

/** A relay whose adapter answers from a mutable script, with a fake clock and recorded side effects. */
function createHarness(config: Partial<HuntSessionConfig> = {}, loadConfig = () => ({ ...CONFIG, ...config })) {
  const toAgent: JsonRpcMessage[] = [];
  const persisted: ConfigChanges[] = [];
  const logs: string[] = [];
  const clock = { now: 1_000 };
  const statusChanges = { count: 0 };
  const script: AgentScript = {
    initialize: () => ({ result: INITIALIZE_RESULT }),
    "session/load": () => ({ result: { modes: MODES, configOptions: CONFIG_OPTIONS } }),
    "session/new": () => ({ result: { sessionId: "acp-new", modes: MODES, configOptions: CONFIG_OPTIONS } }),
    "session/set_mode": () => ({ result: {} }),
    "session/set_config_option": (params) => ({ result: { configOptions: [{ id: params.configId, currentValue: params.value }] } }),
  };
  const relay: Relay = new Relay({
    sendToAgent: (message) => {
      toAgent.push(message);
      const request = classify(message);
      if (request.kind !== "request") return;
      const handler = script[request.method];
      if (!handler) return;
      queueMicrotask(() => relay.handleAgentMessage(responseMessage(request.id, handler(isRecord(request.params) ? request.params : {}))));
    },
    loadConfig,
    mcpServers: MCP_SERVERS,
    persistConfig: (changes) => {
      persisted.push(changes);
    },
    onStatusChange: () => {
      statusChanges.count++;
    },
    now: () => clock.now,
    log: (message) => {
      logs.push(message);
    },
  });

  /** The requests the relay sent to the adapter with `method`, oldest first. */
  function requestsTo(method: string): JsonRpcRequest[] {
    return toAgent.filter((message): message is JsonRpcRequest => "id" in message && "method" in message && message.method === method);
  }

  function respond(request: JsonRpcRequest, outcome: Outcome): void {
    relay.handleAgentMessage(responseMessage(request.id, outcome));
  }

  function update(sessionUpdate: Record<string, unknown>, sessionId = SESSION_ID): void {
    relay.handleAgentMessage(notificationMessage("session/update", { sessionId, update: sessionUpdate }));
  }

  /** A newly connected client that loaded the session; what it received while loading is cleared. */
  function loadedClient(): FakeClient {
    const client = fakeClient();
    relay.connectClient(client);
    relay.handleClientMessage(client, loadRequest("load"));
    client.sent.length = 0;
    return client;
  }

  /** The result of a fresh client's `session/load`. */
  function loadResult(): Record<string, unknown> {
    const client = fakeClient();
    relay.connectClient(client);
    relay.handleClientMessage(client, loadRequest("load"));
    const response = client.sent.find((message) => "id" in message && message.id === "load" && !("method" in message));
    return response && "result" in response && isRecord(response.result) ? response.result : {};
  }

  return { relay, script, toAgent, persisted, logs, clock, statusChanges, requestsTo, respond, update, loadedClient, loadResult };
}

async function startedHarness(config: Partial<HuntSessionConfig> = {}) {
  const harness = createHarness(config);
  await harness.relay.start();
  return harness;
}

describe("start", () => {
  it("initializes the adapter once with only terminal_output and serves the result without unsupported session capabilities", async () => {
    const harness = createHarness();
    const early = fakeClient();
    harness.relay.connectClient(early);
    harness.relay.handleClientMessage(early, requestMessage(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
    expect(early.sent).toEqual([]);

    await harness.relay.start();

    const capabilities = { ...INITIALIZE_RESULT.agentCapabilities, sessionCapabilities: { additionalDirectories: {}, resume: {} } };
    const expected = { ...INITIALIZE_RESULT, agentCapabilities: capabilities };
    expect(early.sent).toEqual([{ jsonrpc: "2.0", id: 1, result: expected }]);
    const late = fakeClient();
    harness.relay.connectClient(late);
    harness.relay.handleClientMessage(late, requestMessage("again", "initialize", {}));
    expect(late.sent).toEqual([{ jsonrpc: "2.0", id: "again", result: expected }]);
    expect(harness.requestsTo("initialize").map((request) => request.params)).toEqual([
      { protocolVersion: 1, clientCapabilities: { _meta: { terminal_output: true } }, clientInfo: expect.objectContaining({ name: "hunt-relay" }) },
    ]);
  });

  it("loads the configured session with the system prompt, then restores the mode and the config options in order", async () => {
    const harness = await startedHarness({ configOptions: { model: "opus", effort: "high" } });

    expect(harness.toAgent.map((message) => ("method" in message ? message.method : "response"))).toEqual([
      "initialize",
      "session/load",
      "session/set_mode",
      "session/set_config_option",
      "session/set_config_option",
    ]);
    const setup = { cwd: CONFIG.cwd, mcpServers: MCP_SERVERS, _meta: { systemPrompt: { append: "Commit locally only." } } };
    expect(harness.requestsTo("session/load")[0].params).toEqual({ sessionId: SESSION_ID, ...setup });
    expect(harness.requestsTo("session/set_mode")[0].params).toEqual({ sessionId: SESSION_ID, modeId: "bypassPermissions" });
    expect(harness.requestsTo("session/set_config_option").map((request) => request.params)).toEqual([
      { sessionId: SESSION_ID, configId: "model", value: "opus" },
      { sessionId: SESSION_ID, configId: "effort", value: "high" },
    ]);
    expect(harness.relay.status()).toMatchObject({ state: "ready", error: null, acpSessionId: SESSION_ID });
    expect(harness.persisted).toEqual([]);
    expect(harness.loadResult().modes).toEqual({ ...MODES, currentModeId: "bypassPermissions" });
  });

  it("creates a session when the config has no ID, keeps the updates sent meanwhile and writes the ID back", async () => {
    const harness = createHarness({ acpSessionId: null });
    harness.script["session/new"] = () => {
      harness.update(chunk("early"), "acp-new");
      harness.update(chunk("another session"), "acp-other");
      return { result: { sessionId: "acp-new", modes: MODES, configOptions: CONFIG_OPTIONS } };
    };

    await harness.relay.start();

    const setup = { cwd: CONFIG.cwd, mcpServers: MCP_SERVERS, _meta: { systemPrompt: { append: "Commit locally only." } } };
    expect(harness.requestsTo("session/new")[0].params).toEqual(setup);
    expect(harness.requestsTo("session/set_mode")[0].params).toEqual({ sessionId: "acp-new", modeId: "bypassPermissions" });
    expect(harness.persisted).toEqual([{ acpSessionId: "acp-new" }]);
    expect(harness.relay.status()).toMatchObject({ state: "ready", acpSessionId: "acp-new" });
    const client = fakeClient();
    harness.relay.connectClient(client);
    harness.relay.handleClientMessage(client, loadRequest(1, "acp-new"));
    expect(client.sent.map(label)).toEqual(["agent_message_chunk", "response:1", "turn:idle"]);
    expect(textOf(client.sent[0])).toBe("early");
  });

  it("logs a mode or config option the agent rejects and starts anyway", async () => {
    const harness = createHarness({ modeId: "auto", configOptions: { model: "retired", effort: "high" } });
    harness.script["session/set_mode"] = () => errorOutcome(-32603, "Invalid Mode");
    harness.script["session/set_config_option"] = (params) =>
      params.configId === "model" ? errorOutcome(-32603, "Invalid value for config option model: retired") : { result: { configOptions: CONFIG_OPTIONS } };

    await harness.relay.start();

    expect(harness.relay.status().state).toBe("ready");
    expect(harness.requestsTo("session/set_config_option")).toHaveLength(2);
    expect(harness.logs).toEqual(
      expect.arrayContaining([
        "failed to set the mode auto: Invalid Mode",
        "failed to set the config option model to retired: Invalid value for config option model: retired",
      ]),
    );
  });

  it("fails with the agent's error, answers loads and prompts with -32603 and keeps serving initialize", async () => {
    const harness = createHarness();
    harness.script["session/load"] = () => errorOutcome(-32002, "Resource not found: acp-1");
    const client = fakeClient();
    harness.relay.connectClient(client);
    harness.relay.handleClientMessage(client, loadRequest("waiting"));

    await harness.relay.start();

    const failure = "failed to load the session acp-1: Resource not found: acp-1";
    expect(harness.relay.status()).toMatchObject({ state: "failed", error: failure });
    harness.relay.handleClientMessage(client, requestMessage(2, "initialize", {}));
    harness.relay.handleClientMessage(client, promptRequest(3, "hi"));
    harness.relay.handleClientMessage(client, loadRequest(4));
    expect(client.sent).toEqual([
      { jsonrpc: "2.0", id: "waiting", error: { code: -32603, message: failure } },
      { jsonrpc: "2.0", id: 2, result: expect.objectContaining({ protocolVersion: 1 }) },
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: failure } },
      { jsonrpc: "2.0", id: 4, error: { code: -32603, message: failure } },
    ]);
    expect(harness.requestsTo("session/prompt")).toEqual([]);
  });

  it("fails when the adapter rejects initialize or the config cannot be read", async () => {
    const rejected = createHarness();
    rejected.script.initialize = () => errorOutcome(-32603, "boom");
    const client = fakeClient();
    rejected.relay.connectClient(client);
    rejected.relay.handleClientMessage(client, requestMessage(1, "initialize", {}));
    await rejected.relay.start();
    expect(client.sent).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "failed to initialize the agent: boom" } }]);

    const unreadable = createHarness({}, () => {
      throw new Error("failed to read /home/agent/.claude/hunt-session.json: ENOENT");
    });
    await unreadable.relay.start();
    expect(unreadable.relay.status()).toMatchObject({ state: "failed", error: "failed to read /home/agent/.claude/hunt-session.json: ENOENT" });
    expect(unreadable.requestsTo("session/load")).toEqual([]);
  });
});

describe("session/load", () => {
  it("replays the history, the response, the latest commands and usage and then the turn state", async () => {
    const harness = await startedHarness();
    harness.update(chunk("one"));
    harness.update({ sessionUpdate: "usage_update", used: 1, size: 100 });
    harness.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "old" }] });
    harness.update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read" });
    harness.update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "new" }] });
    harness.update({ sessionUpdate: "usage_update", used: 2, size: 100 });
    harness.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    harness.update({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "opus" }] });
    const sentToAgent = harness.toAgent.length;
    const client = fakeClient();
    harness.relay.connectClient(client);

    harness.relay.handleClientMessage(client, loadRequest(7));

    expect(client.sent.map(label)).toEqual(["agent_message_chunk", "tool_call", "response:7", "available_commands_update", "usage_update", "turn:idle"]);
    expect(client.sent[2]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { modes: { ...MODES, currentModeId: "plan" }, configOptions: [{ id: "model", currentValue: "opus" }] },
    });
    expect(updateOf(client.sent[3])).toMatchObject({ availableCommands: [{ name: "new" }] });
    expect(updateOf(client.sent[4])).toMatchObject({ used: 2 });
    expect(harness.toAgent).toHaveLength(sentToAgent);
  });

  it("holds a load during the start and replays what arrived meanwhile before the response", async () => {
    const harness = createHarness();
    harness.script["session/load"] = () => {
      harness.update(chunk("replayed"));
      return { result: { modes: MODES, configOptions: CONFIG_OPTIONS } };
    };
    harness.script["session/set_mode"] = () => {
      harness.update({ sessionUpdate: "available_commands_update", availableCommands: [] });
      harness.update(chunk("during setup"));
      return { result: {} };
    };
    const client = fakeClient();
    harness.relay.connectClient(client);
    harness.relay.handleClientMessage(client, requestMessage(1, "initialize", {}));
    harness.relay.handleClientMessage(client, loadRequest(2));

    await harness.relay.start();
    harness.update(chunk("live"));

    expect(client.sent.map(label)).toEqual([
      "response:1",
      "agent_message_chunk",
      "agent_message_chunk",
      "response:2",
      "available_commands_update",
      "turn:idle",
      "agent_message_chunk",
    ]);
    expect(client.sent.map(textOf).filter(Boolean)).toEqual(["replayed", "during setup", "live"]);
  });

  it("sends live updates only to a client that loaded the session", async () => {
    const harness = await startedHarness();
    const client = fakeClient();
    harness.relay.connectClient(client);
    harness.update(chunk("before the load"));
    expect(client.sent).toEqual([]);

    harness.relay.handleClientMessage(client, loadRequest(1));
    harness.update(chunk("after the load"));

    expect(client.sent.map(label)).toEqual(["agent_message_chunk", "response:1", "turn:idle", "agent_message_chunk"]);
  });

  it("answers another session ID with -32602 and the current ID, never with -32002", async () => {
    const harness = await startedHarness();
    const client = fakeClient();
    harness.relay.connectClient(client);

    harness.relay.handleClientMessage(client, loadRequest(1, "acp-old"));
    harness.relay.handleClientMessage(client, promptRequest(2, "hi", "acp-old"));

    const error = { code: -32602, message: "the relay serves the session acp-1, not acp-old", data: { currentSessionId: SESSION_ID } };
    expect(client.sent).toEqual([
      { jsonrpc: "2.0", id: 1, error },
      { jsonrpc: "2.0", id: 2, error },
    ]);
    expect(harness.requestsTo("session/prompt")).toEqual([]);
  });
});

describe("prompts", () => {
  it("forwards one prompt at a time under relay IDs and records each prompt as user_message_chunks", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();

    harness.relay.handleClientMessage(client, promptRequest("p1", "first"));
    harness.relay.handleClientMessage(client, promptRequest("p2", "second"));
    const [first] = harness.requestsTo("session/prompt");
    expect(harness.requestsTo("session/prompt")).toHaveLength(1);
    expect(first.id).not.toBe("p1");
    expect(first.params).toEqual({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "first" }] });
    expect(client.sent.map(label)).toEqual(["turn:running"]);

    harness.update(chunk("answer one"));
    harness.respond(first, END_TURN);
    const second = harness.requestsTo("session/prompt")[1];
    expect(second.params).toEqual({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "second" }] });
    expect(client.sent.map(label)).toEqual(["turn:running", "agent_message_chunk", "response:p1"]);
    expect(client.sent[2]).toEqual({ jsonrpc: "2.0", id: "p1", result: { stopReason: "end_turn" } });

    harness.respond(second, END_TURN);
    expect(client.sent.slice(3).map(label)).toEqual(["response:p2", "turn:idle"]);

    const next = fakeClient();
    harness.relay.connectClient(next);
    harness.relay.handleClientMessage(next, loadRequest(1));
    expect(next.sent.map(label)).toEqual(["user_message_chunk", "agent_message_chunk", "user_message_chunk", "response:1", "turn:idle"]);
    expect(updateOf(next.sent[0])).toEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "first" } });
    expect(textOf(next.sent[2])).toBe("second");
  });

  it("drops the answer for a replaced client and shows its queued prompt to the client that took over", async () => {
    const harness = await startedHarness();
    const first = harness.loadedClient();
    harness.relay.handleClientMessage(first, promptRequest(1, "running"));
    harness.relay.handleClientMessage(first, promptRequest(2, "queued"));

    const second = harness.loadedClient();
    harness.respond(harness.requestsTo("session/prompt")[0], END_TURN);

    expect(first.isClosed).toBe(true);
    expect(first.sent.map(label)).toEqual(["turn:running"]);
    expect(second.sent.map(label)).toEqual(["user_message_chunk"]);
    expect(textOf(second.sent[0])).toBe("queued");
    expect(harness.requestsTo("session/prompt")).toHaveLength(2);
    expect(harness.relay.status().turn).toBe("running");
  });
});

describe("cancellation", () => {
  it("answers queued prompts as cancelled and forwards session/cancel for the running one", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();
    harness.relay.handleClientMessage(client, promptRequest(1, "running"));
    harness.relay.handleClientMessage(client, promptRequest(2, "queued"));
    harness.relay.handleClientMessage(client, promptRequest(3, "queued too"));

    harness.relay.handleClientMessage(client, notificationMessage("session/cancel", { sessionId: SESSION_ID }));

    expect(client.sent.slice(1)).toEqual([
      { jsonrpc: "2.0", id: 2, result: { stopReason: "cancelled" } },
      { jsonrpc: "2.0", id: 3, result: { stopReason: "cancelled" } },
    ]);
    expect(harness.toAgent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SESSION_ID } });
    harness.respond(harness.requestsTo("session/prompt")[0], { result: { stopReason: "cancelled" } });
    expect(client.sent.slice(3).map(label)).toEqual(["response:1", "turn:idle"]);
    expect(harness.requestsTo("session/prompt")).toHaveLength(1);

    const next = fakeClient();
    harness.relay.connectClient(next);
    harness.relay.handleClientMessage(next, loadRequest(1));
    expect(next.sent.map(textOf).filter(Boolean)).toEqual(["running"]);
  });

  it("maps a client's $/cancel_request to the relay ID, or ends a queued prompt as cancelled", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();
    harness.relay.handleClientMessage(client, promptRequest("a", "running"));
    harness.relay.handleClientMessage(client, promptRequest("b", "queued"));

    harness.relay.handleClientMessage(client, notificationMessage("$/cancel_request", { requestId: "b" }));
    expect(client.sent.slice(1)).toEqual([{ jsonrpc: "2.0", id: "b", result: { stopReason: "cancelled" } }]);

    harness.relay.handleClientMessage(client, notificationMessage("$/cancel_request", { requestId: "a" }));
    const forwarded = harness.requestsTo("session/prompt")[0];
    expect(harness.toAgent.at(-1)).toEqual({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: forwarded.id } });

    const sentToAgent = harness.toAgent.length;
    harness.relay.handleClientMessage(client, notificationMessage("$/cancel_request", { requestId: "unknown" }));
    expect(harness.toAgent).toHaveLength(sentToAgent);
    harness.respond(forwarded, { result: { stopReason: "cancelled" } });
    expect(harness.requestsTo("session/prompt")).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("forwards a permission request under a relay ID and answers the adapter under its own ID", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();

    harness.relay.handleAgentMessage(requestMessage(41, "session/request_permission", PERMISSION_PARAMS));
    const forwarded = client.sent[0] as JsonRpcRequest;
    expect(forwarded).toMatchObject({ jsonrpc: "2.0", method: "session/request_permission", params: PERMISSION_PARAMS });
    expect(forwarded.id).not.toBe(41);

    harness.relay.handleClientMessage(client, responseMessage(forwarded.id, ALLOWED));
    expect(harness.toAgent.at(-1)).toEqual({ jsonrpc: "2.0", id: 41, ...ALLOWED });
    expect(harness.relay.status().pendingPermissionSince).toBeNull();
  });

  it("keeps a permission request while no client is loaded and sends open ones to the next client after its load", async () => {
    const harness = await startedHarness();
    harness.clock.now = 5_000;
    harness.relay.handleAgentMessage(requestMessage(7, "session/request_permission", PERMISSION_PARAMS));
    expect(harness.relay.status().pendingPermissionSince).toBe(5_000);

    const first = fakeClient();
    harness.relay.connectClient(first);
    expect(first.sent).toEqual([]);
    harness.relay.handleClientMessage(first, loadRequest("l1"));
    expect(first.sent.map(label)).toEqual(["response:l1", "turn:idle", "request:session/request_permission"]);
    const firstId = (first.sent[2] as JsonRpcRequest).id;

    const second = fakeClient();
    harness.relay.connectClient(second);
    harness.relay.handleClientMessage(first, responseMessage(firstId, { result: { outcome: { outcome: "cancelled" } } }));
    harness.relay.handleClientMessage(second, loadRequest("l2"));
    const resent = second.sent[2] as JsonRpcRequest;
    expect(label(resent)).toBe("request:session/request_permission");
    expect(resent.id).not.toBe(firstId);
    expect(resent.params).toEqual(PERMISSION_PARAMS);

    harness.relay.handleClientMessage(second, responseMessage(resent.id, ALLOWED));
    const answers = harness.toAgent.filter((message) => "id" in message && message.id === 7 && !("method" in message));
    expect(answers).toEqual([{ jsonrpc: "2.0", id: 7, ...ALLOWED }]);
    expect(harness.relay.status().pendingPermissionSince).toBeNull();
  });

  it("passes the adapter's $/cancel_request on under the client's ID and answers the adapter with -32800", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();
    harness.relay.handleAgentMessage(requestMessage(9, "session/request_permission", PERMISSION_PARAMS));
    const clientId = (client.sent[0] as JsonRpcRequest).id;

    harness.relay.handleAgentMessage(notificationMessage("$/cancel_request", { requestId: 9 }));

    expect(client.sent[1]).toEqual({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: clientId } });
    expect(harness.toAgent.at(-1)).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32800, message: "Request cancelled" } });
    const sentToAgent = harness.toAgent.length;
    harness.relay.handleClientMessage(client, responseMessage(clientId, { result: { outcome: { outcome: "cancelled" } } }));
    expect(harness.toAgent).toHaveLength(sentToAgent);
    expect(harness.relay.status().pendingPermissionSince).toBeNull();
  });
});

describe("settings", () => {
  it("forwards session/set_mode under a relay ID, caches the accepted mode and stores it", async () => {
    const harness = await startedHarness();
    harness.script["session/set_mode"] = undefined;
    const client = harness.loadedClient();

    harness.relay.handleClientMessage(client, requestMessage("mode", "session/set_mode", { sessionId: SESSION_ID, modeId: "plan" }));
    const forwarded = harness.requestsTo("session/set_mode").at(-1) as JsonRpcRequest;
    expect(forwarded.id).not.toBe("mode");
    expect(forwarded.params).toEqual({ sessionId: SESSION_ID, modeId: "plan" });
    harness.respond(forwarded, { result: {} });

    expect(client.sent).toEqual([{ jsonrpc: "2.0", id: "mode", result: {} }]);
    expect(harness.persisted).toEqual([{ modeId: "plan" }]);
    expect(harness.loadResult().modes).toEqual({ ...MODES, currentModeId: "plan" });
  });

  it("keeps a mode the agent announced while session/set_mode was pending", async () => {
    const harness = await startedHarness();
    harness.script["session/set_mode"] = undefined;
    const client = harness.loadedClient();

    harness.relay.handleClientMessage(client, requestMessage(1, "session/set_mode", { sessionId: SESSION_ID, modeId: "auto" }));
    harness.update({ sessionUpdate: "current_mode_update", currentModeId: "default" });
    harness.respond(harness.requestsTo("session/set_mode").at(-1) as JsonRpcRequest, { result: {} });

    expect(harness.loadResult().modes).toEqual({ ...MODES, currentModeId: "default" });
  });

  it("forwards session/set_config_option, caches the returned options and stores the value", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();

    const setOption = (configId: string, value: string) => requestMessage(configId, "session/set_config_option", { sessionId: SESSION_ID, configId, value });
    harness.relay.handleClientMessage(client, setOption("model", "opus"));
    await Promise.resolve();
    harness.relay.handleClientMessage(client, setOption("mode", "plan"));
    await Promise.resolve();

    expect(client.sent).toEqual([
      { jsonrpc: "2.0", id: "model", result: { configOptions: [{ id: "model", currentValue: "opus" }] } },
      { jsonrpc: "2.0", id: "mode", result: { configOptions: [{ id: "mode", currentValue: "plan" }] } },
    ]);
    expect(harness.persisted).toEqual([{ configOptions: { model: "opus" } }, { modeId: "plan" }]);
    expect(harness.loadResult().configOptions).toEqual([{ id: "mode", currentValue: "plan" }]);
  });

  it("passes a rejected setting's error on and stores nothing", async () => {
    const harness = await startedHarness();
    harness.script["session/set_config_option"] = () => errorOutcome(-32603, "Invalid value for config option model: nope");
    const client = harness.loadedClient();

    harness.relay.handleClientMessage(client, requestMessage(1, "session/set_config_option", { sessionId: SESSION_ID, configId: "model", value: "nope" }));
    await Promise.resolve();

    expect(client.sent).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Invalid value for config option model: nope" } }]);
    expect(harness.persisted).toEqual([]);
  });
});

describe("allowlist", () => {
  it("answers other client methods with -32601 and forwards none of them", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();
    const sentToAgent = harness.toAgent.length;
    const methods = ["session/new", "session/list", "session/fork", "session/resume", "session/close", "authenticate", "fs/read_text_file"];

    methods.forEach((method, index) => harness.relay.handleClientMessage(client, requestMessage(index, method, { sessionId: SESSION_ID })));
    harness.relay.handleClientMessage(client, notificationMessage("session/unknown", {}));

    const notFound = (method: string, index: number) => ({ jsonrpc: "2.0", id: index, error: { code: -32601, message: `Method not found: ${method}` } });
    expect(client.sent).toEqual(methods.map(notFound));
    expect(harness.toAgent).toHaveLength(sentToAgent);
  });

  it("answers the adapter's other requests with -32601", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();

    harness.relay.handleAgentMessage(requestMessage(3, "fs/read_text_file", { sessionId: SESSION_ID, path: "/etc/hostname" }));

    expect(harness.toAgent.at(-1)).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found: fs/read_text_file" } });
    expect(client.sent).toEqual([]);
  });

  it("drops notifications of other sessions and without a session", async () => {
    const harness = await startedHarness();
    const client = harness.loadedClient();

    harness.relay.handleAgentMessage(notificationMessage("_auth/status_update", { status: "signedIn" }));
    harness.update(chunk("another session"), "acp-other");

    expect(client.sent).toEqual([]);
    const next = fakeClient();
    harness.relay.connectClient(next);
    harness.relay.handleClientMessage(next, loadRequest(1));
    expect(next.sent.map(label)).toEqual(["response:1", "turn:idle"]);
  });

  it("answers a message that is not JSON-RPC with -32600", async () => {
    const harness = await startedHarness();
    const client = fakeClient();
    harness.relay.connectClient(client);

    harness.relay.handleClientMessage(client, [1, 2]);
    harness.relay.handleClientMessage(client, { jsonrpc: "2.0", id: 1 });

    const invalid = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    expect(client.sent).toEqual([invalid, invalid]);
  });
});

describe("clients", () => {
  it("closes the previous client on a new connection, ignores its messages and drops answers meant for it", async () => {
    const harness = await startedHarness();
    const first = harness.loadedClient();
    harness.relay.handleClientMessage(first, promptRequest(1, "hi"));

    const second = fakeClient();
    harness.relay.connectClient(second);
    harness.relay.handleClientMessage(first, promptRequest(2, "ignored"));
    harness.respond(harness.requestsTo("session/prompt")[0], END_TURN);

    expect(first.isClosed).toBe(true);
    expect(first.sent.map(label)).toEqual(["turn:running"]);
    expect(second.sent).toEqual([]);
    expect(harness.requestsTo("session/prompt")).toHaveLength(1);
    harness.relay.disconnectClient(first);
    expect(harness.relay.status().clientConnected).toBe(true);
    harness.relay.disconnectClient(second);
    expect(harness.relay.status().clientConnected).toBe(false);
  });
});

describe("status", () => {
  it("reports the start, the client and its activity, the turn and open permission requests", async () => {
    const harness = createHarness();
    expect(harness.relay.status()).toEqual({
      heartbeatAt: 1_000,
      state: "starting",
      error: null,
      acpSessionId: null,
      turn: "idle",
      clientConnected: false,
      lastClientActivityAt: null,
      lastTurnEndedAt: null,
      pendingPermissionSince: null,
    });
    await harness.relay.start();
    expect(harness.relay.status()).toMatchObject({ state: "ready", acpSessionId: SESSION_ID });

    harness.clock.now = 2_000;
    const client = harness.loadedClient();
    expect(harness.relay.status()).toMatchObject({ heartbeatAt: 2_000, clientConnected: true, lastClientActivityAt: 2_000 });
    harness.clock.now = 3_000;
    harness.relay.handleClientMessage(client, promptRequest(1, "hi"));
    expect(harness.relay.status()).toMatchObject({ turn: "running", lastClientActivityAt: 3_000, lastTurnEndedAt: null });
    harness.clock.now = 4_000;
    harness.relay.handleAgentMessage(requestMessage(5, "session/request_permission", PERMISSION_PARAMS));
    harness.clock.now = 6_000;
    harness.respond(harness.requestsTo("session/prompt")[0], END_TURN);
    expect(harness.relay.status()).toMatchObject({ turn: "idle", lastTurnEndedAt: 6_000, pendingPermissionSince: 4_000 });
    expect(turnOf(client.sent.at(-1))).toBe("idle");
  });

  it("reports a change only when a field other than the heartbeat changed", async () => {
    const harness = await startedHarness();
    const before = harness.statusChanges.count;

    harness.clock.now += 60_000;
    harness.update(chunk("no status change"));
    expect(harness.statusChanges.count).toBe(before);

    harness.relay.connectClient(fakeClient());
    expect(harness.statusChanges.count).toBe(before + 1);
  });
});
