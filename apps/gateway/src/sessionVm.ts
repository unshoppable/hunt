/**
 * The gateway's access to a session VM: `gcloud compute ssh <vm> --internal-ip` with the gateway's service account,
 * which logs in through OS Login as an admin and runs `hunt-ctl` with sudo. Connections to one VM share one SSH
 * connection (ControlMaster), so a setup's many commands pay for one handshake. The gateway hands the session VMs the
 * session release CI staged on it (`hunt-ctl stage-session`, `/srv/hunt/session-current`).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseInfo } from "../../../libs/domain/src/gatewayApi.ts";
import type { Log } from "../../../libs/domain/src/journal.ts";
import type { Transport } from "./acpClient.ts";
import { ApiError } from "./apiProtocol.ts";

/** The session release CI staged on the gateway, a link to `/srv/hunt/session-releases/<hash>`. */
export const STAGED_SESSION_RELEASE = "/srv/hunt/session-current";
const INSTALLED_HASH = "/var/lib/hunt/installed-hash";
const READY_STAMP = "/var/lib/hunt/session-ready";
const RELAY_COMMAND = "sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock";
const STDERR_TAIL_LINES = 15;

/** Where a VM lives: its project and its own zone. */
export interface VmLocation {
  project: string;
  zone: string;
}

