import { spawn } from "node:child_process";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWakeServer, isPageLoad, renderPage, sessionShort, START_INTERVAL_MS, Waker, type WakeOptions } from "./wake.ts";

const NAVIGATE = { "sec-fetch-mode": "navigate", accept: "text/html" };

/** A Compute whose VMs, all in europe-west3-b, have the statuses in `statuses`; it records every start and resume. */
function fakeCompute(statuses: Record<string, string>, failure?: Error) {
  const calls: string[] = [];
  const compute: WakeOptions["compute"] = {
    locate: async (name) => {
      if (failure) throw failure;
      const status = statuses[name];
      if (!status) return null;
      return { name, zone: "europe-west3-b", status, creationTimestamp: "", lastStopTimestamp: "", lastSuspendedTimestamp: "", labels: {}, metadata: { fingerprint: "", items: [] }, disks: [] };
    },
    start: async (zone, name) => {
      calls.push(`start ${name} in ${zone}`);
      return { name: "operation-1", zone };
    },
    resume: async (zone, name) => {
      calls.push(`resume ${name} in ${zone}`);
      return { name: "operation-1", zone };
    },
  };
  return { compute, calls };
}

describe("sessionShort", () => {
  it("reads the short ID from the first label of a preview host, with or without a port", () => {
    expect(sessionShort("7c0c6f2e.hunt.example.com")).toBe("7c0c6f2e");
    expect(sessionShort("7C0C6F2E-4200.hunt.example.com:443")).toBe("7c0c6f2e");
    expect(sessionShort("7c0c6f2e")).toBeNull();
    expect(sessionShort("7c0c6f2ex.hunt.example.com")).toBeNull();
    expect(sessionShort("7c0c6f2e-api.hunt.example.com")).toBeNull();
    expect(sessionShort("7c0c6f2e-3000-open.hunt.example.com")).toBeNull();
    expect(sessionShort(undefined)).toBeNull();
  });
});

