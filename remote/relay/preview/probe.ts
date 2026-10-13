/**
 * The readiness check of a preview process: it accepts a TCP connection on its port, and when it has a `ready` path, a
 * GET of that path answers with a status below 500. HTTPS is not verified: dev servers sign their own certificates.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import type { Protocol } from "./contract.ts";

const CONNECT_TIMEOUT_MS = 2_000;
/** Dev servers often build a page on its first request, so the answer may take a while. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface ProbeTarget {
  port: number | null;
  protocol: Protocol;
  ready: string | null;
}

/** One check against `host` (127.0.0.1 in the session container); never rejects. A process without a port is ready. */
export async function probeReady(target: ProbeTarget, host = "127.0.0.1"): Promise<boolean> {
  if (target.port === null) return true;
  if (!(await accepts(host, target.port))) return false;
  if (!target.ready) return true;
  const status = await statusOf(host, target.port, target.protocol, target.ready);
  return status !== null && status >= 200 && status < 500;
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