/** `value` quoted for a POSIX shell, like `shell_quote` in `apps/client/src-tauri/src/remote/mod.rs`. */
export function shellQuote(value: string): string {
  if (value && /^[A-Za-z0-9\-_./=:@%+,]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(program: string, args: string[]): string {
  return [program, ...args].map(shellQuote).join(" ");
}

/**
 * The arguments of `gcloud` that run `command` on the VM `vm`. The control socket lives in `$HOME/.ssh`, the service's
 * state directory: ssh expands `~` from the passwd entry, and hunt-gw's home is `/nonexistent`, where ssh cannot bind
 * the socket and exits with 255 right after logging in.
 */
export function sshArgs(vm: string, location: VmLocation, command: string): string[] {
  return [
    "compute",
    "ssh",
    vm,
    "--internal-ip",
    `--zone=${location.zone}`,
    `--project=${location.project}`,
    "--quiet",
    "--ssh-flag=-oServerAliveInterval=30",
    "--ssh-flag=-oConnectTimeout=20",
    "--ssh-flag=-oControlMaster=auto",
    `--ssh-flag=-oControlPath=${join(homedir(), ".ssh", "hunt-%C")}`,
    "--ssh-flag=-oControlPersist=60",
    "--command",
    command,
  ];
}

/**
 * The command that installs the release in the tar.gz on stdin with its own `hunt-ctl`: unpacked into a folder of its
 * own below `/srv/hunt/incoming`, which is removed afterwards.
 */
export function installScript(hash: string, incoming = `/srv/hunt/incoming/${randomUUID()}`): string {
  const install = shellCommand(`${incoming}/vm/hunt-ctl`, ["install", incoming]);
  return (
    `set -e; mkdir -p -m 0700 ${incoming}; trap 'rm -rf ${incoming}' EXIT; tar -xzf - -C ${incoming}; printf %s ${hash} > ${incoming}/.hash; ` +
    `find ${incoming}/vm -maxdepth 1 -type f -name 'hunt-*' -exec chmod +x {} +; ${install}`
  );
}

export interface StagedRelease {
  /** The release's folder, with the link resolved. */
  dir: string;
  hash: string;
  info: ReleaseInfo;
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** The session release staged at `link`; an `unavailable` ApiError without one. */
export function readStagedRelease(link = STAGED_SESSION_RELEASE): StagedRelease {
  let dir: string;
  try {
    dir = realpathSync(link);
  } catch {
    throw new ApiError("unavailable", `no session release is staged on the gateway (${link} is missing); CI stages one with hunt-ctl stage-session`);
  }
  const hash = readOptional(join(dir, ".hash"));
  if (!/^[0-9a-f]{16}$/.test(hash)) throw new ApiError("unavailable", `the session release staged in ${dir} has no valid .hash`);
  let protocol: number | null = null;
  try {
    const value = (JSON.parse(readFileSync(join(dir, "protocol.json"), "utf8")) as { protocol?: unknown }).protocol;
    protocol = typeof value === "number" ? value : null;
  } catch {
    protocol = null;
  }
  return { dir, hash, info: { version: readOptional(join(dir, ".version")) || null, protocol } };
}

/**
 * Creates the SSH key gcloud logs in with in the service's home, so that two connections that start at once do not
 * both create it. gcloud registers it with OS Login on every connect.
 */
export function ensureSshKey(comment: string): void {
  const dir = join(homedir(), ".ssh");
  if (existsSync(join(dir, "google_compute_engine"))) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = join(dir, "google_compute_engine");
  const result = spawnSync("ssh-keygen", ["-t", "rsa", "-b", "3072", "-N", "", "-C", comment, "-q", "-f", key], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`failed to create the SSH key in ${dir}`);
}

/** The last lines of a command's error output. */
function tail(text: string): string {
  return text.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

/**
 * Runs `program` with `args`, `input` on stdin; resolves with stdout, rejects with the end of stderr. `log` hears the
 * outcome and the duration.
 */
function run(program: string, args: string[], input: Buffer | string, timeoutMs: number, what: string, log: Log): Promise<Buffer> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let isSettled = false;
    const fail = (reason: string) => {
      clearTimeout(timer);
      if (isSettled) return;
      isSettled = true;
      log(`${what}: failed after ${Date.now() - startedAt} ms: ${reason}`, "error");
      reject(new Error(`failed to ${what}: ${reason}`));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(`no result within ${Math.round(timeoutMs / 60_000)} minutes`);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error) => fail(error.message));
    child.on("close", (code) => {
      if (code !== 0) return fail(`exit status ${code}${stderr.trim() ? `\n${tail(stderr)}` : ""}`);
      clearTimeout(timer);
      if (isSettled) return;
      isSettled = true;
      log(`${what}: ok in ${Date.now() - startedAt} ms`);
      resolve(Buffer.concat(stdout));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export interface SessionVm {
  /** Runs `command` on the VM and returns its stdout. */
  run(command: string, input?: Buffer | string, timeoutMs?: number): Promise<string>;
  /** Runs `hunt-ctl` with `args` as root and returns its JSON result. */
  huntCtl(args: string[], input?: Buffer | string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * Waits until the VM answers over SSH and its startup script wrote the ready stamp. `onWaiting` hears the first miss,
   * `onFailure` why the VM does not answer: the first failed check and then one at most every minute.
   */
  waitUntilReady(timeoutMs: number, onWaiting?: () => void, onFailure?: (reason: string) => void): Promise<void>;
  /** Installs the staged session release unless the VM runs it already; `onInstall` hears when it does. */
  ensureRelease(onInstall?: () => void): Promise<ReleaseInfo>;
  /** Unpacks `files` (name → text, mode 0600) into the agent's ~/.claude through `hunt-ctl put-files <id> --claude`. */
  putClaudeFiles(id: string, files: Record<string, string>): Promise<void>;
  /** A connection to the session's relay socket. */
  openRelay(): Transport;
}

const HOUR_MS = 60 * 60_000;
const READY_POLL_MS = 10_000;
const READY_FAILURE_REPORT_MS = 60_000;

/** The session VM `vm` at `location`; `log` hears every command run there, with its outcome and duration. */
export function sessionVm(vm: string, location: VmLocation, log: Log = () => {}): SessionVm {
  const gcloud = (command: string, input: Buffer | string, timeoutMs: number, what: string) =>
    run("gcloud", sshArgs(vm, location, command), input, timeoutMs, what, log);

  const self: SessionVm = {
    async run(command, input = "", timeoutMs = 10 * 60_000) {
      return (await gcloud(command, input, timeoutMs, `run a command on ${vm}`)).toString("utf8");
    },
    async huntCtl(args, input = "", timeoutMs = HOUR_MS) {
      const output = (await gcloud(shellCommand("sudo", ["-n", "hunt-ctl", ...args]), input, timeoutMs, `run hunt-ctl ${args[0]} on ${vm}`)).toString("utf8").trim();
      if (!output) return {};
      try {
        return JSON.parse(output) as Record<string, unknown>;
      } catch {
        throw new Error(`failed to read the output of hunt-ctl ${args[0]} on ${vm}: ${output.slice(0, 300)}`);
      }
    },
    async waitUntilReady(timeoutMs, onWaiting, onFailure) {
      const deadline = Date.now() + timeoutMs;
      let reason = `${READY_STAMP} is still missing`;
      let isWaiting = false;
      let reportedAt = -Infinity;
      while (Date.now() < deadline) {
        try {
          const answer = await gcloud(`test -e ${READY_STAMP} && echo ready || true`, "", 2 * 60_000, `check the ready stamp of ${vm}`);
          if (answer.toString("utf8").trim() === "ready") return;
        } catch (error) {
          reason = (error as Error).message;
          if (Date.now() - reportedAt >= READY_FAILURE_REPORT_MS) {
            reportedAt = Date.now();
            onFailure?.(reason);
          }
        }
        if (!isWaiting) {
          isWaiting = true;
          onWaiting?.();
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      }
      const minutes = Math.round(timeoutMs / 60_000);
      throw new ApiError("unavailable", `failed to set up ${vm}: its startup script did not finish within ${minutes} minutes: ${tail(reason)}`);
    },
    async ensureRelease(onInstall) {
      const staged = readStagedRelease();
      const installed = (await gcloud(`cat ${INSTALLED_HASH} 2>/dev/null || true`, "", 2 * 60_000, `read the installed release of ${vm}`)).toString("utf8").trim();
      if (installed === staged.hash) return staged.info;
      onInstall?.();
      const archive = await run("tar", ["-czf", "-", "-C", staged.dir, "."], "", 5 * 60_000, "pack the session release", log);
      const what = `install the session release ${staged.info.version ?? staged.hash} on ${vm}`;
      const output = (await gcloud(shellCommand("sudo", ["-n", "sh", "-c", installScript(staged.hash)]), archive, HOUR_MS, what)).toString("utf8").trim();
      let result: { hash?: unknown } | null = null;
      try {
        result = JSON.parse(output) as { hash?: unknown };
      } catch {
        result = null;
      }
      if (result?.hash !== staged.hash) throw new Error(`failed to ${what}: hunt-ctl install reported ${output.slice(0, 300) || "nothing"}`);
      return staged.info;
    },
    async putClaudeFiles(id, files) {
      const dir = mkdtempSync(join(tmpdir(), "hunt-swf-"));
      try {
        for (const [name, text] of Object.entries(files)) {
          writeFileSync(join(dir, name), text, { mode: 0o600 });
        }
        const archive = await run("tar", ["-czf", "-", "-C", dir, "."], "", 60_000, "pack the session files", log);
        await self.huntCtl(["put-files", id, "--claude"], archive);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    openRelay() {
      const startedAt = Date.now();
      const child = spawn("gcloud", sshArgs(vm, location, RELAY_COMMAND), { stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", (error) => log(`connect to the relay of ${vm}: failed: ${error.message}`, "error"));
      child.on("close", (code) => {
        const outcome = code ? `ended with exit status ${code}${stderr.trim() ? `\n${tail(stderr)}` : ""}` : "ended";
        log(`connection to the relay of ${vm}: ${outcome} after ${Date.now() - startedAt} ms`, code ? "warn" : "info");
      });
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.stdin.on("error", () => {});
      return {
        write: (text) => {
          child.stdin.write(text);
        },
        onData: (listener) => {
          child.stdout.on("data", listener);
        },
        onClose: (listener) => {
          child.on("error", (error) => listener(error.message));
          child.on("close", (code) => listener(code ? `exit status ${code}${stderr.trim() ? `: ${tail(stderr)}` : ""}` : undefined));
        },
        close: () => {
          child.stdin.end();
          // ssh ends once socat saw the end of stdin; the kill only covers a connection that hangs.
          setTimeout(() => child.kill("SIGTERM"), 10_000).unref();
        },
      };
    },
  };
  return self;
}
