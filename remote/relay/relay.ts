/**
 * The relay's protocol core, free of processes and sockets. It brings the container's one ACP session up in the
 * adapter, buffers its history, serializes prompts, tracks the turn and the open permission requests, and serves any
 * number of clients at once (Hunt desktops of different people). Every client that loaded the session receives its
 * updates live; one that connects later gets the whole history on `session/load`. Prompts of all clients run one after
 * another, and a permission request goes to every loaded client: the first answer goes to the adapter, the other
 * clients get a `$/cancel_request` for it. JSON-RPC IDs are rewritten in both directions, so the adapter sees only
 * relay IDs and every client only its own. `main.ts` wires `sendToAgent` and `ClientConnection` to the adapter's stdio
 * and the Unix socket.
 */
import type { ConfigChanges, HuntSessionConfig, McpServerEntry } from "./config.ts";
import {
  classify,
  ERROR_CODES,
  errorOutcome,
  isJsonRpcId,
  isRecord,
  notificationMessage,
  requestMessage,
  responseMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type Outcome,
} from "./jsonRpc.ts";
import type { RelayState, RelayStatus, TurnState } from "./status.ts";

const CLIENT_INFO = { name: "hunt-relay", version: "1" };
/** Session capabilities the relay does not serve; they are removed from the adapter's `initialize` result. */
const UNSUPPORTED_SESSION_CAPABILITIES = ["fork", "delete", "close", "list"];
/** The config option that mirrors the session mode; a change of it is stored as `modeId`. */
const MODE_CONFIG_ID = "mode";
const CANCELLED: Outcome = { result: { stopReason: "cancelled" } };

/** One client connection. */
export interface ClientConnection {
  send(message: JsonRpcMessage): void;
}

export interface RelayDependencies {
  sendToAgent(message: JsonRpcMessage): void;
  loadConfig(): HuntSessionConfig;
  /** MCP servers the adapter starts for the session, passed on `session/new` and `session/load`. */
  mcpServers: McpServerEntry[];
  /** Writes `changes` back to `hunt-session.json`; may throw. */
  persistConfig(changes: ConfigChanges): void;
  /** Called whenever a field of `status()` other than `heartbeatAt` changed. */
  onStatusChange(): void;
  now(): number;
  log(message: string): void;
}

interface Client {
  connection: ClientConnection;
  /** Only a client that loaded the session receives updates and permission requests. */
  isLoaded: boolean;
}

/** A client request the relay holds: a waiting `initialize` or `session/load`, a queued prompt or a forwarded request. */
interface ClientRequest {
  client: ClientConnection;
  clientId: JsonRpcId;
  params: unknown;
}

/** A request the relay sent to the adapter, by what happens with its response. */
type AgentRequest =
  | { kind: "internal"; settle(outcome: Outcome): void }
  | { kind: "prompt"; request: ClientRequest }
  | { kind: "setting"; method: string; request: ClientRequest; modeUpdatesAtSend: number };

interface PendingPermission {
  agentId: JsonRpcId;
  params: unknown;
  receivedAt: number;
  /** The connected clients that got the request, with its ID there; empty while no loaded client is connected. */
  forwardedTo: Map<ClientConnection, number>;
}

export class Relay {
  private readonly deps: RelayDependencies;
  private state: RelayState = "starting";
  private error: string | null = null;
  private initializeResult: unknown;
  private sessionId: string | null = null;
  private modes: Record<string, unknown> | null = null;
  private configOptions: unknown[] | null = null;
  /** Counts `current_mode_update`s, so an accepted `session/set_mode` does not override a mode announced meanwhile. */
  private modeUpdates = 0;
  private readonly history: JsonRpcNotification[] = [];
  private latestCommands: JsonRpcNotification | null = null;
  private latestUsage: JsonRpcNotification | null = null;
  /** Updates that arrive while `session/new` runs, before the session ID is known. */
  private heldUpdates: JsonRpcNotification[] | null = null;
  private readonly clients = new Map<ClientConnection, Client>();
  private waitingInitializes: ClientRequest[] = [];
  private waitingLoads: ClientRequest[] = [];
  private queue: ClientRequest[] = [];
  private activePrompt: ClientRequest | null = null;
  private turn: TurnState = "idle";
  private lastClientActivityAt: number | null = null;
  private lastTurnEndedAt: number | null = null;
  private nextAgentRequestId = 1;
  private nextClientRequestId = 1;
  private readonly agentRequests = new Map<JsonRpcId, AgentRequest>();
  /** Open permission requests of the adapter by its request ID, oldest first. */
  private readonly permissions = new Map<JsonRpcId, PendingPermission>();
  private publishedStatus = "";

