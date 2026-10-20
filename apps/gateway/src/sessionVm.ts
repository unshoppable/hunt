/**
 * The gateway's access to a session VM: `gcloud compute ssh <vm> --internal-ip` with the gateway's service account,
 * which logs in through OS Login as an admin and runs `hunt-ctl` with sudo, and then the ssh command gcloud runs for it
 * (`sshCommands`). Connections to one VM share one SSH connection (ControlMaster), so a setup's many commands pay for
 * one handshake. The gateway hands the session VMs the session release CI staged on it (`hunt-ctl stage-session`,
 * `/srv/hunt/session-current`).
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
/**
 * Prints `ready`, on the next line the hash of the installed session release (an empty line without one) and, once
 * `hunt-ctl put-remote-secrets` took the remote secrets on stdin, `secrets` on a third line, all only once the startup
 * script wrote the ready stamp; nothing before that. Exits 0 either way, so that only an SSH failure fails the check.
 * Putting the secrets here spares the bring-up an SSH round trip; a release too old for the command prints no third
 * line, and the secrets are put after the release is installed.
 */
export const READY_COMMAND =
  `test -e ${READY_STAMP} && { echo ready; echo "$(cat ${INSTALLED_HASH} 2>/dev/null)"; sudo -n hunt-ctl put-remote-secrets >/dev/null 2>&1 && echo secrets; } || true`;
const RELAY_COMMAND = "sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock";
/** The idle check of the session release on the VM, which prints its decision and changes nothing. */
const IDLE_CHECK_COMMAND = "sudo -n /srv/hunt/current/vm/hunt-idle-check --dry-run";
const IDLE_CHECK_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 15;
/** ssh's exit status when it could not connect or lost the connection. */
const SSH_FAILED = 255;
const DRY_RUN_COMMAND = "true";

/**
 * The ssh command line gcloud runs for a VM, by `project/zone/vm`, learned with `--dry-run` after gcloud reached the
 * VM. Later commands run through plain ssh and skip gcloud's start and API lookups (1.5–2.5 s each); a failed
 * connection drops the entry and that command goes through gcloud again.
 */
const sshCommands = new Map<string, string[]>();
/** The keys of `sshCommands` whose `--dry-run` runs. */
const learningSshCommands = new Set<string>();

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

/**
 * The ssh command line, without the remote command, in the output of `gcloud compute ssh --dry-run` for
 * `DRY_RUN_COMMAND`; null when the output is not one that splits safely at spaces.
 */
