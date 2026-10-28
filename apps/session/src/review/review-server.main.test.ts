import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { AnnotationSpool } from "./annotation-spool.service.ts";
import { WIDGET_TAG } from "./widget-injection.utils.ts";

const SERVER = fileURLToPath(new URL("./review-server.main.ts", import.meta.url));
const HOST = "7c0c6f2e-4200.hunt.example.com";
const WIDGET = "/* the widget */\n";

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const ANNOTATION: BrowserAnnotation = {
  url: `https://${HOST}/orders`,
  title: "Orders",
  selector: "#save",
  text: "Save",
  outerHtml: '<button id="save">Save</button>',
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 1280, height: 800 },
  styles: { color: "rgb(0, 0, 0)" },
  comment: "Make it blue",
};

describe("review server", () => {
  let dir = "";
  let spoolDir = "";
  let review: ChildProcessWithoutNullStreams;
  let reviewOrigin = "";
  let upstream: Server;
  let upstreamPort = 0;
  /** The headers of the last request the dev server got. */
  let received: IncomingHttpHeaders = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-review-"));
    spoolDir = join(dir, "annotations");
    writeFileSync(join(dir, "review.js"), WIDGET);
    upstream = createServer((request, response) => {
      received = request.headers;
      switch (request.url) {
        case "/":
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": ["a=1", "b=2"], "x-app": "yes" });
          response.write("<html><head><title>Orders</title></head>");
          response.end("<body>Ä</body></html>");
          return;
        case "/off":
          response.writeHead(200, { "content-type": "text/html", "x-hunt-review-widget": "off" });
          response.end("<head></head>");
          return;
        case "/login":
          response.writeHead(302, { location: "/sso" });
          response.end();
          return;
        case "/data":
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
          return;
        default:
          response.writeHead(502, { "content-type": "text/plain" });
          response.end("app's own 502");
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
    review = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0", "--spool", spoolDir, "--widget", join(dir, "review.js")]);
    reviewOrigin = await new Promise<string>((resolve, reject) => {
      let output = "";
      review.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const address = /listening on (\S+)/.exec(output)?.[1];
        if (address) {
          resolve(`http://${address}`);
        }
      });
      review.once("exit", (code) => reject(new Error(`the review server exited with ${code}:\n${output}`)));
    });
  });

  afterAll(() => {
    review?.kill("SIGKILL");
    upstream?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sends a request to the review server as hunt-proxy does, with the preview's Host header, which fetch cannot set. */
  function send(method: string, path: string, headers: Record<string, string>, body = ""): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const outgoing = request(`${reviewOrigin}${path}`, { method, headers: { host: HOST, ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }

  function page(path: string, headers: Record<string, string> = {}): Promise<Answer> {
    return send("GET", path, { accept: "text/html", "accept-encoding": "gzip", "x-hunt-upstream-port": String(upstreamPort), ...headers });
  }

  function post(body: string, headers: Record<string, string> = {}): Promise<Answer> {
    return send("POST", "/__hunt/review", { "content-type": "application/json", ...headers }, body);
  }

  it("adds the widget to an HTML page with its length fixed and passes status, cookies and Host on", async () => {
    const response = await page("/");

    expect(response.status).toBe(200);
    expect(response.body).toBe(`<html><head><title>Orders</title>${WIDGET_TAG}</head><body>Ä</body></html>`);
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(response.body)));
    expect(response.headers["transfer-encoding"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(response.headers["x-app"]).toBe("yes");
    expect(received.host).toBe(HOST);
    expect(received["accept-encoding"]).toBeUndefined();
    expect(received["x-hunt-upstream-port"]).toBeUndefined();
  });

  it("passes opted-out pages, redirects, other types and the app's own errors unchanged", async () => {
    expect((await page("/off")).body).toBe("<head></head>");
    const redirect = await page("/login");
    expect([redirect.status, redirect.headers.location]).toEqual([302, "/sso"]);
    expect((await page("/data")).body).toBe('{"ok":true}');
    const failure = await page("/broken");
    expect([failure.status, failure.headers["x-hunt-upstream"], failure.body]).toEqual([502, undefined, "app's own 502"]);
  });

  it("marks the 502 of a port nothing listens on and refuses a request without a port", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));

    const unreachable = await page("/", { "x-hunt-upstream-port": String(closedPort) });
    expect([unreachable.status, unreachable.headers["x-hunt-upstream"]]).toEqual([502, "unreachable"]);
    expect((await page("/", { "x-hunt-upstream-port": "" })).status).toBe(400);
  });

  it("serves the widget and answers 404 for every other file of /__hunt/", async () => {
    const widget = await send("GET", "/__hunt/review.js?v=1", {});
    expect([widget.status, widget.headers["content-type"], widget.body]).toEqual([200, "text/javascript; charset=utf-8", WIDGET]);
    expect((await send("GET", "/__hunt/other", {})).status).toBe(404);
  });

  it("stores a valid annotation from the page's own origin and refuses everything else", async () => {
    const stored = await post(JSON.stringify(ANNOTATION), { origin: `https://${HOST}` });
    expect(stored.status).toBe(201);
    const { id } = JSON.parse(stored.body) as { id: string };

    const refusals: [Promise<Answer>, number][] = [
      [post(JSON.stringify(ANNOTATION), { origin: "https://evil.example.com" }), 403],
      [post(JSON.stringify(ANNOTATION), { "content-type": "text/plain" }), 415],
      [post(JSON.stringify({ ...ANNOTATION, comment: "" })), 400],
      [post("not json"), 400],
      [post(JSON.stringify({ ...ANNOTATION, outerHtml: "x".repeat(70_000) })), 413],
      [send("GET", "/__hunt/review", {}), 405],
    ];
    for (const [response, status] of refusals) {
      expect((await response).status).toBe(status);
    }

    const annotations = new AnnotationSpool(spoolDir).takeAll();
    expect(annotations).toEqual([{ id, createdAt: expect.any(Number), ...ANNOTATION }]);
    expect(readdirSync(spoolDir)).toEqual([]);
  });
});
