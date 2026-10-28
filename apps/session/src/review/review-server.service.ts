/**
 * The review server of a session VM's preview proxy, which `review-server.main.ts` runs. hunt-proxy (`proxyConfig` in
 * `../session-config/preview-proxy.utils.ts`) sends it two kinds of requests of the guarded port hosts only, never of the
 * `-open` hosts:
 *
 * - `/__hunt/review.js` answers the widget (`review-widget.main.ts`), and `POST /__hunt/review` stores the annotation in
 *   its JSON body (`libs/domain/src/review/browser-annotation.utils.ts`, at most MAX_BODY_BYTES) in the spool folder
 *   (`annotation-spool.service.ts`), from which the status helper hands it to the desktop client. It takes only
 *   `application/json` and, when the browser names one, the page's own origin, so another site cannot post into the
 *   session.
 * - Every other request is a page load (GET, `Accept: text/html`) of the dev server on the port in
 *   `X-Hunt-Upstream-Port`, over HTTPS without checking the certificate when `X-Hunt-Upstream-Tls` is `true`. The
 *   request goes there with its Host header and without `Accept-Encoding`; an HTML answer gets the widget's script tag
 *   (`widget-injection.utils.ts`) and a matching Content-Length, everything else, redirects and cookies included, passes
 *   unchanged. When nothing listens on the port, it answers 502 with `X-Hunt-Upstream: unreachable`, which hunt-proxy
 *   turns into its own 503 page.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { journalLine, type LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { parseLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";
import { DEFAULT_SPOOL_DIR, type AnnotationSpool } from "./annotation-spool.service.ts";
import { injectWidget, wantsWidget } from "./widget-injection.utils.ts";

const USAGE = "usage: reviewServer.mjs [--listen <host>:<port>] [--spool <folder>] [--widget <file>]";
const DEFAULT_LISTEN = "127.0.0.1:9232";
const WIDGET_PATH = "/__hunt/review.js";
const ANNOTATION_PATH = "/__hunt/review";
/** The largest annotation body; the widget's fields stay well below it. */
const MAX_BODY_BYTES = 64 * 1024;
/** The largest HTML page that gets the widget; a larger one passes unchanged. */
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_PORT_HEADER = "x-hunt-upstream-port";
const UPSTREAM_TLS_HEADER = "x-hunt-upstream-tls";
/** Marks the 502 of an upstream that refused the connection, so that hunt-proxy answers it with its own page. */
const UNREACHABLE_HEADER = "x-hunt-upstream";
/** Headers of one connection only (RFC 9110, 7.6.1), which never pass a proxy. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

export interface ReviewServerOptions {
  host: string;
  port: number;
  spoolDir: string;
  widgetPath: string;
}

/** Writes to stderr, which systemd hands to the journal under the unit's SyslogIdentifier; `level` becomes its priority. */
export function log(message: string, level: LogLevel = "info"): void {
  console.error(journalLine(message, level));
}

/** The options of the command line `args`, the defaults for those it leaves out; throws the usage when it is malformed. */
export function parseOptions(args: readonly string[]): ReviewServerOptions {
  const options: ReviewServerOptions = {
    host: "",
    port: 0,
    spoolDir: DEFAULT_SPOOL_DIR,
    widgetPath: join(dirname(fileURLToPath(import.meta.url)), "review.js"),
  };
  let listen = DEFAULT_LISTEN;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(USAGE);
    switch (args[index]) {
      case "--listen":
        listen = value;
        break;
      case "--spool":
        options.spoolDir = value;
        break;
      case "--widget":
        options.widgetPath = value;
        break;
      default:
        throw new Error(USAGE);
    }
  }
  const address = /^(.+):(\d{1,5})$/.exec(listen);
  if (!address) throw new Error(`invalid --listen ${listen}; expected <host>:<port>`);
  options.host = address[1];
  options.port = Number(address[2]);
  return options;
}

function answer(response: ServerResponse, statusCode: number, body: string, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(body);
}

