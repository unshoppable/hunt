/**
 * Wires the preview supervisor (`supervisor.ts`) into the relay for `main.ts`: steps and processes through bash in
 * process groups of their own (`shell.ts`), readiness checks (`probe.ts`), service forwards (`forward.ts`), log files
 * (`logs.ts`), the state files in the state directory and the control socket `preview.sock` (`control.ts`).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../files.ts";
import { messageOf } from "../relay.ts";
import { serveControl } from "./control.ts";
import { startForward } from "./forward.ts";
import { LogFile, logPath } from "./logs.ts";
import { checkReadiness, previewAddress } from "./probe.ts";
import { signalGroup, spawnShell } from "./shell.ts";
import { PreviewSupervisor } from "./supervisor.ts";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
/** Kept from steps and processes: the agent's Claude and GitHub tokens have no place in an app's environment. */
const WITHHELD_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"];

export interface PreviewRuntimeOptions {
  /** Where `preview.sock` goes, next to the relay's `acp.sock`. */
  socketDir: string;
  /** Holds `preview.json`, `applied.json`, `init.json` and `logs/`. */
  stateDir: string;
  /** The session's worktree, base of every `cwd`; read at every start. */
  worktree(): string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
}

export interface PreviewRuntime {
  supervisor: PreviewSupervisor;
  /** Closes the control socket and stops the steps and processes; the next relay of this boot resumes the plan. */
  shutdown(): Promise<void>;
  /** Sends SIGKILL to every step and process group. */
  kill(): void;
}

/** Starts the supervisor, resumes the last plan when it ran in this boot and serves the control socket. */
export function startPreviewRuntime(options: PreviewRuntimeOptions): PreviewRuntime {
  const { stateDir, log } = options;
  mkdirSync(join(stateDir, "logs"), { recursive: true });
  const baseEnv = inheritedEnv(options.env);
  const address = previewAddress();
  const supervisor = new PreviewSupervisor({
    spawn: spawnShell,
    signalGroup,
    probe: (spec) => checkReadiness(spec, address),
    startForward: (forward) => startForward(forward),
    openLog: (name) => new LogFile(logPath(stateDir, name), { onError: log }),
    readState: (name) => readJson(join(stateDir, name), log),
    writeState: (name, value) => writeJsonAtomic(join(stateDir, name), value),
    worktree: options.worktree,
    baseEnv: () => baseEnv,
    sessionId: options.env.HUNT_SESSION_ID || null,
    bootId: readBootId,
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    log,
  });
  supervisor.resume();
  const server = serveControl(join(options.socketDir, "preview.sock"), supervisor, log);
  return {
    supervisor,
    shutdown: async () => {
      server.close();
      await supervisor.shutdown();
    },
    kill: () => supervisor.kill(),
  };
}

/** The ID of the running kernel boot, the same in every container of the VM; null where there is none (macOS). */
export function readBootId(): string | null {
  try {
    return readFileSync(BOOT_ID_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function inheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !WITHHELD_ENV.includes(key)) {
      inherited[key] = value;
    }
  }
  return inherited;
}

function readJson(path: string, log: (message: string) => void): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`failed to read ${path}: ${messageOf(error)}`);
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    log(`ignored ${path}: ${messageOf(error)}`);
    return undefined;
  }
}
