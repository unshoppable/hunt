/**
 * hunt-swf's ACP client for the first prompt of a session: it connects to the session's relay like Hunt does (NDJSON
 * over `socat - UNIX-CONNECT:/run/hunt/relay.sock`), loads the relay's session, sends one `session/prompt` and
 * disconnects once the relay has taken the prompt, without waiting for the turn. The relay keeps running the prompts of
 * a client that disconnected (see `detach` in `apps/session/src/relay/relay.ts`).
 */
import { classify, isRecord, requestMessage, type JsonRpcError, type JsonRpcId, type JsonRpcMessage } from "../../../libs/domain/src/jsonRpc.ts";
import { createLineDecoder, encodeLine, parseLine } from "../../../libs/domain/src/ndjson.ts";

const CLIENT_INFO = { name: "hunt-swf", version: "1" };
export const STEP_TIMEOUT_MS = 60_000;

/** A byte stream to the relay, such as the stdio of `gcloud compute ssh … socat`. */
export interface Transport {
  write(text: string): void;
  /** Registers the receiver of the text that arrives. */
  onData(listener: (text: string) => void): void;
  /** Registers the receiver of the end of the stream, with the reason when it failed. */
  onClose(listener: (reason?: string) => void): void;
  close(): void;
}

export interface PromptRequest {
  /** The ACP session the relay serves (`acpSessionId` of `hunt-ctl wait`). */
  sessionId: string;
  cwd: string;
  text: string;
  timeoutMs?: number;
}

/** How the relay took the prompt: a turn started with it, or it waits behind a turn that runs already. */
export type PromptOutcome = "started" | "queued";

type Waiter = { isDone(message: JsonRpcMessage): boolean; resolve(message: JsonRpcMessage): void };

/** The turn state of a relay `session_info_update` (`_meta.hunt.turn`); undefined for any other message. */
export function turnOf(message: JsonRpcMessage): unknown {
  if (!("method" in message) || message.method !== "session/update" || !isRecord(message.params)) return undefined;
  const update = message.params.update;
  if (!isRecord(update) || update.sessionUpdate !== "session_info_update" || !isRecord(update._meta)) return undefined;
  return isRecord(update._meta.hunt) ? update._meta.hunt.turn : undefined;
}

function responseTo(id: JsonRpcId): (message: JsonRpcMessage) => boolean {
  return (message) => !("method" in message) && "id" in message && message.id === id;
}

/** Sends `request.text` as a prompt to the relay behind `transport` and closes the transport; see the module comment. */
export async function sendPrompt(transport: Transport, request: PromptRequest): Promise<PromptOutcome> {
  const timeoutMs = request.timeoutMs ?? STEP_TIMEOUT_MS;
  const received: JsonRpcMessage[] = [];
  let waiter: Waiter | null = null;
  let closed: string | null = null;
  let failClosed: (reason: string) => void = () => {};

  const lines = createLineDecoder((line) => {
    const value = parseLine(line);
    if (value === undefined || classify(value).kind === "invalid") return;
    const message = value as JsonRpcMessage;
    if (waiter?.isDone(message)) {
      const current = waiter;
      waiter = null;
      current.resolve(message);
      return;
    }
    received.push(message);
  });
  transport.onData((text) => lines.push(text));
  transport.onClose((reason) => {
    closed = reason ? `the connection to the relay closed: ${reason}` : "the connection to the relay closed";
    failClosed(closed);
  });

  /** The first message, received already or arriving within the timeout, that `isDone` accepts. */
  function waitFor(isDone: (message: JsonRpcMessage) => boolean, what: string): Promise<JsonRpcMessage> {
    const index = received.findIndex(isDone);
    if (index !== -1) return Promise.resolve(received.splice(index, 1)[0]);
    if (closed) return Promise.reject(new Error(`failed to ${what}: ${closed}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error(`failed to ${what}: the relay did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      waiter = {
        isDone,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      failClosed = (reason) => {
        clearTimeout(timer);
        waiter = null;
        reject(new Error(`failed to ${what}: ${reason}`));
      };
    });
  }

  async function call(id: JsonRpcId, method: string, params: unknown, what: string): Promise<unknown> {
    transport.write(encodeLine(requestMessage(id, method, params)));
    const response = await waitFor(responseTo(id), what);
    const error = (response as { error?: JsonRpcError }).error;
    if (error) throw new Error(`failed to ${what}: ${error.message}`);
    return (response as { result?: unknown }).result;
  }

  try {
    await call(1, "initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: CLIENT_INFO }, "initialize the relay connection");
    await call(2, "session/load", { sessionId: request.sessionId, cwd: request.cwd, mcpServers: [] }, `load the session ${request.sessionId}`);
    // The relay ends every load with the turn state.
    const turn = turnOf(await waitFor((message) => turnOf(message) !== undefined, "read the turn state"));
    received.length = 0;

    transport.write(encodeLine(requestMessage(3, "session/prompt", { sessionId: request.sessionId, prompt: [{ type: "text", text: request.text }] })));
    if (turn === "running") {
      // The prompt waits in the relay's queue; nothing reports that until its turn ends. A request with a later ID that
      // the relay answers at once proves that it read the prompt before.
      transport.write(encodeLine(requestMessage(4, "ping", {})));
      const answer = await waitFor((message) => responseTo(3)(message) || responseTo(4)(message), "send the prompt");
      const error = (answer as { id: JsonRpcId; error?: JsonRpcError }).id === 3 ? (answer as { error?: JsonRpcError }).error : undefined;
      if (error) throw new Error(`failed to send the prompt: ${error.message}`);
      return "queued";
    }
    const started = await waitFor((message) => turnOf(message) === "running" || responseTo(3)(message), "send the prompt");
    const error = (started as { error?: JsonRpcError }).error;
    if (error) throw new Error(`failed to send the prompt: ${error.message}`);
    return "started";
  } finally {
    transport.close();
  }
}