export function parseDryRun(output: string): string[] | null {
  const words = output.trim().split(/\s+/);
  if (words.length < 4 || !/(^|\/)ssh$/.test(words[0])) return null;
  if (words.at(-2) !== "--" || words.at(-1) !== DRY_RUN_COMMAND) return null;
  if (words.some((word) => /['"\\$`]/.test(word))) return null;
  return words.slice(0, -1);
}

/** What `READY_COMMAND` reported of a ready VM. */
export interface ReadyAnswer {
  /** The hash of the installed session release, empty when the VM has none. */
  installedHash: string;
  /** Whether the VM took the remote secrets with the check. */
  hasSecrets: boolean;
}

/** The answer in the output of `READY_COMMAND`; null while the VM is not ready. */
export function parseReadyAnswer(output: string): ReadyAnswer | null {
  const [first = "", second = "", third = ""] = output.trim().split("\n");
  if (first.trim() !== "ready") return null;
  return { installedHash: second.trim(), hasSecrets: third.trim() === "secrets" };
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

/** A failed command; `exitStatus` is null when it did not exit on its own. */
class CommandError extends Error {
  readonly exitStatus: number | null;

  constructor(message: string, exitStatus: number | null) {
    super(message);
    this.exitStatus = exitStatus;
  }
}

/**
 * Runs `program` with `args`, `input` on stdin; resolves with stdout, rejects with a `CommandError` that carries the
 * end of stderr. `log` hears the outcome and the duration.
 */
function run(program: string, args: string[], input: Buffer | string, timeoutMs: number, what: string, log: Log): Promise<Buffer> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    let isSettled = false;
    const fail = (reason: string, exitStatus: number | null = null) => {
      clearTimeout(timer);
      if (isSettled) return;
      isSettled = true;
      log(`${what}: failed after ${Date.now() - startedAt} ms: ${reason}`, "error");
      reject(new CommandError(`failed to ${what}: ${reason}`, exitStatus));
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
      if (code !== 0) return fail(`exit status ${code}${stderr.trim() ? `\n${tail(stderr)}` : ""}`, code);
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
   * Waits until the VM answers over SSH and its startup script wrote the ready stamp, hands it the remote secrets
   * `secrets` (name → value) with the same command, and returns the hash of the session release installed on it, empty
   * without one, and whether it took the secrets. `onWaiting` hears the first miss, `onFailure` why the VM does not
   * answer: the first failed check and then one at most every minute.
   */
  waitUntilReady(timeoutMs: number, secrets: Record<string, string>, onWaiting?: () => void, onFailure?: (reason: string) => void): Promise<ReadyAnswer>;
  /**
   * Installs the staged session release unless `installedHash`, the hash `waitUntilReady` returned, is its hash;
   * `onInstall` hears when it does.
   */
  ensureRelease(installedHash: string, onInstall?: () => void): Promise<ReleaseInfo>;
  /** Unpacks `files` (name → text, mode 0600) into the agent's ~/.claude through `hunt-ctl put-files <id> --claude`. */
  putClaudeFiles(id: string, files: Record<string, string>): Promise<void>;
  /**
   * The decision of the VM's idle check (`apps/session/vm/hunt-idle-check --dry-run`): `keep: <reason>`, `idle: <reason>`
   * or `poweroff: <reason>`.
   */
  idleDecision(): Promise<string>;
  /** A connection to the session's relay socket. */
  openRelay(): Transport;
}

const HOUR_MS = 60 * 60_000;
const READY_POLL_MS = 2_000;
const READY_FAILURE_REPORT_MS = 60_000;

/** The session VM `vm` at `location`; `log` hears every command run there, with its outcome and duration. */
export function sessionVm(vm: string, location: VmLocation, log: Log = () => {}): SessionVm {
  const key = `${location.project}/${location.zone}/${vm}`;
  const learnSshCommand = () => {
    if (learningSshCommands.has(key) || sshCommands.has(key)) return;
    learningSshCommands.add(key);
    const args = [...sshArgs(vm, location, DRY_RUN_COMMAND), "--dry-run"];
    void run("gcloud", args, "", 60_000, `look up the ssh command of ${vm}`, log)
      .then((output) => {
        const command = parseDryRun(output.toString("utf8"));
        if (command) {
          sshCommands.set(key, command);
        }
      })
      .catch(() => {})
      .finally(() => {
        learningSshCommands.delete(key);
      });
  };
  const onVm = async (command: string, input: Buffer | string, timeoutMs: number, what: string) => {
    const ssh = sshCommands.get(key);
    if (ssh) {
      try {
        return await run(ssh[0], [...ssh.slice(1), command], input, timeoutMs, what, log);
      } catch (error) {
        if (!(error instanceof CommandError) || error.exitStatus !== SSH_FAILED) throw error;
        if (sshCommands.get(key) === ssh) {
          sshCommands.delete(key);
        }
      }
    }
    const output = await run("gcloud", sshArgs(vm, location, command), input, timeoutMs, what, log);
    learnSshCommand();
    return output;
  };

  const self: SessionVm = {
    async run(command, input = "", timeoutMs = 10 * 60_000) {
      return (await onVm(command, input, timeoutMs, `run a command on ${vm}`)).toString("utf8");
    },
    async huntCtl(args, input = "", timeoutMs = HOUR_MS) {
      const output = (await onVm(shellCommand("sudo", ["-n", "hunt-ctl", ...args]), input, timeoutMs, `run hunt-ctl ${args[0]} on ${vm}`)).toString("utf8").trim();
      if (!output) return {};
      try {
        return JSON.parse(output) as Record<string, unknown>;
      } catch {
        throw new Error(`failed to read the output of hunt-ctl ${args[0]} on ${vm}: ${output.slice(0, 300)}`);
      }
    },
    async waitUntilReady(timeoutMs, secrets, onWaiting, onFailure) {
      const deadline = Date.now() + timeoutMs;
      const input = JSON.stringify(secrets);
      let reason = `${READY_STAMP} is still missing`;
      let isWaiting = false;
      let reportedAt = -Infinity;
      while (Date.now() < deadline) {
        try {
          const answer = parseReadyAnswer((await onVm(READY_COMMAND, input, 2 * 60_000, `check the ready stamp of ${vm}`)).toString("utf8"));
          if (answer !== null) return answer;
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
    async ensureRelease(installedHash, onInstall) {
      const staged = readStagedRelease();
      if (installedHash === staged.hash) return staged.info;
      onInstall?.();
      const archive = await run("tar", ["-czf", "-", "-C", staged.dir, "."], "", 5 * 60_000, "pack the session release", log);
      const what = `install the session release ${staged.info.version ?? staged.hash} on ${vm}`;
      const output = (await onVm(shellCommand("sudo", ["-n", "sh", "-c", installScript(staged.hash)]), archive, HOUR_MS, what)).toString("utf8").trim();
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
    async idleDecision() {
      return (await onVm(IDLE_CHECK_COMMAND, "", IDLE_CHECK_TIMEOUT_MS, `run the idle check of ${vm}`)).toString("utf8").trim();
    },
    openRelay() {
      const startedAt = Date.now();
      const ssh = sshCommands.get(key);
      const [program, args] = ssh ? [ssh[0], [...ssh.slice(1), RELAY_COMMAND]] : ["gcloud", sshArgs(vm, location, RELAY_COMMAND)];
      const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", (error) => log(`connect to the relay of ${vm}: failed: ${error.message}`, "error"));
      child.on("close", (code) => {
        if (code === SSH_FAILED && ssh && sshCommands.get(key) === ssh) {
          sshCommands.delete(key);
        }
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