describe("isPageLoad", () => {
  it("counts navigations, and HTML requests of clients without fetch metadata, but no script's request", () => {
    expect(isPageLoad("GET", NAVIGATE)).toBe(true);
    expect(isPageLoad("GET", { "sec-fetch-mode": "cors", accept: "text/html" })).toBe(false);
    expect(isPageLoad("GET", { accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(isPageLoad("GET", { accept: "*/*" })).toBe(false);
    expect(isPageLoad("POST", NAVIGATE)).toBe(false);
  });
});

describe("renderPage", () => {
  it("escapes the text and reloads only when asked to", () => {
    const html = renderPage({ status: 502, title: "Preview <unavailable>", text: `"a" & 'b'`, reloads: true });
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).toContain("<title>Preview &#60;unavailable&#62;</title>");
    expect(html).toContain("<p>&#34;a&#34; &#38; &#39;b&#39;</p>");
    expect(renderPage({ status: 404, title: "No such session", text: "", reloads: false })).not.toContain("refresh");
  });
});

describe("Waker", () => {
  const log = () => {};

  it("starts a stopped VM for a page load, at most once per interval", async () => {
    const { compute, calls } = fakeCompute({ "vm-hunt-s-7c0c6f2e": "TERMINATED" });
    let now = 1_000_000;
    const waker = new Waker({ compute, now: () => now, log });

    expect(await waker.page("7c0c6f2e-4200.hunt.example.com", true)).toMatchObject({ status: 503, reloads: true, title: "Starting the preview…" });
    expect(await waker.page("7c0c6f2e.hunt.example.com", true)).toMatchObject({ status: 503, text: "The session VM vm-hunt-s-7c0c6f2e is starting." });
    now += START_INTERVAL_MS - 1;
    await waker.page("7c0c6f2e.hunt.example.com", true);
    expect(calls).toEqual(["start vm-hunt-s-7c0c6f2e in europe-west3-b"]);
    now += 1;
    await waker.page("7c0c6f2e.hunt.example.com", true);
    expect(calls).toEqual(["start vm-hunt-s-7c0c6f2e in europe-west3-b", "start vm-hunt-s-7c0c6f2e in europe-west3-b"]);
  });

  it("resumes a suspended VM and starts nothing for a script's request or a VM that runs or shuts down", async () => {
    const { compute, calls } = fakeCompute({
      "vm-hunt-s-00000001": "SUSPENDED",
      "vm-hunt-s-00000002": "TERMINATED",
      "vm-hunt-s-00000003": "RUNNING",
      "vm-hunt-s-00000004": "STOPPING",
      "vm-hunt-s-00000005": "STAGING",
    });
    const waker = new Waker({ compute, now: () => 0, log });

    await waker.page("00000001.hunt.example.com", true);
    expect(await waker.page("00000002.hunt.example.com", false)).toMatchObject({ status: 503, text: expect.stringContaining("reload the page") });
    expect(await waker.page("00000003.hunt.example.com", true)).toMatchObject({ status: 503, text: expect.stringContaining("does not answer yet") });
    expect(await waker.page("00000004.hunt.example.com", true)).toMatchObject({ status: 503, text: expect.stringContaining("shutting down") });
    expect(await waker.page("00000005.hunt.example.com", true)).toMatchObject({ status: 503, text: expect.stringContaining("is starting") });
    expect(calls).toEqual(["resume vm-hunt-s-00000001 in europe-west3-b"]);
  });

  it("answers 404 without reloading for a VM that does not exist and 400 for other hosts", async () => {
    const waker = new Waker({ compute: fakeCompute({}).compute, now: () => 0, log });

    expect(await waker.page("7c0c6f2e.hunt.example.com", true)).toMatchObject({ status: 404, reloads: false });
    expect(await waker.page("hunt.example.com", true)).toMatchObject({ status: 400, reloads: false });
  });

  it("reports a failing Compute Engine call on a page that keeps reloading", async () => {
    const messages: string[] = [];
    const waker = new Waker({ compute: fakeCompute({}, new Error("HTTP 403 forbidden")).compute, now: () => 0, log: (message) => messages.push(message) });

    expect(await waker.page("7c0c6f2e.hunt.example.com", true)).toMatchObject({ status: 502, reloads: true, text: expect.stringContaining("HTTP 403 forbidden") });
    expect(messages).toEqual(["failed to look up vm-hunt-s-7c0c6f2e: HTTP 403 forbidden"]);
  });
});

/** GETs `path` from the server on `port` with the headers given; fetch cannot set Host. */
function get(port: number, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path: "/some/path", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("createWakeServer", () => {
  let close = () => {};

  afterEach(() => {
    close();
  });

  it("answers with the page, its status and headers, and starts the VM for a page load only", async () => {
    const { compute, calls } = fakeCompute({ "vm-hunt-s-7c0c6f2e": "TERMINATED" });
    const server = createWakeServer(new Waker({ compute, now: Date.now, log: () => {} }), () => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    const port = (server.address() as AddressInfo).port;

    const background = await get(port, { Host: "7c0c6f2e-4200.hunt.example.com", "Sec-Fetch-Mode": "cors" });
    expect(background.status).toBe(503);
    expect(calls).toEqual([]);
    const page = await get(port, { Host: "7c0c6f2e-4200.hunt.example.com", "Sec-Fetch-Mode": "navigate" });
    expect(page.status).toBe(503);
    expect(page.headers).toMatchObject({ "retry-after": "5", "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    expect(page.body).toContain("The session VM vm-hunt-s-7c0c6f2e is starting.");
    expect(calls).toEqual(["start vm-hunt-s-7c0c6f2e in europe-west3-b"]);
  });

  it("listens on 127.0.0.1:9180 when run as a script", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./wake.ts", import.meta.url))], { stdio: ["ignore", "pipe", "ignore"] });
    close = () => child.kill();
    const line = await new Promise<string>((resolve) => child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    expect(line).toMatch(/^(listening on 127\.0\.0\.1:9180|failed to serve 127\.0\.0\.1:9180: .*EADDRINUSE)/);
  });
});
