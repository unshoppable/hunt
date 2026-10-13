/**
 * hunt-wake on the gateway (`hunt-wake.service`): starts a stopped session VM when someone opens its preview.
 *
 *   node remote/gateway/wake.ts      (listens on 127.0.0.1:9180)
 *
 * The edge proxy hands it every preview request it could not deliver to the session VM (502, 503 or 504) with the
 * request's own Host header, `<short>.<domain>` or `<short>-<port>.<domain>`; the edge has checked the domain, so only
 * the first label counts here. hunt-wake looks the VM `vm-hunt-s-<short>` up through the Compute Engine API with the
 * gateway's service account (token, project and zone from the metadata server) and starts or resumes it when it is
 * off, at most once per VM every START_INTERVAL_MS. Only a page load starts a VM: the polling of a forgotten tab must
 * not wake it again and again after the idle check powered it off. Every answer but the one for a VM that does not
 * exist is a page that reloads every RELOAD_SECONDS, until the session VM's preview proxy answers in its place. Runs on
 * Node 24 through type stripping; no dependencies.
 */
import { realpathSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

export const LISTEN_HOST = "127.0.0.1";
export const LISTEN_PORT = 9180;
export const START_INTERVAL_MS = 30_000;
export const RELOAD_SECONDS = 5;

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const COMPUTE = "https://compute.googleapis.com/compute/v1";
/** A cached access token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;
const SESSION_HOST = /^([0-9a-f]{8})(?:-[0-9]{1,5})?\./;

/** The Compute Engine calls hunt-wake needs, on VMs in the gateway's project and zone. */
export interface Compute {
  /** The VM's status (`RUNNING`, `TERMINATED`, `SUSPENDED`, …); null when it does not exist. */
  status(name: string): Promise<string | null>;
  start(name: string): Promise<void>;
  resume(name: string): Promise<void>;
}

export interface WakeOptions {
  compute: Compute;
  now: () => number;
  log: (message: string) => void;
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
    let status: string | null;
    try {
      status = await this.options.compute.status(name);
    } catch (error) {
      this.options.log(`failed to look up ${name}: ${messageOf(error)}`);
      return { status: 502, title: "Preview unavailable", text: `The session VM ${name} could not be looked up: ${messageOf(error)}`, reloads: true };
    }
    switch (status) {
      case null:
        return { status: 404, title: "No such session", text: `There is no session VM ${name}. The session may have been removed.`, reloads: false };
      case "TERMINATED":
      case "STOPPED":
        return this.wake(name, isLoad, "start");
      case "SUSPENDED":
        return this.wake(name, isLoad, "resume");
      case "STOPPING":
      case "SUSPENDING":
        return waiting(`The session VM ${name} is shutting down; it starts again once it is off.`);
      case "RUNNING":
        return waiting(`The session VM ${name} runs, but its preview does not answer yet.`);
      default:
        return waiting(`The session VM ${name} is starting.`);
    }
  }

  private async wake(name: string, isLoad: boolean, verb: "start" | "resume"): Promise<Page> {
    if (!isLoad) return waiting(`The session VM ${name} is off; reload the page to start it.`);
    const now = this.options.now();
    const lastStart = this.lastStarts.get(name);
    if (lastStart !== undefined && now - lastStart < START_INTERVAL_MS) return waiting(`The session VM ${name} is starting.`);
    this.lastStarts.set(name, now);
    try {
      await this.options.compute[verb](name);
    } catch (error) {
      this.options.log(`failed to ${verb} ${name}: ${messageOf(error)}`);
      return { status: 502, title: "Preview unavailable", text: `The session VM ${name} could not be started: ${messageOf(error)}`, reloads: true };
    }
    this.options.log(`${verb === "start" ? "started" : "resumed"} ${name}`);
    return waiting(`The session VM ${name} is starting. This takes about a minute.`);
  }
}

/** The error's message, with the cause fetch hides behind "fetch failed". */
export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** Compute Engine's REST API in the gateway's project and zone, with the access token of its service account. */
export function createCompute(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Compute {
  let token: { value: string; expiresAt: number } | null = null;
  let location: { project: string; zone: string } | null = null;

  async function metadata(path: string): Promise<string> {
    const response = await fetchImpl(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
    if (!response.ok) throw new Error(`failed to read ${path} from the metadata server: HTTP ${response.status}`);
    return response.text();
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    const body = JSON.parse(await metadata("instance/service-accounts/default/token")) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return token.value;
  }

  async function instanceUrl(name: string): Promise<string> {
    if (!location) {
      const zone = (await metadata("instance/zone")).split("/").pop() ?? "";
      location = { project: await metadata("project/project-id"), zone };
    }
    return `${COMPUTE}/projects/${encodeURIComponent(location.project)}/zones/${encodeURIComponent(location.zone)}/instances/${encodeURIComponent(name)}`;
  }

  async function call(method: "GET" | "POST", url: string): Promise<Response> {
    return fetchImpl(url, { method, headers: { Authorization: `Bearer ${await accessToken()}` } });
  }

  async function failure(response: Response, what: string): Promise<Error> {
    return new Error(`failed to ${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }

  async function post(name: string, verb: "start" | "resume"): Promise<void> {
    const response = await call("POST", `${await instanceUrl(name)}/${verb}`);
    if (!response.ok) throw await failure(response, `${verb} ${name}`);
  }

  return {
    async status(name) {
      const response = await call("GET", await instanceUrl(name));
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, `look up ${name}`);
      return ((await response.json()) as { status: string }).status;
    },
    start: (name) => post(name, "start"),
    resume: (name) => post(name, "resume"),
  };
}

/** An HTTP server that answers every request with the Waker's page. */
export function createWakeServer(waker: Waker, log: (message: string) => void): Server {
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
      log(`failed to answer a request for ${request.headers.host}: ${messageOf(error)}`);
      response.destroy();
    });
  });
}

function main(): void {
  const log = (message: string) => console.error(`hunt-wake: ${message}`);
  const server = createWakeServer(new Waker({ compute: createCompute(), now: Date.now, log }), log);
  server.on("error", (error) => {
    log(`failed to serve ${LISTEN_HOST}:${LISTEN_PORT}: ${error.message}`);
    process.exit(1);
  });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening on ${LISTEN_HOST}:${LISTEN_PORT}`));
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
