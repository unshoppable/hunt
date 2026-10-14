/**
 * Entry point of the relay on a session VM, run by `hunt-relay.service` as the user `agent`: spawns the ACP adapter,
 * serves ACP to any number of clients at once on `$HUNT_SOCKET_DIR/relay.sock` and keeps `status.json` next to it (see
 * `relay.ts` for the protocol).
 *
 *   node /srv/hunt/current/relay/main.mjs      (the bundle `nx build session` writes)
 *
 * Environment: `HUNT_ADAPTER` (the adapter's entry script, run with this Node), `HUNT_CONFIG` (`hunt-session.json`),
 * `HUNT_SOCKET_DIR` and optionally `HUNT_MCP_SERVERS` (see `config.ts`). The adapter runs in the home directory with the
 * relay's environment. When the adapter exits on its own, the relay exits with the adapter's code; SIGTERM and SIGINT
 * close the adapter's stdin, wait up to 10 s for it to exit (it writes the transcript meanwhile) and exit 0. Runs on
 * Node 24 through type stripping; no dependencies.
 */
import { spawn } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, readMcpServers, updateConfigFile, type McpServerEntry } from "./config.ts";
import { ERROR_CODES, errorOutcome, responseMessage } from "../../../../libs/domain/src/jsonRpc.ts";
import { createLineDecoder, encodeLine, parseLine } from "../../../../libs/domain/src/ndjson.ts";
import { messageOf } from "../../../../libs/domain/src/errors.ts";
import { Relay, type ClientConnection } from "./relay.ts";
import { HEARTBEAT_INTERVAL_MS, writeStatusFile } from "./status.ts";

const STOP_TIMEOUT_MS = 10_000;
const SOCKET_MODE = 0o660;

/** Writes to stderr, which systemd hands to the journal under the unit's SyslogIdentifier. */
function log(message: string): void {
  console.error(message);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

/** Runs one message through the relay; an error in handling it is logged instead of ending the session. */
function dispatch(handle: () => void): void {
  try {
    handle();
  } catch (error) {
    log(`failed to handle a message: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

/** The MCP servers every session gets (`HUNT_MCP_SERVERS`); a session runs without them rather than not at all. */
function loadMcpServers(): McpServerEntry[] {
  try {
    return readMcpServers(process.env.HUNT_MCP_SERVERS);
  } catch (error) {
    log(messageOf(error));
    return [];
  }
}

/** Connects one socket to the relay as one of its clients, framed as NDJSON. */
function serveClient(socket: Socket, relay: Relay): void {
  socket.setEncoding("utf8");
  const connection: ClientConnection = {
    send: (message) => {
      if (!socket.destroyed) {
        socket.write(encodeLine(message));
      }
    },
  };
  const lines = createLineDecoder((line) => {
    const message = parseLine(line);
    if (message === undefined) {
      connection.send(responseMessage(null, errorOutcome(ERROR_CODES.parseError, "Parse error")));
      return;
    }
    dispatch(() => relay.handleClientMessage(connection, message));
  });
  socket.on("data", (chunk: string) => lines.push(chunk));
  socket.on("error", (error) => log(`client connection failed: ${error.message}`));
  socket.on("close", () => dispatch(() => relay.disconnectClient(connection)));
  dispatch(() => relay.connectClient(connection));
}

function main(): void {
  const adapterPath = resolve(requireEnv("HUNT_ADAPTER"));
  const configPath = requireEnv("HUNT_CONFIG");
  const socketDir = requireEnv("HUNT_SOCKET_DIR");
  const socketPath = join(socketDir, "relay.sock");
  const statusPath = join(socketDir, "status.json");

  const adapter = spawn(process.execPath, [adapterPath], { cwd: homedir(), env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const relay = new Relay({
    sendToAgent: (message) => {
      adapter.stdin.write(encodeLine(message));
    },
    loadConfig: () => readConfig(configPath),
    mcpServers: loadMcpServers(),
    persistConfig: (changes) => updateConfigFile(configPath, changes),
    onStatusChange: () => writeStatus(),
    now: () => Date.now(),
    log,
  });

  function writeStatus(): void {
    try {
      writeStatusFile(statusPath, relay.status());
    } catch (error) {
      log(`failed to write ${statusPath}: ${messageOf(error)}`);
    }
  }

  let isStopping = false;
  let markAdapterExited = () => {};
  const adapterExited = new Promise<void>((resolve) => {
    markAdapterExited = resolve;
  });
  adapter.on("error", (error) => {
    log(`failed to run the adapter: ${error.message}`);
    process.exit(1);
  });
  adapter.on("exit", (code, signal) => {
    if (isStopping) {
      markAdapterExited();
      return;
    }
    log(`the adapter exited with ${signal ?? `code ${code}`}`);
    process.exit(code ?? 1);
  });
  adapter.stdin.on("error", (error) => log(`failed to write to the adapter: ${error.message}`));
  adapter.stdout.setEncoding("utf8");
  const agentLines = createLineDecoder((line) => {
    const message = parseLine(line);
    if (message === undefined) {
      log(`ignored a line from the adapter that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    dispatch(() => relay.handleAgentMessage(message));
  });
  adapter.stdout.on("data", (chunk: string) => agentLines.push(chunk));

  rmSync(socketPath, { force: true });
  const server = createServer((socket) => serveClient(socket, relay));
  server.on("error", (error) => {
    log(`failed to serve ${socketPath}: ${error.message}`);
    process.exit(1);
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, SOCKET_MODE);
    log(`listening on ${socketPath}`);
  });

  const heartbeat = setInterval(writeStatus, HEARTBEAT_INTERVAL_MS);
  void relay.start();

  function stop(): void {
    if (isStopping) return;
    isStopping = true;
    log("stopping: closing the adapter's stdin");
    clearInterval(heartbeat);
    server.close();
    adapter.stdin.end();
    void adapterExited.then(() => process.exit(0));
    setTimeout(() => {
      log(`the adapter did not exit within ${STOP_TIMEOUT_MS / 1000} s`);
      adapter.kill("SIGKILL");
      process.exit(0);
    }, STOP_TIMEOUT_MS);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
