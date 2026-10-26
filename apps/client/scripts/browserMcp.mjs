// The Playwright MCP server of a local session's agent, started by Hunt as `node browserMcp.mjs --port <port>` with
// HUNT_BROWSER_SOCKET (Hunt's browser control socket) and HUNT_SESSION_ID in the environment. It runs
// `@playwright/mcp --cdp-endpoint http://127.0.0.1:<port>`, whose output files (snapshots, screenshots) go to a
// per-session temp folder instead of `.playwright-mcp/` in the agent's worktree, and which may open `file://` URLs
// (the browser is the user's own Chrome profile anyway). It passes the NDJSON lines of stdio
// through both ways unchanged, except that it holds the first `tools/call` and every message after it until Hunt opened
// the session's Chrome: it sends `{"open":"<session id>"}` as one line to the socket and reads one line back,
// `{"ok":true}` or `{"error":"<message>"}`. A failure answers that call with a JSON-RPC error, and the next call asks
// again. It exits when stdin ends or the server exits, with the server's exit code; the server's stderr passes through.
// HUNT_BROWSER_MCP_CLI replaces the server's script, for the tests.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

/** How long Hunt may take to copy the profile and start Chrome. */
const OPEN_TIMEOUT_MS = 120_000;
/** How long the server may take to exit by itself after stdin ended. */
const EXIT_GRACE_MS = 5_000;
/** JSON-RPC error code of a failed open. */
const OPEN_FAILED_CODE = -32000;

const port = Number(optionValue("--port"));
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("usage: node browserMcp.mjs --port <port>\n");
  process.exit(2);
}

const serverScript = process.env.HUNT_BROWSER_MCP_CLI || join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");
const outputFolder = join(tmpdir(), "hunt-playwright-mcp", process.env.HUNT_SESSION_ID ?? "");
const serverArguments = [serverScript, "--cdp-endpoint", `http://127.0.0.1:${port}`, "--output-dir", outputFolder, "--allow-unrestricted-file-access"];
const server = spawn(process.execPath, serverArguments, { stdio: ["pipe", "pipe", "inherit"] });

let isOpen = false;
let isOpening = false;
let hasInputEnded = false;
/** The connection to Hunt's socket while an open is pending. */
let openSocket = null;
/** Lines from the agent held back while Hunt opens the browser, in order; the first is the `tools/call` that asked. */
let heldLines = [];

createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => process.stdout.write(`${line}\n`));
server.stdin.on("error", () => {});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", forward);
input.on("close", () => {
  hasInputEnded = true;
  if (!isOpening) endServerInput();
});

server.on("close", (code, signal) => {
  process.exitCode = code ?? (hasInputEnded ? 0 : 1);
  if (signal && !hasInputEnded) {
    process.stderr.write(`the Playwright MCP server ended on ${signal}\n`);
  }
  input.close();
  process.stdin.destroy();
  openSocket?.destroy();
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    hasInputEnded = true;
    server.kill(signal);
  });
}

/** Passes a line from the agent to the server, or holds it while the browser is not open yet. */
function forward(line) {
  if (isOpen) {
    server.stdin.write(`${line}\n`);
    return;
  }
  if (heldLines.length === 0 && !isToolCall(line)) {
    server.stdin.write(`${line}\n`);
    return;
  }
  heldLines.push(line);
  if (!isOpening) void openBrowser();
}

async function openBrowser() {
  isOpening = true;
  try {
    await requestOpen();
    isOpen = true;
  } catch (error) {
    const [toolCall] = heldLines.splice(0, 1);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(toolCall).id, error: { code: OPEN_FAILED_CODE, message: error.message } })}\n`);
  } finally {
    isOpening = false;
  }
  const lines = heldLines;
  heldLines = [];
  for (const line of lines) {
    forward(line);
  }
  if (hasInputEnded && !isOpening) endServerInput();
}

/** Asks Hunt over its socket to open the session's Chrome; resolves once it runs, rejects with Hunt's error. */
function requestOpen() {
  const socketPath = process.env.HUNT_BROWSER_SOCKET;
  const sessionId = process.env.HUNT_SESSION_ID;
  if (!socketPath || !sessionId) return Promise.reject(new Error("failed to open the browser: Hunt passed no HUNT_BROWSER_SOCKET and HUNT_SESSION_ID"));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    openSocket = socket;
    let received = "";
    let isSettled = false;
    const settle = (error) => {
      if (isSettled) return;
      isSettled = true;
      openSocket = null;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    socket.setEncoding("utf8");
    socket.setTimeout(OPEN_TIMEOUT_MS, () => settle(new Error("failed to open the browser: Hunt did not answer in time")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ open: sessionId })}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      settle(replyError(received.slice(0, newline)));
    });
    socket.on("error", (error) => settle(new Error(`failed to open the browser: Hunt does not answer at ${socketPath}: ${error.message}`)));
    socket.on("close", () => settle(new Error("failed to open the browser: Hunt closed the connection without an answer")));
  });
}

/** The error a reply line of Hunt's socket reports, or `undefined` for `{"ok":true}`. */
function replyError(line) {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return new Error(`failed to open the browser: Hunt answered ${line}`);
  }
  if (reply?.ok === true) return undefined;
  if (typeof reply?.error === "string") return new Error(reply.error);
  return new Error(`failed to open the browser: Hunt answered ${line}`);
}

/** Whether a line is a JSON-RPC request that calls a tool. */
function isToolCall(line) {
  try {
    const message = JSON.parse(line);
    return message?.method === "tools/call" && message.id !== undefined;
  } catch {
    return false;
  }
}

/** Ends the server's stdin, so it exits, and stops it when it does not. */
function endServerInput() {
  server.stdin.end();
  setTimeout(() => server.kill("SIGTERM"), EXIT_GRACE_MS).unref();
}

function optionValue(name) {
  const position = process.argv.indexOf(name);
  return position < 0 ? undefined : process.argv[position + 1];
}
