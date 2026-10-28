/**
 * The forwarder of the gateway API (`gateway-api/gateway-api.service.ts`), which `hunt-api <method>` (`vm/hunt-api`) runs as hunt-gw through sudo:
 *
 *   node /srv/hunt/current/gateway/apiClient.mjs <method>      (the request's params as one JSON object on stdin)
 *
 * It sends `{caller, method, params}` over the API's socket, which only hunt-gw can open, with sudo's SUDO_USER as the
 * caller, and copies the NDJSON events of the answer to stdout. It exits 0 after a `result` and 1 after an `error`,
 * which it writes itself when the request cannot be sent or the API ends the connection early. A socket that is missing
 * or refuses connections is retried for a while, since the API restarts with every install.
 */
import { readFileSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { ApiEvent, ErrorCode } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import { createLineDecoder, encodeLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";
import { encodeEvent, isFinalEvent, MAX_REQUEST_BYTES, METHOD_PATTERN, parseEvent, SOCKET_PATH } from "./gateway-api-protocol.utils.ts";

const CONNECT_WAIT_MS = 30_000;
const CONNECT_RETRY_MS = 500;

export interface ForwardOptions {
  socketPath: string;
  caller: string;
  method: string;
  /** The text on stdin: the params as one JSON object, or nothing for none. */
  input: string;
  write(text: string): void;
  /** How long a missing or refusing socket is retried. */
  connectWaitMs?: number;
}

function open(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Connects to `socketPath`, retrying a socket that is missing or refuses connections for `waitMs`. */
async function connectWithRetry(socketPath: string, waitMs: number): Promise<Socket> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await open(socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ECONNREFUSED") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

/** Sends one request and copies its events to `write`; resolves with the exit status. */
export async function forward(options: ForwardOptions): Promise<number> {
  const fail = (code: ErrorCode, message: string) => {
    options.write(encodeEvent({ type: "error", code, message }));
    return 1;
  };
  if (!METHOD_PATTERN.test(options.method)) return fail("invalidParams", `usage: hunt-api <method>; ${JSON.stringify(options.method)} is no method`);
  if (Buffer.byteLength(options.input) > MAX_REQUEST_BYTES) return fail("invalidParams", `the params are longer than ${MAX_REQUEST_BYTES} bytes`);
  let params: unknown = {};
  if (options.input.trim()) {
    try {
      params = JSON.parse(options.input);
    } catch {
      return fail("invalidParams", "stdin holds no JSON object");
    }
  }
  let socket: Socket;
  try {
    socket = await connectWithRetry(options.socketPath, options.connectWaitMs ?? CONNECT_WAIT_MS);
  } catch (error) {
    return fail("unavailable", `failed to reach the gateway API on ${options.socketPath}: ${messageOf(error)}`);
  }
  return new Promise((resolve) => {
    let final: ApiEvent | null = null;
    const decoder = createLineDecoder((line) => {
      if (final) return;
      options.write(`${line}\n`);
      const event = parseEvent(line);
      if (event && isFinalEvent(event)) {
        final = event;
      }
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => decoder.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!final) {
        resolve(fail("unavailable", "the gateway API ended the connection before its result"));
        return;
      }
      resolve(final.type === "result" ? 0 : 1);
    });
    socket.write(encodeLine({ caller: options.caller, method: options.method, params }));
  });
}

async function main(): Promise<void> {
  const write = (text: string) => {
    process.stdout.write(text);
  };
  if (process.argv.length !== 3) {
    process.exitCode = await forward({ socketPath: SOCKET_PATH, caller: "", method: "", input: "", write });
    return;
  }
  let input: string;
  try {
    input = readFileSync(0, "utf8");
  } catch (error) {
    write(encodeEvent({ type: "error", code: "invalidParams", message: `failed to read stdin: ${messageOf(error)}` }));
    process.exitCode = 1;
    return;
  }
  const caller = process.env.SUDO_USER || userInfo().username;
  process.exitCode = await forward({ socketPath: SOCKET_PATH, caller, method: process.argv[2], input, write });
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