/** Whether the request comes from a page of its own host: browsers send Origin with every POST, other clients may leave it out. */
function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function receiveAnnotation(request: IncomingMessage, response: ServerResponse, spool: AnnotationSpool): void {
  if (request.method !== "POST") return answer(response, 405, "Only POST stores an annotation.\n", { allow: "POST" });
  if (!/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) return answer(response, 415, "The annotation must be JSON.\n");
  if (!isSameOrigin(request)) return answer(response, 403, "Only the preview's own pages may add annotations.\n");
  const chunks: Buffer[] = [];
  let size = 0;
  let isTooLarge = false;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      isTooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (isTooLarge) return answer(response, 413, `The annotation is larger than ${MAX_BODY_BYTES} bytes.\n`);
    const result = parseBrowserAnnotation(parseLine(Buffer.concat(chunks).toString("utf8")));
    if ("error" in result) return answer(response, 400, `${result.error}\n`);
    try {
      if (spool.isFull()) {
        return answer(response, 429, "Too many annotations wait for Hunt; open the session in Hunt first.\n");
      }
      const stored = spool.store(result.annotation);
      log(`stored annotation ${stored.id} for ${stored.url}`);
      answer(response, 201, JSON.stringify({ id: stored.id }), { "content-type": "application/json" });
    } catch (error) {
      log(`failed to store an annotation: ${messageOf(error)}`, "error");
      answer(response, 500, "The annotation could not be stored.\n");
    }
  });
}

/** The request's headers for the dev server: without hop-by-hop headers, the upstream headers and Accept-Encoding. */
function upstreamHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.includes(name) || name === "accept-encoding" || name === UPSTREAM_PORT_HEADER || name === UPSTREAM_TLS_HEADER) continue;
    result[name] = value;
  }
  return result;
}

/** The upstream response's headers for the browser, without hop-by-hop headers. */
function downstreamHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_BY_HOP.includes(name)));
}

function forward(request: IncomingMessage, response: ServerResponse): void {
  const portHeader = request.headers[UPSTREAM_PORT_HEADER];
  const port = Number(portHeader);
  if (typeof portHeader !== "string" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return answer(response, 400, `${UPSTREAM_PORT_HEADER} must name the port of the preview.\n`);
  }
  const isTls = request.headers[UPSTREAM_TLS_HEADER] === "true";
  const send = isTls ? httpsRequest : httpRequest;
  const upstream = send({
    host: "localhost",
    port,
    method: request.method,
    path: request.url,
    headers: upstreamHeaders(request.headers),
    ...(isTls ? { rejectUnauthorized: false } : {}),
  });
  upstream.on("response", (upstreamResponse) => relay(request, upstreamResponse, response));
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "EADDRNOTAVAIL") return answer(response, 502, "", { [UNREACHABLE_HEADER]: "unreachable" });
    log(`failed to reach port ${port}${request.url ?? ""}: ${messageOf(error)}`, "warn");
    answer(response, 502, `The preview on port ${port} failed: ${messageOf(error)}\n`);
  });
  request.pipe(upstream);
  response.on("close", () => {
    if (!response.writableFinished) {
      upstream.destroy();
    }
  });
}

/** Passes the upstream's answer on, with the widget in an HTML page. */
function relay(request: IncomingMessage, upstreamResponse: IncomingMessage, response: ServerResponse): void {
  const statusCode = upstreamResponse.statusCode ?? 502;
  const headers = downstreamHeaders(upstreamResponse.headers);
  if (!wantsWidget({ method: request.method ?? "", statusCode, headers: upstreamResponse.headers })) {
    response.writeHead(statusCode, upstreamResponse.statusMessage, headers);
    upstreamResponse.pipe(response);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  function passUnchanged(): void {
    upstreamResponse.removeListener("data", collect);
    upstreamResponse.removeListener("end", finish);
    response.writeHead(statusCode, upstreamResponse.statusMessage, headers);
    for (const chunk of chunks) {
      response.write(chunk);
    }
    upstreamResponse.pipe(response);
  }
  function collect(chunk: Buffer): void {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_PAGE_BYTES) {
      passUnchanged();
    }
  }
  function finish(): void {
    const page = injectWidget(Buffer.concat(chunks));
    response.writeHead(statusCode, upstreamResponse.statusMessage, { ...headers, "content-length": page.length });
    response.end(page);
  }
  upstreamResponse.on("data", collect);
  upstreamResponse.on("end", finish);
  upstreamResponse.on("error", (error) => response.destroy(error));
}

/** The review server serving `widget`, the widget's script, and storing annotations in `spool`; it does not listen yet. */
export function createReviewServer(widget: Buffer, spool: AnnotationSpool): Server {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").replace(/\?.*$/, "");
    if (path === WIDGET_PATH) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "content-length": widget.length });
      response.end(request.method === "HEAD" ? undefined : widget);
      return;
    }
    if (path === ANNOTATION_PATH) return receiveAnnotation(request, response, spool);
    if (path.startsWith("/__hunt/")) return answer(response, 404, "Hunt serves no such file.\n");
    forward(request, response);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
