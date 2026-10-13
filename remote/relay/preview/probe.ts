/**
 * The readiness check of a preview process: it accepts a TCP connection on its port at the session container's address,
 * which the edge proxy dials, and when it has a `ready` path, a GET of that path answers with a status below 500. HTTPS
 * is not verified: dev servers sign their own certificates.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import type { Protocol } from "./contract.ts";

const LOOPBACK = "127.0.0.1";
const CONNECT_TIMEOUT_MS = 2_000;
/** Dev servers often build a page on its first request, so the answer may take a while. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface ProbeTarget {
  port: number | null;
  protocol: Protocol;
  ready: string | null;
}

/** `loopback-only`: the port is closed at the checked address but open on 127.0.0.1, so the edge proxy cannot reach it. */
export type Readiness = "ready" | "waiting" | "loopback-only";

/** One check of `target` at `address`; never rejects. A process without a port is ready. */
export async function checkReadiness(target: ProbeTarget, address = LOOPBACK): Promise<Readiness> {
  if (target.port === null) return "ready";
  if (!(await accepts(address, target.port))) {
    return address !== LOOPBACK && (await accepts(LOOPBACK, target.port)) ? "loopback-only" : "waiting";
  }
  if (!target.ready) return "ready";
  const status = await statusOf(address, target.port, target.protocol, target.ready);
  return status !== null && status >= 200 && status < 500 ? "ready" : "waiting";
}

/** The container's first IPv4 address outside the loopback, its address on the session network; 127.0.0.1 without one. */
export function previewAddress(interfaces = networkInterfaces()): string {
  for (const entries of Object.values(interfaces)) {
    const entry = entries?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
    if (entry) return entry.address;
  }
  return LOOPBACK;
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const settle = (isOpen: boolean) => {
      socket.destroy();
      resolve(isOpen);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** The status code of a GET of `path`; null when the request fails or times out. */
function statusOf(host: string, port: number, protocol: Protocol, path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const options = { host, port, path, method: "GET", agent: false, timeout: REQUEST_TIMEOUT_MS, headers: { "user-agent": "hunt-preview" } };
    const onResponse = (response: IncomingMessage) => {
      resolve(response.statusCode ?? null);
      response.destroy();
    };
    const request = protocol === "https" ? httpsRequest({ ...options, rejectUnauthorized: false }, onResponse) : httpRequest(options, onResponse);
    request.once("timeout", () => request.destroy(new Error("timed out")));
    request.once("error", () => resolve(null));
    request.end();
  });
}
