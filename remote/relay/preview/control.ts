/**
 * The supervisor's control socket `preview.sock` in the socket directory (mode 0600): one NDJSON request per
 * connection, answered with one JSON line, after which the server ends the connection. `hunt-ctl` applies and stops
 * plans through it, `hunt-preview` (`cli.ts`) controls single processes.
 *
 *   {"op":"apply","plan":{…},"dataGeneration":"3"}     → {"ok":true,"status":{…}}  at once; the start runs on
 *   {"op":"stop"}                                      → {"ok":true,"status":{…}}  once every process is gone
 *   {"op":"start"|"stop"|"restart","process":"web"}    → {"ok":true,"status":{…}}  start answers at once, stop and
 *                                                                                    restart once the process is down
 *   {"op":"status"}                                    → {"ok":true,"status":{…}}
 *   any failure                                        → {"ok":false,"error":"…"}
 *
 * `status` is what `preview.json` holds (see `PreviewStatus`); after an apply its `generation` identifies that apply.
 */
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isRecord } from "../jsonRpc.ts";
import { encodeLine, parseLine } from "../ndjson.ts";
import { messageOf } from "../relay.ts";
import { isName, parsePlan, type PreviewPlan } from "./contract.ts";
import type { PreviewStatus } from "./supervisor.ts";

const SOCKET_MODE = 0o600;
const MAX_REQUEST_LENGTH = 1024 * 1024;
/** How long a client may take to send its request. */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DATA_GENERATION_LENGTH = 128;

/** What the socket controls; `PreviewSupervisor` in production. */
export interface ControlTarget {
  apply(plan: PreviewPlan, dataGeneration: string): PreviewStatus;
  stop(): Promise<PreviewStatus>;
  startProcess(name: string): PreviewStatus;
  stopProcess(name: string): Promise<PreviewStatus>;
  restartProcess(name: string): Promise<PreviewStatus>;
  status(): PreviewStatus;
}

export type ControlResponse = { ok: true; status: PreviewStatus } | { ok: false; error: string };

/** Carries out one parsed request; never rejects. */
export async function handleControlRequest(target: ControlTarget, request: unknown): Promise<ControlResponse> {
  try {
    return { ok: true, status: await perform(target, request) };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

async function perform(target: ControlTarget, request: unknown): Promise<PreviewStatus> {
  if (!isRecord(request) || typeof request.op !== "string") throw new Error('expected a JSON object with an "op"');
  switch (request.op) {
    case "status":
      expectFields(request, []);
      return target.status();
    case "apply":
      expectFields(request, ["plan", "dataGeneration"]);
      return target.apply(parsePlan(request.plan), dataGenerationOf(request.dataGeneration));
    case "stop":
      if (request.process === undefined) {
        expectFields(request, []);
        return target.stop();
      }
      expectFields(request, ["process"]);
      return target.stopProcess(processNameOf(request.process));
    case "start":
      expectFields(request, ["process"]);
      return target.startProcess(processNameOf(request.process));
    case "restart":
      expectFields(request, ["process"]);
      return target.restartProcess(processNameOf(request.process));
    default:
      throw new Error(`unknown op ${JSON.stringify(request.op)}; expected apply, stop, start, restart or status`);
  }
}

function expectFields(request: Record<string, unknown>, fields: string[]): void {
  const unknown = Object.keys(request).filter((key) => key !== "op" && !fields.includes(key));
  if (unknown.length > 0) throw new Error(`unknown field ${unknown[0]} in a ${String(request.op)} request`);
}

function processNameOf(value: unknown): string {
  if (typeof value !== "string" || !isName(value)) throw new Error('"process" must be the name of a process');
  return value;
}

function dataGenerationOf(value: unknown): string {
  const isValid = typeof value === "string" && value.length > 0 && value.length <= MAX_DATA_GENERATION_LENGTH && !/[\n\r\0]/.test(value);
  if (!isValid) throw new Error(`"dataGeneration" must be a single-line string of 1 to ${MAX_DATA_GENERATION_LENGTH} characters`);
  return value;
}

/** Serves `target` on the Unix socket `path`, replacing a stale socket file; a listen failure is logged. */
export function serveControl(path: string, target: ControlTarget, log: (message: string) => void): Server {
  rmSync(path, { force: true });
  const server = createServer({ allowHalfOpen: true }, (socket) => serveConnection(socket, target, log));
  server.on("error", (error) => log(`failed to serve ${path}: ${error.message}`));
  server.listen(path, () => {
    try {
      chmodSync(path, SOCKET_MODE);
    } catch (error) {
      log(`failed to restrict ${path} to its owner: ${messageOf(error)}`);
    }
  });
  return server;
}

/** Reads one request line, or what came before the client's half-close, and answers it. */
function serveConnection(socket: Socket, target: ControlTarget, log: (message: string) => void): void {
  socket.setEncoding("utf8");
  let received = "";
  let isAnswered = false;
  const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
  const answer = (response: Promise<ControlResponse>) => {
    isAnswered = true;
    clearTimeout(timer);
    void response.then((value) => {
      if (!socket.destroyed) {
        socket.end(encodeLine(value));
      }
    });
  };
  const handleLine = (line: string) => {
    const request = parseLine(line);
    answer(request === undefined ? Promise.resolve({ ok: false, error: "the request is not JSON" }) : handleControlRequest(target, request));
  };
  socket.on("data", (chunk: string) => {
    if (isAnswered) return;
    received += chunk;
    const newline = received.indexOf("\n");
    if (newline !== -1) {
      handleLine(received.slice(0, newline));
    } else if (received.length > MAX_REQUEST_LENGTH) {
      answer(Promise.resolve({ ok: false, error: `the request is longer than ${MAX_REQUEST_LENGTH} characters` }));
    }
  });
  socket.on("end", () => {
    if (!isAnswered) {
      handleLine(received);
    }
  });
  socket.on("close", () => clearTimeout(timer));
  socket.on("error", (error) => log(`a control connection failed: ${error.message}`));
}

/** Sends one request to the control socket at `path` and resolves with the parsed answer. */
export function sendControlRequest(path: string, request: unknown, timeoutMs = 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${path} within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encodeLine(request)));
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`failed to reach ${path}: ${error.message}`));
    });
    socket.once("close", () => {
      clearTimeout(timer);
      const answer = parseLine(received.split("\n")[0]);
      if (answer === undefined) {
        reject(new Error(`${path} closed the connection without an answer`));
      } else {
        resolve(answer);
      }
    });
  });
}
