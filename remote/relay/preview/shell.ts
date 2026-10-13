/**
 * Starts the preview's steps and processes: `run` goes to bash in a process group of its own, so that a signal to the
 * group reaches everything it started, with its OOM score raised to 1000, so that under memory pressure the kernel ends
 * a preview process before the relay or Claude Code.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { constants } from "node:os";
import { messageOf } from "../relay.ts";
import type { ChildHandle, ExitResult, GroupSignal, SpawnRequest } from "./supervisor.ts";

/**
 * The group leader raises its OOM score and becomes a bash that runs `run` ($1); bash execs a simple command in place,
 * while `&&`, pipes and variable assignments in `run` work as in a terminal.
 */
const WRAPPER = '{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null; exec /bin/bash -c "$1"';

export function spawnShell(request: SpawnRequest): ChildHandle {
  if (!isDirectory(request.cwd)) return failed(`the directory ${request.cwd} does not exist`);
  let child: ChildProcess;
  try {
    child = spawn("/bin/bash", ["-c", WRAPPER, "hunt-preview", request.run], {
      cwd: request.cwd,
      env: request.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return failed(messageOf(error));
  }
  child.stdout?.on("data", (chunk: Buffer) => request.output.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => request.output.write(chunk));
  const exited = new Promise<ExitResult>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error: error.message }));
    child.once("exit", (code, signal) => resolve({ code: code ?? 128 + (signal ? constants.signals[signal] : 0), error: null }));
  });
  return { pid: child.pid ?? null, exited };
}

/** Sends `signal` to the process group `pgid`; false when no process of the group is left. Signal 0 only checks. */
export function signalGroup(pgid: number, signal: GroupSignal): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function failed(error: string): ChildHandle {
  return { pid: null, exited: Promise.resolve({ code: null, error }) };
}
