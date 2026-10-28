/**
 * A stand-in for `claude-agent-acp` in the relay's integration test and for trying the relay by hand. It answers the
 * relay's requests with canned results, replays one message on `session/load`, echoes prompts, asks for a permission
 * when a prompt is "ask", appends every message it receives to the JSONL file `$FAKE_ADAPTER_LOG` and exits when its
 * stdin closes.
 */
import { appendFileSync } from "node:fs";
import { createLineDecoder } from "../../../../../libs/domain/src/shared/ndjson.utils.ts";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "bypassPermissions", name: "Bypass permissions" },
  ],
};
const PERMISSION_REQUEST_ID = "permission-1";

let configOptions = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "opus", name: "Opus" },
    ],
  },
];
/** The prompt waiting for the answer to the permission request, as request ID and session ID. */
let promptAwaitingPermission: { id: number | string; sessionId: string } | null = null;

function record(entry: unknown): void {
  const path = process.env.FAKE_ADAPTER_LOG;
  if (path) {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function sendUpdate(sessionId: string, update: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update } });
}

/** Sends the commands right after the setup response; the real adapter sends them a tick later, which would make the test's message order depend on timing. */
function sendCommands(sessionId: string): void {
  sendUpdate(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] });
}

function handle(message: Message): void {
  record(message);
  const { id, method, params = {} } = message;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "acp-new";
  if (!method) {
    if (id !== PERMISSION_REQUEST_ID || !promptAwaitingPermission) return;
    const outcome = message.result?.outcome as { optionId?: string } | undefined;
    sendUpdate(promptAwaitingPermission.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `allowed: ${outcome?.optionId}` } });
    send({ id: promptAwaitingPermission.id, result: { stopReason: "end_turn" } });
    promptAwaitingPermission = null;
    return;
  }
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, delete: {}, fork: {}, list: {}, resume: {} } },
          agentInfo: { name: "fake-adapter", version: "0.0.0" },
          authMethods: [],
        },
      });
      send({ method: "_auth/status_update", params: { status: "signedIn" } });
      break;
    case "session/load":
      sendUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } });
      send({ id, result: { modes: MODES, configOptions } });
      sendCommands(sessionId);
      break;
    case "session/new":
      send({ id, result: { sessionId, modes: MODES, configOptions } });
      sendCommands(sessionId);
      break;
    case "session/set_mode":
      send({ id, result: {} });
      break;
    case "session/set_config_option":
      configOptions = configOptions.map((option) => (option.id === params.configId ? { ...option, currentValue: String(params.value) } : option));
      send({ id, result: { configOptions } });
      break;
    case "session/prompt": {
      const blocks = Array.isArray(params.prompt) ? (params.prompt as { text?: string }[]) : [];
      const text = blocks[0]?.text ?? "";
      if (text === "ask" && id !== undefined) {
        promptAwaitingPermission = { id, sessionId };
        const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
        send({ id: PERMISSION_REQUEST_ID, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tool-1" }, options } });
        break;
      }
      sendUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } });
      send({ id, result: { stopReason: "end_turn" } });
      break;
    }
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

const lines = createLineDecoder((line) => handle(JSON.parse(line) as Message));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => lines.push(chunk));
process.stdin.on("end", () => {
  record({ event: "stdin closed" });
  process.exit(0);
});
