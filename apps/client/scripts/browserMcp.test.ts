import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WRAPPER = fileURLToPath(new URL("./browserMcp.mjs", import.meta.url));
const SESSION_ID = "6f0c2a52-0b55-4c4e-9d0e-2f8b1f3c7a10";
const PORT = 9333;
/** Long enough for a message the wrapper wrongly lets through to come back from the fake server. */
const SETTLE_MS = 150;

/**
 * An MCP server stand-in: answers every request with its method and the server's arguments, echoes notifications, and
 * exits with `params.code` on the notification `exit`.
 */
const FAKE_SERVER = `
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "exit") process.exit(message.params.code);
  const reply = message.id === undefined
    ? { jsonrpc: "2.0", method: "echo", params: message }
    : { jsonrpc: "2.0", id: message.id, result: { method: message.method, args } };
  process.stdout.write(JSON.stringify(reply) + "\\n");
});
`;

type Message = Record<string, unknown>;

interface Wrapper {
  send(message: Message): void;
  /** The next message the wrapper writes to stdout. */
  next(): Promise<Message>;
  /** Messages written so far and not yet taken by `next`. */
  pending: Message[];
  exitCode: Promise<number | null>;
  child: ChildProcessWithoutNullStreams;
}

let folder: string;
let socketPath: string;
let control: Server | undefined;
/** The requests Hunt's fake socket received. */
let openRequests: Message[];
let wrappers: Wrapper[];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hunt-browser-mcp-"));
  socketPath = join(folder, "control.sock");
  writeFileSync(join(folder, "fakeServer.mjs"), FAKE_SERVER);
  openRequests = [];
  wrappers = [];
});

afterEach(async () => {
  for (const wrapper of wrappers) {
    wrapper.child.kill("SIGKILL");
  }
  await new Promise<void>((resolve) => (control ? control.close(() => resolve()) : resolve()));
  control = undefined;
  rmSync(folder, { recursive: true, force: true });
});

/** Starts Hunt's fake control socket; each connection gets the line `answer` resolves to, for the n-th request. */
function startControl(answer: (requestNumber: number) => Promise<string>): Promise<void> {
  const server = createServer((connection) => {
    createInterface({ input: connection }).once("line", (line) => {
      openRequests.push(JSON.parse(line) as Message);
      void answer(openRequests.length).then((reply) => connection.end(`${reply}\n`));
    });
  });
  control = server;
  return new Promise((resolve) => server.listen(socketPath, resolve));
}

function startWrapper(environment: Record<string, string> = {}): Wrapper {
  const child = spawn(process.execPath, [WRAPPER, "--port", String(PORT)], {
    env: {
      ...process.env,
      HUNT_BROWSER_SOCKET: socketPath,
      HUNT_SESSION_ID: SESSION_ID,
      HUNT_BROWSER_MCP_CLI: join(folder, "fakeServer.mjs"),
      ...environment,
    },
  });
  const pending: Message[] = [];
  const waiters: ((message: Message) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      pending.push(message);
    }
  });
  const exitCode = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const wrapper: Wrapper = {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    next: () => {
      const message = pending.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve) => waiters.push(resolve));
    },
    pending,
    exitCode,
    child,
  };
  wrappers.push(wrapper);
  return wrapper;
}

function request(id: number, method: string): Message {
  return { jsonrpc: "2.0", id, method, params: {} };
}

function resultOf(id: number, method: string): Message {
  const args = ["--cdp-endpoint", `http://127.0.0.1:${PORT}`, "--output-dir", join(tmpdir(), "hunt-playwright-mcp", SESSION_ID)];
  return { jsonrpc: "2.0", id, result: { method, args } };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await delay(10);
  }
}

describe("browserMcp.mjs", () => {
  it("passes requests before the first tool call through to the server on the session's CDP port without opening the browser", async () => {
    await startControl(async () => JSON.stringify({ ok: true }));
    const wrapper = startWrapper();

    wrapper.send(request(1, "initialize"));
    wrapper.send(request(2, "tools/list"));

    expect(await wrapper.next()).toEqual(resultOf(1, "initialize"));
    expect(await wrapper.next()).toEqual(resultOf(2, "tools/list"));
    expect(openRequests).toEqual([]);
  });

  it("holds the first tool call and every message after it, in order, until Hunt opened the browser", async () => {
    let answerOpen = (_reply: string) => {};
    await startControl(() => new Promise((resolve) => (answerOpen = resolve)));
    const wrapper = startWrapper();
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

    wrapper.send(request(1, "tools/call"));
    wrapper.send(initialized);
    wrapper.send(request(2, "tools/list"));
    await until(() => openRequests.length === 1);
    await delay(SETTLE_MS);

    expect(openRequests).toEqual([{ open: SESSION_ID }]);
    expect(wrapper.pending).toEqual([]);

    answerOpen(JSON.stringify({ ok: true }));

    expect(await wrapper.next()).toEqual(resultOf(1, "tools/call"));
    expect(await wrapper.next()).toEqual({ jsonrpc: "2.0", method: "echo", params: initialized });
    expect(await wrapper.next()).toEqual(resultOf(2, "tools/list"));

    wrapper.send(request(3, "tools/call"));

    expect(await wrapper.next()).toEqual(resultOf(3, "tools/call"));
    expect(openRequests).toHaveLength(1);
  });

  it("answers the tool call with a JSON-RPC error when Hunt cannot open the browser, and asks again at the next call", async () => {
    await startControl(async (requestNumber) =>
      JSON.stringify(requestNumber === 1 ? { error: "failed to open the browser: Google Chrome is not installed" } : { ok: true }),
    );
    const wrapper = startWrapper();

    wrapper.send(request(1, "tools/call"));

    expect(await wrapper.next()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "failed to open the browser: Google Chrome is not installed" },
    });

    wrapper.send(request(2, "tools/call"));

    expect(await wrapper.next()).toEqual(resultOf(2, "tools/call"));
    expect(openRequests).toEqual([{ open: SESSION_ID }, { open: SESSION_ID }]);
  });

  it("answers the tool call with an error when Hunt does not listen on the socket", async () => {
    const wrapper = startWrapper();

    wrapper.send(request(7, "tools/call"));
    const reply = await wrapper.next();

    expect(reply.id).toBe(7);
    expect((reply.error as { message: string }).message).toMatch(/^failed to open the browser: Hunt does not answer at /);
  });

  it("exits with the server's exit code, and with 0 once stdin ends", async () => {
    const exiting = startWrapper();
    exiting.send({ jsonrpc: "2.0", method: "exit", params: { code: 3 } });

    expect(await exiting.exitCode).toBe(3);

    const ending = startWrapper();
    ending.child.stdin.end();

    expect(await ending.exitCode).toBe(0);
  });
});
