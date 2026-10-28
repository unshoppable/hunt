/**
 * The waking of hunt-wake (`wake/wake.main.ts`). The edge proxy's server behind IAP hands it every preview request it could not deliver to the
 * session VM (502, 503 or 504) with the request's own Host header, `<short>.<domain>` or `<short>-<port>.<domain>`; the edge has checked the
 * domain, so only the first label counts here. The server for `<short>-<port>-open.<domain>`, which IAP does not guard, answers such requests
 * itself, so an open preview never starts a VM. hunt-wake looks the VM `vm-hunt-s-<short>` up through the Compute Engine API
 * (`gcp/compute-engine.client.ts`) in every zone of the gateway's project and starts or resumes it when it is off, at most once per VM every
 * START_INTERVAL_MS. Only a page load starts a VM: the polling of a forgotten tab must not wake it again and again after the idle sweeper
 * suspended it. Every answer but the one for a VM that does not exist is a page (`wake/wake-page.utils.ts`) that reloads every RELOAD_SECONDS,
 * until the session VM's preview proxy answers in its place.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { SessionVmName } from "../../../../libs/domain/src/session/session-vm-name.value-object.ts";
import type { Log } from "../../../../libs/domain/src/shared/journal.utils.ts";
import type { Compute, Instance } from "../gcp/compute-engine.client.ts";
import { isPageLoad, RELOAD_SECONDS, renderPage, waiting, type Page } from "./wake-page.utils.ts";

export const LISTEN_HOST = "127.0.0.1";
export const LISTEN_PORT = 9180;
export const START_INTERVAL_MS = 30_000;

export interface WakeOptions {
  /** The Compute Engine calls hunt-wake needs, on VMs in the gateway's project. */
  compute: Pick<Compute, "locate" | "start" | "resume">;
  now: () => number;
  log: Log;
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
    const vm = SessionVmName.fromPreviewHost(host);
    if (!vm) return { status: 400, title: "Not a preview", text: `${host ?? "This host"} is no session preview.`, reloads: false };
    const name = vm.name;
    let instance: Instance | null;
    try {
      instance = await this.options.compute.locate(name);
    } catch (error) {
      this.options.log(`failed to look up ${name}: ${messageOf(error)}`, "error");
      return { status: 502, title: "Preview unavailable", text: `The session VM ${name} could not be looked up: ${messageOf(error)}`, reloads: true };
    }
    if (!instance) return this.missing(vm);
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
   * The page for a VM that does not exist under its name: one the gateway is moving to another zone (`session-vm/session-vm.service.ts`
   * renames it meanwhile) answers soon, any other is gone.
   */
  private async missing(vm: SessionVmName): Promise<Page> {
    let moving: Instance | null = null;
    try {
      moving = await this.options.compute.locate(vm.movingName);
    } catch (error) {
      this.options.log(`failed to look up ${vm.movingName}: ${messageOf(error)}`, "error");
    }
    if (moving) return waiting(`The session VM ${vm.name} is moving to another zone.`);
    return { status: 404, title: "No such session", text: `There is no session VM ${vm.name}. The session may have been removed.`, reloads: false };
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
