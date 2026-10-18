/**
 * hunt-wake on the gateway (`hunt-wake.service`): starts a stopped session VM when someone opens its preview.
 *
 *   node /srv/hunt/current/gateway/wake.mjs      (listens on 127.0.0.1:9180)
 *
 * The edge proxy's server behind IAP hands it every preview request it could not deliver to the session VM (502, 503 or
 * 504) with the request's own Host header, `<short>.<domain>` or `<short>-<port>.<domain>`; the edge has checked the
 * domain, so only the first label counts here. The server for `<short>-<port>-open.<domain>`, which IAP does not guard,
 * answers such requests itself, so an open preview never starts a VM. hunt-wake looks the VM `vm-hunt-s-<short>` up
 * through the Compute Engine API (`gcp.ts`) in every zone of the gateway's project, with the gateway's service account
 * (token and project from the metadata server), and starts or resumes it when it is off, at most once per VM every START_INTERVAL_MS. Only a page
 * load starts a VM: the polling of a forgotten tab must not wake it again and again after the idle sweeper suspended
 * it. Every answer but the one for a VM that does not exist is a page that reloads every RELOAD_SECONDS, until the
 * session VM's preview proxy answers in its place. Runs on Node 24 through type stripping; no dependencies.
 */
import { realpathSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../libs/domain/src/errors.ts";
import type { Log } from "../../../libs/domain/src/journal.ts";
import { createCompute, createMetadata, type Compute, type Instance } from "./gcp.ts";
import { writeLog } from "./journal.ts";

export const LISTEN_HOST = "127.0.0.1";
export const LISTEN_PORT = 9180;
export const START_INTERVAL_MS = 30_000;
export const RELOAD_SECONDS = 5;

const SESSION_HOST = /^([0-9a-f]{8})(?:-[0-9]{1,5})?\./;
/** The suffix of a session VM's name while the gateway moves it to another zone (`movingName` in `orchestrator.ts`). */
const MOVING_SUFFIX = "-moving";

export interface WakeOptions {
  /** The Compute Engine calls hunt-wake needs, on VMs in the gateway's project. */
  compute: Pick<Compute, "locate" | "start" | "resume">;
  now: () => number;
  log: Log;
}

interface Page {
  status: number;
  title: string;
  text: string;
  reloads: boolean;
}

/** The session's short ID from a preview host such as `7c0c6f2e-4200.hunt.example.com`; null for any other host. */
export function sessionShort(host: string | undefined): string | null {
  const name = (host ?? "").toLowerCase().replace(/:[0-9]+$/, "");
  return SESSION_HOST.exec(name)?.[1] ?? null;
}

export function vmName(short: string): string {
  return `vm-hunt-s-${short}`;
}

/** Whether the request loads a page in a browser tab, as opposed to a script's request from a page already open. */
export function isPageLoad(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (method !== "GET") return false;
  const mode = headers["sec-fetch-mode"];
  if (mode) return mode === "navigate";
  return (headers.accept ?? "").includes("text/html");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function renderPage(page: Page): string {
  const refresh = page.reloads ? `\n<meta http-equiv="refresh" content="${RELOAD_SECONDS}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">${refresh}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; color: #1f2328; background: #f6f8fa; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0; color: #59636e; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } p { color: #9198a1; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.text)}</p>
</main>
</body>
</html>
`;
}

function waiting(text: string): Page {
  return { status: 503, title: "Starting the preview…", text, reloads: true };
}

/** Handles one request the edge could not deliver; see the module comment. */
export class Waker {
  private readonly options: WakeOptions;
  /** When hunt-wake last asked Compute Engine to start or resume a VM, by VM name. */
  private readonly lastStarts = new Map<string, number>();

  constructor(options: WakeOptions) {
    this.options = options;
  }

  async page(host: string | undefined, isLoad: boolean): Promise<Page> {
    const short = sessionShort(host);
    if (!short) return { status: 400, title: "Not a preview", text: `${host ?? "This host"} is no session preview.`, reloads: false };
    const name = vmName(short);
    let instance: Instance | null;
    try {
      instance = await this.options.compute.locate(name);
    } catch (error) {
      this.options.log(`failed to look up ${name}: ${messageOf(error)}`, "error");
      return { status: 502, title: "Preview unavailable", text: `The session VM ${name} could not be looked up: ${messageOf(error)}`, reloads: true };
    }
    if (!instance) return this.missing(name);
    switch (instance.status) {
      case "TERMINATED":
      case "STOPPED":
        return this.wake(instance, isLoad, "start");
      case "SUSPENDED":
        return this.wake(instance, isLoad, "resume");
      case "STOPPING":
      case "SUSPENDING":
        return waiting(`The session VM ${name} is shutting down; it starts again once it is off.`);
      case "RUNNING":
        return waiting(`The session VM ${name} runs, but its preview does not answer yet.`);
      default:
        return waiting(`The session VM ${name} is starting.`);
    }
  }

  /**
   * The page for a VM that does not exist under its name: one the gateway is moving to another zone (`orchestrator.ts`
   * renames it meanwhile) answers soon, any other is gone.
   */
  private async missing(name: string): Promise<Page> {
    let moving: Instance | null = null;
    try {
      moving = await this.options.compute.locate(`${name}${MOVING_SUFFIX}`);
    } catch (error) {
      this.options.log(`failed to look up ${name}${MOVING_SUFFIX}: ${messageOf(error)}`, "error");
    }
    if (moving) return waiting(`The session VM ${name} is moving to another zone.`);
    return { status: 404, title: "No such session", text: `There is no session VM ${name}. The session may have been removed.`, reloads: false };
  }

  private async wake({ name, zone }: Instance, isLoad: boolean, verb: "start" | "resume"): Promise<Page> {
    if (!isLoad) return waiting(`The session VM ${name} is off; reload the page to start it.`);
    const now = this.options.now();
    const lastStart = this.lastStarts.get(name);
    if (lastStart !== undefined && now - lastStart < START_INTERVAL_MS) return waiting(`The session VM ${name} is starting.`);
    this.lastStarts.set(name, now);
    try {
      await this.options.compute[verb](zone, name);
    } catch (error) {
      this.options.log(`failed to ${verb} ${name}: ${messageOf(error)}`, "error");
      return { status: 502, title: "Preview unavailable", text: `The session VM ${name} could not be started: ${messageOf(error)}`, reloads: true };
    }
    this.options.log(`${verb === "start" ? "started" : "resumed"} ${name}`);
    return waiting(`The session VM ${name} is starting. This takes about a minute.`);
  }
}

/** An HTTP server that answers every request with the Waker's page. */
export function createWakeServer(waker: Waker, log: Log): Server {
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.resume();
    const page = await waker.page(request.headers.host, isPageLoad(request.method, request.headers));
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
    if (page.reloads) {
      headers["Retry-After"] = String(RELOAD_SECONDS);
    }
    response.writeHead(page.status, headers);
    response.end(request.method === "HEAD" ? undefined : renderPage(page));
  }
  return createServer((request, response) => {
    respond(request, response).catch((error: unknown) => {
      log(`failed to answer a request for ${request.headers.host}: ${messageOf(error)}`, "error");
      response.destroy();
    });
  });
}

function main(): void {
  const log = writeLog;
  const server = createWakeServer(new Waker({ compute: createCompute(createMetadata(), fetch, log), now: Date.now, log }), log);
  server.on("error", (error) => {
    log(`failed to serve ${LISTEN_HOST}:${LISTEN_PORT}: ${error.message}`, "fatal");
    process.exit(1);
  });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening on ${LISTEN_HOST}:${LISTEN_PORT}`));
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
