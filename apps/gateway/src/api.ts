/**
 * hunt-api on the gateway (`hunt-api.service`, user hunt-gw): the gateway API of `libs/domain/src/gatewayApi.ts`, the
 * control plane of remote sessions.
 *
 *   node /srv/hunt/current/gateway/api.mjs      (listens on /run/hunt-api/api.sock)
 *
 * People reach it over SSH as `hunt-api <method>`: sshd forces that command on everyone outside google-sudoers
 * (`vm/hunt-api`), which runs the forwarder `apiClient.ts` as hunt-gw through sudo. The forwarder sends one line
 * `{caller, method, params}` over the socket, which only hunt-gw can open, with sudo's SUDO_USER as the caller, and
 * copies the NDJSON events of the answer to stdout. The methods that touch session VMs go through the orchestrator
 * (`orchestrator.ts`) and run on when their caller disconnects. A request's log lines and its outcome, every Compute
 * Engine call and every command on a session VM go to the journal (`journal.ts`).
 * SIGHUP (the unit's reload, after an install) closes the socket and exits once the running requests ended, so that
 * systemd starts the new release. Runs on Node 24 through type stripping; no dependencies.
 */
import { chmodSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import protocolFile from "../../../libs/domain/protocol.json" with { type: "json" };
import { messageOf } from "../../../libs/domain/src/errors.ts";
import type { ApiEvent, HelloResult } from "../../../libs/domain/src/gatewayApi.ts";
import type { LogLevel } from "../../../libs/domain/src/journal.ts";
import { ApiError, encodeEvent, errorEvent, MAX_REQUEST_BYTES, parseRequest, SOCKET_PATH, type ApiRequest } from "./apiProtocol.ts";
import { createCompute, createMetadata } from "./gcp.ts";
import { writeLog } from "./journal.ts";
import { DEFAULT_TEMPLATE, Orchestrator, type Reporter } from "./orchestrator.ts";
import { readDomain } from "./previewDomain.ts";
import { ensureSshKey, sessionVm } from "./sessionVm.ts";

const RELEASE_VERSION_FILE = "/srv/hunt/current/.version";
/** How long a connection may take to send its request line. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What `hello` reports about the gateway besides the protocol numbers and the caller. */
export interface GatewayInfo {
  release: string;
  project: string;
  zone: string;
  previewDomain: string;
}

export interface ApiDeps {
  orchestrator: Pick<Orchestrator, "provision" | "start" | "stop" | "delete" | "get" | "listSessions">;
  gatewayInfo(): Promise<GatewayInfo>;
  log(message: string, level?: LogLevel): void;
}

/** Runs one request; its result is the `data` of the `result` event. */
export async function dispatch(deps: ApiDeps, request: ApiRequest, reporter: Reporter): Promise<unknown> {
  switch (request.method) {
    case "hello": {
      const result: HelloResult = { api: protocolFile.api, protocol: protocolFile.protocol, ...(await deps.gatewayInfo()), caller: request.caller };
      return result;
    }
    case "sessions.list":
      return { sessions: await deps.orchestrator.listSessions() };
    case "vms.get":
      return deps.orchestrator.get(request.params.id);
    case "sessions.provision":
      return deps.orchestrator.provision(
        { ...request.params, issue: null, origin: "desktop", owner: request.caller, template: DEFAULT_TEMPLATE, machineType: null },
        reporter,
      );
    case "vms.start":
      return deps.orchestrator.start(request.params.id, reporter);
    case "vms.stop":
      await deps.orchestrator.stop(request.params.id);
      return {};
    case "vms.delete":
      return deps.orchestrator.delete(request.params.id);
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

/** `method` and the session ID of a request, for the log. */
function describeRequest(request: ApiRequest): string {
  return "id" in request.params ? `${request.method} ${request.params.id}` : request.method;
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

function readRelease(): string {
  try {
    return readFileSync(RELEASE_VERSION_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const log = writeLog;
  ensureSshKey("hunt-api");
  const metadata = createMetadata();
  const location = { project: await metadata.project(), zone: await metadata.zone() };
  const compute = createCompute(metadata, fetch, log);
  const orchestrator = new Orchestrator({
    compute,
    location,
    vm: (name) => sessionVm(name, location, log),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
  const api = createApiServer({
    orchestrator,
    gatewayInfo: async () => ({ release: readRelease(), ...location, previewDomain: readDomain() }),
    log,
  });

  // Only hunt-gw opens the socket; the forwarder runs as hunt-gw.
  process.umask(0o077);
  rmSync(SOCKET_PATH, { force: true });
  api.server.on("error", (error) => {
    log(`failed to serve ${SOCKET_PATH}: ${error.message}`, "fatal");
    process.exit(1);
  });
  api.server.listen(SOCKET_PATH, () => {
    chmodSync(SOCKET_PATH, 0o600);
    log(`listening on ${SOCKET_PATH} for ${location.project}/${location.zone}`);
  });
  process.on("SIGHUP", () => {
    log("reload: exiting once the running requests ended");
    void api.drain().then(() => process.exit(0));
  });
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    writeLog(messageOf(error), "fatal");
    process.exit(1);
  });
}
