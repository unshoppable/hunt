import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlan } from "./contract.ts";
import { handleControlRequest, sendControlRequest, serveControl, type ControlTarget } from "./control.ts";
import type { PreviewStatus } from "./supervisor.ts";

const SESSION_ID = "7c0c6f2e-1234-4abc-8def-0123456789ab";
const PREVIEW = { processes: { web: { run: "npm run dev", port: 3000, main: true } } };
const PLAN = buildPlan({ preview: PREVIEW }, { sessionId: SESSION_ID, domain: "preview.example.com" });
const STATUS: PreviewStatus = { generation: 1, state: "ready", step: null, error: null, urls: PLAN.urls, processes: {}, updatedAt: 1 };

/** A target that records what it was asked to do; restarting `broken` fails. */
function fakeTarget() {
  const calls: unknown[][] = [];
  const target: ControlTarget = {
    apply: (plan, dataGeneration) => {
      calls.push(["apply", plan, dataGeneration]);
      return STATUS;
    },
    stop: async () => {
      calls.push(["stop"]);
      return STATUS;
    },
    startProcess: (name) => {
      calls.push(["start", name]);
      return STATUS;
    },
    stopProcess: async (name) => {
      calls.push(["stop", name]);
      return STATUS;
    },
    restartProcess: async (name) => {
      if (name === "broken") throw new Error("broken did not stop");
      calls.push(["restart", name]);
      return STATUS;
    },
    status: () => STATUS,
  };
  return { target, calls };
}

/** A directory for the socket; Unix socket paths are limited to 104 bytes on macOS, so a long TMPDIR is not used. */
function socketTempDir(): string {
  return mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hunt-control-"));
}

/** Writes `text` to the socket at `path` and resolves with everything the server sends until it closes the connection. */
function exchange(path: string, text: string, shouldHalfClose = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(received));
    socket.once("connect", () => {
      socket.write(text);
      if (shouldHalfClose) {
        socket.end();
      }
    });
  });
}

describe("handleControlRequest", () => {
  it("passes every op to the target and answers with the status", async () => {
    const { target, calls } = fakeTarget();
    const plan = JSON.parse(JSON.stringify(PLAN)) as unknown;

    expect(await handleControlRequest(target, { op: "status" })).toEqual({ ok: true, status: STATUS });
    expect(await handleControlRequest(target, { op: "apply", plan, dataGeneration: "data-1" })).toEqual({ ok: true, status: STATUS });
    expect(await handleControlRequest(target, { op: "stop" })).toEqual({ ok: true, status: STATUS });
    await handleControlRequest(target, { op: "start", process: "web" });
    await handleControlRequest(target, { op: "stop", process: "web" });
    await handleControlRequest(target, { op: "restart", process: "web" });

    expect(calls).toEqual([["apply", PLAN, "data-1"], ["stop"], ["start", "web"], ["stop", "web"], ["restart", "web"]]);
  });

  it("answers ok: false with the reason for an invalid request or a failing target", async () => {
    const { target, calls } = fakeTarget();
    const cases: [unknown, string][] = [
      [[], 'expected a JSON object with an "op"'],
      [{ op: "reset" }, 'unknown op "reset"; expected apply, stop, start, restart or status'],
      [{ op: "status", verbose: true }, "unknown field verbose in a status request"],
      [{ op: "start" }, '"process" must be the name of a process'],
      [{ op: "restart", process: "../web" }, '"process" must be the name of a process'],
      [{ op: "apply", plan: PLAN, dataGeneration: "" }, '"dataGeneration" must be a single-line string of 1 to 128 characters'],
      [{ op: "apply", plan: PLAN, dataGeneration: 3 }, '"dataGeneration" must be a single-line string of 1 to 128 characters'],
      [{ op: "apply", plan: { ...PLAN, version: 2 }, dataGeneration: "1" }, "plan.version: must be 1"],
      [{ op: "restart", process: "broken" }, "broken did not stop"],
    ];

    for (const [request, error] of cases) {
      expect(await handleControlRequest(target, request)).toEqual({ ok: false, error });
    }
    expect(calls).toEqual([]);
  });
});

describe("serveControl", () => {
  let dir = "";
  let server: Server | null = null;

  afterEach(async () => {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve(target: ControlTarget): Promise<string> {
    dir = socketTempDir();
    const path = join(dir, "preview.sock");
    writeFileSync(path, "a stale socket file");
    server = serveControl(path, target, () => {});
    await once(server, "listening");
    return path;
  }

  it("answers one request per connection with one line and closes the connection, on a socket only its owner can use", async () => {
    const { target, calls } = fakeTarget();
    const path = await serve(target);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await exchange(path, '{"op":"start","process":"web"}\n{"op":"stop"}\n')).toBe(`${JSON.stringify({ ok: true, status: STATUS })}\n`);
    expect(calls).toEqual([["start", "web"]]);
    expect(await sendControlRequest(path, { op: "restart", process: "broken" })).toEqual({ ok: false, error: "broken did not stop" });
  });

  it("takes a request without a line break when the client half-closes, and refuses one that is not JSON", async () => {
    const path = await serve(fakeTarget().target);

    expect(JSON.parse(await exchange(path, '{"op":"status"}', true))).toEqual({ ok: true, status: STATUS });
    expect(JSON.parse(await exchange(path, "status\n"))).toEqual({ ok: false, error: "the request is not JSON" });
  });
});

describe("sendControlRequest", () => {
  it("names the socket it cannot reach", async () => {
    await expect(sendControlRequest("/nonexistent/preview.sock", { op: "status" })).rejects.toThrow(/^failed to reach \/nonexistent\/preview\.sock: /);
  });
});