  constructor(deps: RelayDependencies) {
    this.deps = deps;
  }

  /**
   * Initializes the adapter, then loads the configured conversation (or creates one and stores its ID) and restores
   * the mode and config options. Never rejects: a failure puts the relay into the `failed` state.
   */
  async start(): Promise<void> {
    this.publishStatus();
    try {
      const initialize = { protocolVersion: 1, clientCapabilities: { _meta: { terminal_output: true } }, clientInfo: CLIENT_INFO };
      const initialized = await this.call("initialize", initialize, "failed to initialize the agent");
      if (!isRecord(initialized)) throw new Error("failed to initialize the agent: the result is not an object");
      this.initializeResult = withoutUnsupportedCapabilities(initialized);
      this.answerWaitingInitializes();

      const config = this.deps.loadConfig();
      const setup = { cwd: config.cwd, mcpServers: this.deps.mcpServers, _meta: { systemPrompt: { append: config.systemPromptAppend } } };
      if (config.acpSessionId) {
        this.sessionId = config.acpSessionId;
        this.publishStatus();
        const loaded = await this.call("session/load", { sessionId: config.acpSessionId, ...setup }, `failed to load the session ${config.acpSessionId}`);
        this.adoptSessionState(loaded);
      } else {
        this.heldUpdates = [];
        const created = await this.call("session/new", setup, "failed to create a session");
        const sessionId = isRecord(created) ? created.sessionId : undefined;
        if (typeof sessionId !== "string" || !sessionId) throw new Error("failed to create a session: the result has no sessionId");
        this.sessionId = sessionId;
        this.adoptSessionState(created);
        this.releaseHeldUpdates();
        this.persist({ acpSessionId: sessionId });
        this.publishStatus();
      }

      await this.restoreSettings(config);
      this.state = "ready";
      this.deps.log(`ready with the session ${this.sessionId}`);
      this.publishStatus();
      this.answerWaitingLoads();
    } catch (error) {
      this.fail(messageOf(error));
    }
  }

  /** A new client connection, served next to the clients connected already. */
  connectClient(connection: ClientConnection): void {
    this.clients.set(connection, { connection, isLoaded: false });
    this.publishStatus();
  }

  /** The connection of a client closed; the other clients go on as before. A no-op for an unknown connection. */
  disconnectClient(connection: ClientConnection): void {
    if (!this.clients.delete(connection)) return;
    this.detach(connection);
    this.publishStatus();
  }

  /** A parsed message from a client; messages of a disconnected client are ignored. */
  handleClientMessage(connection: ClientConnection, value: unknown): void {
    if (!this.clients.has(connection)) return;
    this.lastClientActivityAt = this.deps.now();
    const message = classify(value);
    if (message.kind === "request") {
      this.receiveClientRequest(message.method, { client: connection, clientId: message.id, params: message.params });
    } else if (message.kind === "notification") {
      this.receiveClientNotification(connection, message.message);
    } else if (message.kind === "response") {
      this.answerPermission(connection, message.id, message.outcome);
    } else {
      connection.send(responseMessage(null, errorOutcome(ERROR_CODES.invalidRequest, "Invalid request")));
    }
    this.publishStatus();
  }

  /** A parsed message from the adapter. */
  handleAgentMessage(value: unknown): void {
    const message = classify(value);
    if (message.kind === "response") {
      this.receiveAgentResponse(message.id, message.outcome);
    } else if (message.kind === "request") {
      this.receiveAgentRequest(message.id, message.method, message.params);
    } else if (message.kind === "notification") {
      this.receiveAgentNotification(message.message);
    } else {
      this.deps.log("ignored an invalid message from the agent");
    }
    this.publishStatus();
  }

  status(): RelayStatus {
    const oldestPermission = this.permissions.values().next().value;
    return {
      heartbeatAt: this.deps.now(),
      state: this.state,
      error: this.error,
      acpSessionId: this.sessionId,
      turn: this.turn,
      clientConnected: this.clients.size > 0,
      lastClientActivityAt: this.lastClientActivityAt,
      lastTurnEndedAt: this.lastTurnEndedAt,
      pendingPermissionSince: oldestPermission?.receivedAt ?? null,
    };
  }

