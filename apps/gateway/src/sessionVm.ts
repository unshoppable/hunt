/**
 * hunt-swf's access to a session VM: `gcloud compute ssh <vm> --internal-ip` with the gateway's service account, which
 * logs in through OS Login as an admin and runs `hunt-ctl` with sudo, as Hunt does over its IAP tunnel. Installing
 * the bundle follows `bundle::ensure_installed` in `apps/client/src-tauri/src/remote/bundle.rs`: the gateway's own release is the
 * bundle.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "./acpClient.ts";

/** The gateway's installed release, which session VMs get as their bundle. */
export const RELEASE_DIR = "/srv/hunt/current";
const READY_STAMP = "/var/lib/hunt/session-ready";
const RELAY_COMMAND = "sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock";
const STDERR_TAIL_LINES = 15;

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

/** The arguments of `gcloud` that run `command` on the VM `vm`. */
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
    "--command",
    command,
  ];
}

/** The script that unpacks the bundle on stdin into its own folder and installs it there, as `bundle.rs` does. */
export function installScript(hash: string, incoming = `/srv/hunt/incoming/${randomUUID()}`): string {
  const install = shellCommand(`${incoming}/vm/hunt-ctl`, ["install", incoming]);
  return (
    `set -e; mkdir -p ${incoming}; trap 'rm -rf ${incoming}' EXIT; tar -xzf - -C ${incoming}; printf %s ${hash} > ${incoming}/.hash; ` +
    `find ${incoming}/vm -maxdepth 1 -type f -name 'hunt-*' -exec chmod +x {} +; ${install}`
  );
}

/** The last lines of a command's error output. */
function tail(text: string): string {
  return text.trim().split("\n").slice(-STDERR_TAIL_LINES).join("\n");
}

/** Runs `program` with `args`, `input` on stdin; resolves with stdout, rejects with the end of stderr. */
function run(program: string, args: string[], input: Buffer | string, timeoutMs: number, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`failed to ${what}: no result within ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`failed to ${what}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(`failed to ${what}: exit status ${code}${stderr.trim() ? `\n${tail(stderr)}` : ""}`));
      }
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
  /** Waits until the VM answers over SSH and its startup script wrote the ready stamp. */
  waitUntilReady(timeoutMs: number, pollMs?: number): Promise<void>;
  /** Installs the gateway's release unless the VM runs it already. */
  installBundle(): Promise<void>;
  /** Unpacks `files` (name → text, mode 0600) into the agent's ~/.claude through `hunt-ctl put-files <id> --claude`. */
  putClaudeFiles(id: string, files: Record<string, string>): Promise<void>;
  /** A connection to the session's relay socket. */
  openRelay(): Transport;
}

const HOUR_MS = 60 * 60_000;

export function sessionVm(vm: string, location: VmLocation): SessionVm {
  const gcloud = (command: string, input: Buffer | string, timeoutMs: number, what: string) => run("gcloud", sshArgs(vm, location, command), input, timeoutMs, what);

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
    async waitUntilReady(timeoutMs, pollMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      let reason = `${READY_STAMP} is still missing`;
      while (Date.now() < deadline) {
        try {
          if ((await self.run(`test -e ${READY_STAMP} && echo ready || true`, "", 2 * 60_000)).trim() === "ready") return;
        } catch (error) {
          reason = (error as Error).message;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      throw new Error(`failed to set up ${vm}: its startup script did not finish within ${Math.round(timeoutMs / 60_000)} minutes: ${tail(reason)}`);
    },
    async installBundle() {
      const hash = readFileSync(join(RELEASE_DIR, ".hash"), "utf8").trim();
      if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error(`failed to install the bundle on ${vm}: ${RELEASE_DIR}/.hash holds no bundle hash`);
      const installed = await self.run("cat /var/lib/hunt/installed-hash 2>/dev/null || true");
      if (installed.trim() === hash) return;
      const archive = await run("tar", ["-czf", "-", "-C", RELEASE_DIR, "."], "", 5 * 60_000, "pack the bundle");
      await gcloud(shellCommand("sudo", ["-n", "sh", "-c", installScript(hash)]), archive, HOUR_MS, `install the bundle on ${vm}`);
    },
    async putClaudeFiles(id, files) {
      const dir = mkdtempSync(join(tmpdir(), "hunt-swf-"));
      try {
        for (const [name, text] of Object.entries(files)) {
          writeFileSync(join(dir, name), text, { mode: 0o600 });
        }
        const archive = await run("tar", ["-czf", "-", "-C", dir, "."], "", 60_000, "pack the session files");
        await self.huntCtl(["put-files", id, "--claude"], archive);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    openRelay() {
      const child = spawn("gcloud", sshArgs(vm, location, RELAY_COMMAND), { stdio: ["pipe", "pipe", "pipe"] });
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
