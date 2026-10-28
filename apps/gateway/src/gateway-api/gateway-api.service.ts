/**
 * The server of the gateway API (`libs/domain/src/gateway-api/gateway-api.types.ts`), which hunt-api (`gateway-api/gateway-api.main.ts`)
 * serves on its Unix socket. Each connection sends one request line `{caller, method, params}` (`gateway-api/gateway-api-protocol.utils.ts`)
 * and gets the NDJSON events of the answer. The methods that touch session VMs go through the session VM service
 * (`session-vm/session-vm.service.ts`) with the session ID of their params and run on when their caller disconnects;
 * the `secrets.*` methods change the remote secrets in Secret Manager (`remote-secrets/remote-secrets.service.ts`).
 * A request's log lines and its outcome go to the log of its ApiDeps.
 */
import { createServer, type Server, type Socket } from "node:net";
import protocolFile from "../../../../libs/domain/protocol.json" with { type: "json" };
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { ApiEvent, HelloResult } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import type { LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import { encodeEvent, errorEvent, MAX_REQUEST_BYTES, parseRequest, type ApiRequest } from "./gateway-api-protocol.utils.ts";
import { DEFAULT_TEMPLATE, type Reporter, type SessionVmService } from "../session-vm/session-vm.service.ts";
import type { RemoteSecretStore } from "../remote-secrets/remote-secrets.service.ts";

/** How long a connection may take to send its request line. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What `hello` reports about the gateway besides the protocol numbers and the caller. */
interface GatewayInfo {
  release: string;
  project: string;
  zone: string;
  previewDomain: string;
}

interface ApiDeps {
  sessionVmService: Pick<SessionVmService, "provision" | "start" | "stop" | "delete" | "get" | "listSessions">;
  secrets: Pick<RemoteSecretStore, "list" | "set" | "delete">;
  gatewayInfo(): Promise<GatewayInfo>;
  log(message: string, level?: LogLevel): void;
}

/** Runs one request; its result is the `data` of the `result` event. */
async function dispatch(deps: ApiDeps, request: ApiRequest, reporter: Reporter): Promise<unknown> {
  switch (request.method) {
    case "hello": {
      const result: HelloResult = { api: protocolFile.api, protocol: protocolFile.protocol, ...(await deps.gatewayInfo()), caller: request.caller };
      return result;
    }
    case "sessions.list":
      return { sessions: await deps.sessionVmService.listSessions() };
    case "vms.get":
      return deps.sessionVmService.get(request.params.sessionId);
    case "sessions.provision": {
      const { sessionId, title, repo, branch, machineType } = request.params;
      return deps.sessionVmService.provision(
        { sessionId, title, repo, branch, issue: null, origin: "desktop", owner: request.caller, template: DEFAULT_TEMPLATE, machineType },
        reporter,
      );
    }
    case "vms.start":
      return deps.sessionVmService.start(request.params.sessionId, reporter);
    case "vms.stop":
      await deps.sessionVmService.stop(request.params.sessionId);
      return {};
    case "vms.delete":
      return deps.sessionVmService.delete(request.params.sessionId);
    case "secrets.list":
      return { secrets: await deps.secrets.list() };
    case "secrets.set":
      await deps.secrets.set(request.params.secret);
      return {};
    case "secrets.delete":
      return { existed: await deps.secrets.delete(request.params.name) };
  }
}

/** The first line the connection sends; an ApiError when it sends none in time or too much. */
function readRequestLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const finish = (error: Error | null, line = "") => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      if (error) {
        reject(error);
      } else {
        resolve(line);
      }
    };
    const onData = (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) return finish(null, buffered.slice(0, newline));
      if (Buffer.byteLength(buffered) > MAX_REQUEST_BYTES) finish(new ApiError("invalidParams", `the request is longer than ${MAX_REQUEST_BYTES} bytes`));
    };
    const onEnd = () => finish(buffered.trim() ? null : new ApiError("invalidParams", "the connection ended without a request"), buffered);
    const timer = setTimeout(() => finish(new ApiError("invalidParams", `no request within ${REQUEST_TIMEOUT_MS / 1000} seconds`)), REQUEST_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("end", onEnd);
  });
}

/** `method` and the session ID or secret name of a request, for the log; never a secret's value. */
function describeRequest(request: ApiRequest): string {
  const { params } = request;
  if ("sessionId" in params) return `${request.method} ${params.sessionId.id}`;
  if ("secret" in params) return `${request.method} ${params.secret.name}`;
  if ("name" in params) return `${request.method} ${params.name}`;
  return request.method;
}

/** Answers one connection: reads its request, streams the events and ends it. */
async function serve(deps: ApiDeps, socket: Socket): Promise<void> {
  socket.on("error", () => {});
  const write = (event: ApiEvent) => {
    if (socket.writable) {
      socket.write(encodeEvent(event));
    }
  };
  let request: ApiRequest;
  try {
    request = parseRequest(await readRequestLine(socket));
  } catch (error) {
    const event = errorEvent(error);
    write(event);
    socket.end();
    if (event.type === "error") {
      deps.log(`refused a request: ${event.code}: ${event.message}`, "warn");
    }
    return;
  }
  const reporter: Reporter = {
    progress: (step) => write({ type: "progress", step }),
    log: (message) => {
      write({ type: "log", message });
      deps.log(`${request.caller}: ${describeRequest(request)}: ${message}`);
    },
  };
  const startedAt = Date.now();
  try {
    const data = await dispatch(deps, request, reporter);
    write({ type: "result", data });
    deps.log(`${request.caller}: ${describeRequest(request)}: ok in ${Date.now() - startedAt} ms`);
  } catch (error) {
    const event = errorEvent(error);
    write(event);
    if (event.type === "error") {
      deps.log(`${request.caller}: ${describeRequest(request)}: ${event.code}: ${event.message}`, "error");
    }
  }
  socket.end();
}

export interface ApiServer {
  server: Server;
  /** Stops accepting connections and waits until the running requests ended. */
  drain(): Promise<void>;
}

export function createApiServer(deps: ApiDeps): ApiServer {
  const running = new Set<Promise<void>>();
  // Half-open: a client may end its side after the request and still read the events.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const served = serve(deps, socket).catch((error: unknown) => {
      deps.log(`failed to serve a connection: ${messageOf(error)}`, "error");
      socket.destroy();
    });
    running.add(served);
    void served.finally(() => running.delete(served));
  });
  return {
    server,
    async drain() {
      server.close();
      while (running.size > 0) {
        await Promise.all(running);
      }
    },
  };
}