  /** Calls `onStatusChange` when the status differs from the last published one; the heartbeat does not count. */
  private publishStatus(): void {
    const status: Partial<RelayStatus> = this.status();
    delete status.heartbeatAt;
    const key = JSON.stringify(status);
    if (key === this.publishedStatus) return;
    this.publishedStatus = key;
    this.deps.onStatusChange();
  }

  /** Sends a request of the relay's own to the adapter; rejects with `failure` and the agent's error message. */
  private call(method: string, params: unknown, failure: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const settle = (outcome: Outcome) => (outcome.error ? reject(new Error(`${failure}: ${outcome.error.message}`)) : resolve(outcome.result));
      this.sendToAgent(method, params, { kind: "internal", settle });
    });
  }

  private sendToAgent(method: string, params: unknown, pending: AgentRequest): void {
    const id = this.nextAgentRequestId++;
    this.agentRequests.set(id, pending);
    this.deps.sendToAgent(requestMessage(id, method, params));
  }

  /** Takes the modes and config options of a `session/new` or `session/load` result. */
  private adoptSessionState(result: unknown): void {
    if (!isRecord(result)) return;
    this.modes = isRecord(result.modes) ? result.modes : null;
    this.configOptions = Array.isArray(result.configOptions) ? result.configOptions : null;
  }

  /** Applies the configured mode and config options; a value the agent rejects is logged and skipped. */
  private async restoreSettings(config: HuntSessionConfig): Promise<void> {
    const sessionId = this.sessionId;
    try {
      const modeUpdatesAtSend = this.modeUpdates;
      await this.call("session/set_mode", { sessionId, modeId: config.modeId }, `failed to set the mode ${config.modeId}`);
      this.noteMode(config.modeId, modeUpdatesAtSend);
    } catch (error) {
      this.deps.log(messageOf(error));
    }
    for (const [configId, value] of Object.entries(config.configOptions)) {
      try {
        const result = await this.call("session/set_config_option", { sessionId, configId, value }, `failed to set the config option ${configId} to ${value}`);
        this.noteConfigOptions(result);
      } catch (error) {
        this.deps.log(messageOf(error));
      }
    }
  }

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
    this.heldUpdates = null;
    this.deps.log(message);
    this.publishStatus();
    this.answerWaitingInitializes();
    this.answerWaitingLoads();
  }

  private failedOutcome(): Outcome {
    return errorOutcome(ERROR_CODES.internalError, this.error ?? "the relay failed to start");
  }

  /** Why a request for `params.sessionId` cannot be served now; null when it can. */
  private sessionProblem(params: unknown): Outcome | null {
    if (this.state === "failed") return this.failedOutcome();
    if (this.state === "starting") return errorOutcome(ERROR_CODES.internalError, "the agent session is still starting");
    const sessionId = isRecord(params) ? params.sessionId : undefined;
    if (sessionId === this.sessionId) return null;
    const message = `the relay serves the session ${this.sessionId}, not ${String(sessionId)}`;
    return errorOutcome(ERROR_CODES.invalidParams, message, { currentSessionId: this.sessionId });
  }

  /** Answers a client request, unless its client disconnected meanwhile. */
  private answer(request: ClientRequest, outcome: Outcome): void {
    if (!this.clients.has(request.client)) return;
    request.client.send(responseMessage(request.clientId, outcome));
  }

  /** Sends `message` to every client that loaded the session, except `exception`. */
  private broadcast(message: JsonRpcMessage, exception?: ClientConnection): void {
    for (const client of this.clients.values()) {
      if (client.isLoaded && client.connection !== exception) {
        client.connection.send(message);
      }
    }
  }

  private receiveClientRequest(method: string, request: ClientRequest): void {
    switch (method) {
      case "initialize":
        this.answerInitialize(request);
        break;
      case "session/load":
        this.answerLoad(request);
        break;
      case "session/prompt":
        this.enqueuePrompt(request);
        break;
      case "session/set_mode":
      case "session/set_config_option":
        this.forwardSetting(method, request);
        break;
      default:
        this.answer(request, errorOutcome(ERROR_CODES.methodNotFound, `Method not found: ${method}`));
    }
  }

  private receiveClientNotification(connection: ClientConnection, message: JsonRpcNotification): void {
    if (message.method === "session/cancel") {
      this.cancelPrompts(connection, message);
    } else if (message.method === "$/cancel_request") {
      this.cancelClientRequest(connection, message.params);
    } else {
      this.deps.log(`ignored the client notification ${message.method}`);
    }
  }

  /** Answers with the adapter's cached `initialize` result, once the start got it. */
  private answerInitialize(request: ClientRequest): void {
    if (this.initializeResult) {
      this.answer(request, { result: this.initializeResult });
    } else if (this.state === "failed") {
      this.answer(request, this.failedOutcome());
    } else {
      this.waitingInitializes.push(request);
    }
  }

  private answerWaitingInitializes(): void {
    const waiting = this.waitingInitializes;
    this.waitingInitializes = [];
    for (const request of waiting) {
      this.answerInitialize(request);
    }
  }

  /**
   * Replays the session to the client in one synchronous run, so no live update interleaves: the buffered history, the
   * response with the current modes and config options, the latest commands and usage, and the turn state. Open
   * permission requests the client did not get yet follow; from then on the client receives live updates. The client's
   * `cwd` and `_meta` are ignored: the session was set up from `hunt-session.json`.
   */
  private answerLoad(request: ClientRequest): void {
    if (this.state === "starting") {
      this.waitingLoads.push(request);
      return;
    }
    const client = this.clients.get(request.client);
    if (!client) return;
    const problem = this.sessionProblem(request.params);
    if (problem) {
      this.answer(request, problem);
      return;
    }
    for (const update of this.history) {
      client.connection.send(update);
    }
    this.answer(request, { result: { modes: this.modes, configOptions: this.configOptions } });
    if (this.latestCommands) {
      client.connection.send(this.latestCommands);
    }
    if (this.latestUsage) {
      client.connection.send(this.latestUsage);
    }
    client.connection.send(this.turnUpdate());
    client.isLoaded = true;
    for (const permission of this.permissions.values()) {
      if (!permission.forwardedTo.has(client.connection)) {
        this.forwardPermission(permission, client.connection);
      }
    }
  }

  private answerWaitingLoads(): void {
    const waiting = this.waitingLoads;
    this.waitingLoads = [];
    for (const request of waiting) {
      this.answerLoad(request);
    }
  }

  private enqueuePrompt(request: ClientRequest): void {
    const problem = this.sessionProblem(request.params);
    if (problem) {
      this.answer(request, problem);
      return;
    }
    this.queue.push(request);
    this.forwardNextPrompt();
  }

  /** Forwards the next queued prompt once the previous one is answered; the turn runs until its response. */
  private forwardNextPrompt(): void {
    if (this.activePrompt) return;
    const prompt = this.queue.shift();
    if (!prompt) return;
    this.activePrompt = prompt;
    this.recordPrompt(prompt);
    this.sendToAgent("session/prompt", prompt.params, { kind: "prompt", request: prompt });
    this.setTurn("running");
  }

  /**
   * Adds the prompt's content blocks to the history as `user_message_chunk`s, since the adapter does not echo prompts.
   * The loaded clients other than the sender get them live; the sender shows its prompt itself.
   */
  private recordPrompt(prompt: ClientRequest): void {
    const blocks = isRecord(prompt.params) && Array.isArray(prompt.params.prompt) ? prompt.params.prompt : [];
    for (const content of blocks) {
      const chunk = notificationMessage("session/update", { sessionId: this.sessionId, update: { sessionUpdate: "user_message_chunk", content } });
      this.history.push(chunk);
      this.broadcast(chunk, prompt.client);
    }
  }

  private finishPrompt(prompt: ClientRequest, outcome: Outcome): void {
    this.activePrompt = null;
    this.lastTurnEndedAt = this.deps.now();
    this.answer(prompt, outcome);
    this.forwardNextPrompt();
    if (!this.activePrompt) {
      this.setTurn("idle");
    }
  }

  /**
   * `session/cancel` from any client ends the running turn through the forwarded cancel, whoever sent its prompt. The
   * sender's queued prompts end as cancelled right away; those of other clients stay queued.
   */
  private cancelPrompts(connection: ClientConnection, message: JsonRpcNotification): void {
    if (this.sessionProblem(message.params)) return;
    const cancelled = this.queue.filter((prompt) => prompt.client === connection);
    this.queue = this.queue.filter((prompt) => prompt.client !== connection);
    for (const prompt of cancelled) {
      this.answer(prompt, CANCELLED);
    }
    this.deps.sendToAgent(message);
  }

  /** `$/cancel_request` from the client: a queued prompt ends as cancelled, a forwarded request gets the cancel under its relay ID. */
  private cancelClientRequest(connection: ClientConnection, params: unknown): void {
    if (!isRecord(params) || !isJsonRpcId(params.requestId)) return;
    const requestId = params.requestId;
    const queuedIndex = this.queue.findIndex((prompt) => prompt.client === connection && prompt.clientId === requestId);
    if (queuedIndex !== -1) {
      const [prompt] = this.queue.splice(queuedIndex, 1);
      this.answer(prompt, CANCELLED);
      return;
    }
    for (const [agentId, pending] of this.agentRequests) {
      if (pending.kind === "internal" || pending.request.client !== connection || pending.request.clientId !== requestId) continue;
      this.deps.sendToAgent(notificationMessage("$/cancel_request", { ...params, requestId: agentId }));
      return;
    }
  }

  private forwardSetting(method: string, request: ClientRequest): void {
    const problem = this.sessionProblem(request.params);
    if (problem) {
      this.answer(request, problem);
      return;
    }
    this.sendToAgent(method, request.params, { kind: "setting", method, request, modeUpdatesAtSend: this.modeUpdates });
  }

  /** Answers a forwarded `session/set_mode` or `session/set_config_option`; an accepted value updates the cache and the config file. */
  private finishSetting(pending: Extract<AgentRequest, { kind: "setting" }>, outcome: Outcome): void {
    const params = isRecord(pending.request.params) ? pending.request.params : {};
    if (!outcome.error && pending.method === "session/set_mode") {
      this.noteMode(params.modeId, pending.modeUpdatesAtSend);
      this.persistSetting(MODE_CONFIG_ID, params.modeId);
    } else if (!outcome.error) {
      this.noteConfigOptions(outcome.result);
      this.persistSetting(params.configId, params.value);
    }
    this.answer(pending.request, outcome);
  }

  /** Records a mode the agent accepted, unless the agent announced another mode after the request was sent. */
  private noteMode(modeId: unknown, modeUpdatesAtSend: number): void {
    if (!this.modes || typeof modeId !== "string" || this.modeUpdates !== modeUpdatesAtSend) return;
    this.modes = { ...this.modes, currentModeId: modeId };
  }

  private noteConfigOptions(result: unknown): void {
    if (isRecord(result) && Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions;
    }
  }

  /** Stores an accepted mode or config option value; only string values are stored, as `hunt-session.json` holds strings. */
  private persistSetting(configId: unknown, value: unknown): void {
    if (typeof configId !== "string" || typeof value !== "string") return;
    this.persist(configId === MODE_CONFIG_ID ? { modeId: value } : { configOptions: { [configId]: value } });
  }

  private persist(changes: ConfigChanges): void {
    try {
      this.deps.persistConfig(changes);
    } catch (error) {
      this.deps.log(`failed to update the session config: ${messageOf(error)}`);
    }
  }

  private receiveAgentResponse(id: JsonRpcId, outcome: Outcome): void {
    const pending = this.agentRequests.get(id);
    if (!pending) {
      this.deps.log(`ignored the agent's response to the unknown request ${id}`);
      return;
    }
    this.agentRequests.delete(id);
    if (pending.kind === "internal") {
      pending.settle(outcome);
    } else if (pending.kind === "prompt") {
      this.finishPrompt(pending.request, outcome);
    } else {
      this.finishSetting(pending, outcome);
    }
  }

  /**
   * Permission requests go to every loaded client, or wait for the next client's load; the adapter's other requests
   * are not offered by the relay.
   */
  private receiveAgentRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      this.deps.sendToAgent(responseMessage(id, errorOutcome(ERROR_CODES.methodNotFound, `Method not found: ${method}`)));
      return;
    }
    const permission: PendingPermission = { agentId: id, params, receivedAt: this.deps.now(), forwardedTo: new Map() };
    this.permissions.set(id, permission);
    for (const client of this.clients.values()) {
      if (client.isLoaded) {
        this.forwardPermission(permission, client.connection);
      }
    }
  }

  private forwardPermission(permission: PendingPermission, connection: ClientConnection): void {
    const clientId = this.nextClientRequestId++;
    permission.forwardedTo.set(connection, clientId);
    connection.send(requestMessage(clientId, "session/request_permission", permission.params));
  }

  /**
   * The first client's answer to a forwarded permission request goes to the adapter under the adapter's request ID;
   * the other clients that got the request get a `$/cancel_request` for it. A later answer to a request the relay
   * forwarded, which another client answered or the adapter withdrew meanwhile, is ignored.
   */
  private answerPermission(connection: ClientConnection, clientId: JsonRpcId, outcome: Outcome): void {
    for (const permission of this.permissions.values()) {
      if (permission.forwardedTo.get(connection) !== clientId) continue;
      this.permissions.delete(permission.agentId);
      this.deps.sendToAgent(responseMessage(permission.agentId, outcome));
      permission.forwardedTo.delete(connection);
      this.withdrawFromClients(permission);
      return;
    }
    if (typeof clientId === "number" && clientId < this.nextClientRequestId) return;
    this.deps.log(`ignored the client's response to the unknown request ${clientId}`);
  }

  /** Sends a `$/cancel_request` for the permission request to every client that got it, under the client's ID. */
  private withdrawFromClients(permission: PendingPermission): void {
    for (const [connection, clientId] of permission.forwardedTo) {
      connection.send(notificationMessage("$/cancel_request", { requestId: clientId }));
    }
  }

  /** Notifications without a session, such as `_auth/status_update`, are not relayed. */
  private receiveAgentNotification(message: JsonRpcNotification): void {
    if (message.method === "session/update") {
      this.recordUpdate(message);
    } else if (message.method === "$/cancel_request") {
      this.withdrawPermission(message.params);
    }
  }

  /**
   * Buffers an update of the relay's session and passes it to the loaded clients. Commands and usage keep only their
   * latest update, mode and config option updates only the state they carry; updates of other sessions are dropped.
   */
  private recordUpdate(message: JsonRpcNotification): void {
    const params = message.params;
    if (!isRecord(params) || !isRecord(params.update)) return;
    if (!this.sessionId) {
      this.heldUpdates?.push(message);
      return;
    }
    if (params.sessionId !== this.sessionId) return;
    const update = params.update;
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.latestCommands = message;
        break;
      case "usage_update":
        this.latestUsage = message;
        break;
      case "current_mode_update":
        this.modeUpdates++;
        if (this.modes && typeof update.currentModeId === "string") {
          this.modes = { ...this.modes, currentModeId: update.currentModeId };
        }
        break;
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions;
        }
        break;
      default:
        this.history.push(message);
    }
    this.broadcast(message);
  }

  private releaseHeldUpdates(): void {
    const held = this.heldUpdates ?? [];
    this.heldUpdates = null;
    for (const message of held) {
      this.recordUpdate(message);
    }
  }

  /**
   * `$/cancel_request` from the adapter withdraws a permission request: every client that got it gets the cancel under
   * its ID, the adapter a -32800 answer.
   */
  private withdrawPermission(params: unknown): void {
    if (!isRecord(params) || !isJsonRpcId(params.requestId)) return;
    const permission = this.permissions.get(params.requestId);
    if (!permission) return;
    this.permissions.delete(permission.agentId);
    this.withdrawFromClients(permission);
    this.deps.sendToAgent(responseMessage(permission.agentId, errorOutcome(ERROR_CODES.requestCancelled, "Request cancelled")));
  }

  /**
   * Drops the requests a client that is gone still waits for. Its queued prompts still run; an open permission request
   * stays with the other clients that got it, or goes to the next client's load.
   */
  private detach(connection: ClientConnection): void {
    this.waitingInitializes = this.waitingInitializes.filter((request) => request.client !== connection);
    this.waitingLoads = this.waitingLoads.filter((request) => request.client !== connection);
    for (const permission of this.permissions.values()) {
      permission.forwardedTo.delete(connection);
    }
  }

  private setTurn(turn: TurnState): void {
    if (this.turn === turn) return;
    this.turn = turn;
    this.broadcast(this.turnUpdate());
  }

  /** The `session_info_update` that tells a client whether a turn is running. */
  private turnUpdate(): JsonRpcNotification {
    return notificationMessage("session/update", {
      sessionId: this.sessionId,
      update: { sessionUpdate: "session_info_update", _meta: { hunt: { turn: this.turn } } },
    });
  }
}

/** The adapter's `initialize` result without the session capabilities the relay does not serve. */
export function withoutUnsupportedCapabilities(result: Record<string, unknown>): Record<string, unknown> {
  const agentCapabilities = result.agentCapabilities;
  if (!isRecord(agentCapabilities) || !isRecord(agentCapabilities.sessionCapabilities)) return result;
  const sessionCapabilities = { ...agentCapabilities.sessionCapabilities };
  for (const capability of UNSUPPORTED_SESSION_CAPABILITIES) {
    delete sessionCapabilities[capability];
  }
  return { ...result, agentCapabilities: { ...agentCapabilities, sessionCapabilities } };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
