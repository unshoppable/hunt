/**
 * `hunt-preview`, the agent's handle on the session's preview; the image installs it as /usr/local/bin/hunt-preview.
 *
 *   hunt-preview status [--json]
 *   hunt-preview start|stop|restart <process>
 *   hunt-preview logs <process> [--lines N]       `logs setup` shows the prepare and init steps
 *
 * Commands go to the supervisor on `$HUNT_SOCKET_DIR/preview.sock`; logs are read from `$HUNT_PREVIEW_STATE_DIR/logs`
 * (by default `$HUNT_SOCKET_DIR/preview/logs`). Exits with 1 when the supervisor refuses, 2 on a usage error.
 */
import { join } from "node:path";
import { isRecord } from "../jsonRpc.ts";
import { messageOf } from "../relay.ts";
import { isName } from "./contract.ts";
import { sendControlRequest } from "./control.ts";
import { logPath, readLogTail } from "./logs.ts";
import type { PreviewStatus } from "./supervisor.ts";

const DEFAULT_LINES = 100;
const USAGE = `usage: hunt-preview <command>

  status [--json]              the preview's state, URLs and processes
  start <process>              start a stopped or crashed process
  stop <process>               stop a process until it is started again
  restart <process>            stop and start a process
  logs <process> [--lines N]   the last N lines (default ${DEFAULT_LINES}) of a process's output; "logs setup" shows
                               the prepare and init steps
`;

class UsageError extends Error {}

/** The preview's status as text: state, step and error when there are any, the main URL and one line per process. */
function formatStatus(status: PreviewStatus): string {
  if (status.state === "idle") return "preview: idle, no preview has been started for this session\n";
  const lines = [`preview: ${status.state} (generation ${status.generation})`];
  if (status.step) {
    lines.push(`step: ${status.step}`);
  }
  if (status.error) {
    lines.push(`error: ${status.error}`);
  }
  if (status.urls) {
    lines.push(`url: ${status.urls.main}`);
  }
  const width = Math.max(...Object.keys(status.processes).map((name) => name.length));
  for (const [name, entry] of Object.entries(status.processes)) {
    const details = [entry.state.padEnd(8)];
    if (entry.pid !== null) {
      details.push(`pid ${entry.pid}`);
    }
    if (entry.restarts > 0) {
      details.push(`restarts ${entry.restarts}`);
    }
    if (entry.exitCode !== null) {
      details.push(`last exit ${entry.exitCode}`);
    }
    const url = status.urls?.processes[name];
    if (url) {
      details.push(url);
    }
    lines.push(`  ${name.padEnd(width)}  ${details.join("  ")}`);
  }
  if (status.state === "failed" && status.step) {
    lines.push("the output of the steps: hunt-preview logs setup");
  }
  return `${lines.join("\n")}\n`;
}

function processArgument(args: string[]): string {
  const [name] = args;
  if (args.length !== 1 || !name || !isName(name)) throw new UsageError("expected one process name");
  return name;
}

function linesArgument(args: string[]): number {
  if (args.length === 0) return DEFAULT_LINES;
  const [flag, value] = args;
  if (args.length !== 2 || flag !== "--lines" || !/^[1-9][0-9]{0,6}$/.test(value)) throw new UsageError("expected --lines <N>");
  return Number(value);
}

async function request(socketPath: string, message: Record<string, unknown>): Promise<PreviewStatus> {
  const answer = await sendControlRequest(socketPath, message);
  if (!isRecord(answer)) throw new Error("the supervisor sent an answer that is not an object");
  if (answer.ok !== true) throw new Error(typeof answer.error === "string" ? answer.error : "the supervisor refused the request");
  if (!isRecord(answer.status)) throw new Error("the supervisor's answer has no status");
  return answer.status as unknown as PreviewStatus;
}

async function run(args: string[]): Promise<string> {
  const socketDir = process.env.HUNT_SOCKET_DIR || "/run/hunt/socket";
  const stateDir = process.env.HUNT_PREVIEW_STATE_DIR || join(socketDir, "preview");
  const socketPath = join(socketDir, "preview.sock");
  const [command, ...rest] = args;
  switch (command) {
    case "status": {
      const isJson = rest.length === 1 && rest[0] === "--json";
      if (rest.length > 0 && !isJson) throw new UsageError("status takes no arguments but --json");
      const status = await request(socketPath, { op: "status" });
      return isJson ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status);
    }
    case "start":
    case "stop":
    case "restart":
      return formatStatus(await request(socketPath, { op: command, process: processArgument(rest) }));
    case "logs": {
      const name = processArgument(rest.slice(0, 1));
      const lines = readLogTail(logPath(stateDir, name), linesArgument(rest.slice(1)));
      if (lines === null) throw new Error(`there is no log of ${name} yet`);
      return lines.map((line) => `${line}\n`).join("");
    }
    default:
      throw new UsageError(command ? `unknown command ${command}` : "missing command");
  }
}

async function main(): Promise<void> {
  try {
    process.stdout.write(await run(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`hunt-preview: ${error.message}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`hunt-preview: ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
