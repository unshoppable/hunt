/**
 * Writes a session VM's configuration from the `preview` section of its repository's hunt.json (see `config.ts`);
 * `hunt-ctl session-config` runs it as root:
 *
 *   node configCli.ts --worktree <dir> --short <8 hex digits> --domain <domain> --env-out <file> --caddy-out <file>
 *
 * Writes the session's environment as a systemd EnvironmentFile to --env-out and the Caddy configuration of the VM's
 * preview proxy to --caddy-out, each through a temporary file and a rename, mode 0644. Prints one line of JSON:
 * `{"ok": true, "hunt_md": "…"}`, with the text of the repository's HUNT.md (instructions for Hunt sessions, at most
 * 20 KiB) when it has one, or `{"ok": false, "problems": […]}`, each problem starting with the path of the offending
 * value; then it writes nothing and exits with 1. The agent controls the worktree, so hunt.json and HUNT.md are read
 * only as regular files, never through a symlink.
 */
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "../relay/relay.ts";
import { buildSessionConfig, ConfigError, envFile } from "./config.ts";

const HUNT_JSON_MAX_BYTES = 256 * 1024;
const HUNT_MD_MAX_BYTES = 20 * 1024;
const USAGE = "usage: configCli.ts --worktree <dir> --short <8 hex digits> --domain <domain> --env-out <file> --caddy-out <file>";
const FLAGS = { "--worktree": "worktree", "--short": "short", "--domain": "domain", "--env-out": "envOut", "--caddy-out": "caddyOut" } as const;

type Options = Record<(typeof FLAGS)[keyof typeof FLAGS], string>;

interface Result {
  ok: boolean;
  problems?: string[];
  hunt_md?: string;
}

function parseArguments(args: string[]): Options {
  const options: Partial<Options> = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (!Object.hasOwn(FLAGS, flag)) throw new Error(`unknown argument ${flag}; ${USAGE}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[FLAGS[flag as keyof typeof FLAGS]] = value;
  }
  const missing = Object.entries(FLAGS).filter(([, key]) => !options[key]);
  if (missing.length > 0) throw new Error(`missing ${missing.map(([flag]) => flag).join(", ")}; ${USAGE}`);
  return options as Options;
}

/** The regular file `name` in `dir` as text, undefined when there is none; anything else is a problem. */
function readWorktreeFile(dir: string, name: string, maxBytes: number, problems: string[]): string | undefined {
  let descriptor: number;
  try {
    // O_NONBLOCK keeps a FIFO in place of the file from blocking the open.
    descriptor = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    problems.push(code === "ELOOP" ? `${name}: must be a file, not a symlink` : `${name}: cannot be read: ${messageOf(error)}`);
    return undefined;
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      problems.push(`${name}: must be a file`);
      return undefined;
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes) {
      problems.push(`${name}: is larger than ${maxBytes} bytes`);
      return undefined;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(descriptor);
  }
}

/** Replaces `path` with `text` at once, so that no reader sees a partial file. */
function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, path);
}

function run(args: string[]): Result {
  const options = parseArguments(args);
  const problems: string[] = [];
  const huntJsonText = readWorktreeFile(options.worktree, "hunt.json", HUNT_JSON_MAX_BYTES, problems);
  const huntMd = readWorktreeFile(options.worktree, "HUNT.md", HUNT_MD_MAX_BYTES, problems)?.trim();
  let huntJson: unknown;
  try {
    huntJson = huntJsonText === undefined ? undefined : JSON.parse(huntJsonText);
  } catch (error) {
    problems.push(`hunt.json: not valid JSON: ${messageOf(error)}`);
  }
  try {
    const config = buildSessionConfig(huntJson, { short: options.short, domain: options.domain });
    if (problems.length > 0) return { ok: false, problems };
    writeAtomic(options.envOut, envFile(config.env));
    writeAtomic(options.caddyOut, `${JSON.stringify(config.proxy, null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, problems: [...problems, ...error.problems] };
  }
  return huntMd ? { ok: true, hunt_md: huntMd } : { ok: true };
}

function main(): void {
  let result: Result;
  try {
    result = run(process.argv.slice(2));
  } catch (error) {
    result = { ok: false, problems: [messageOf(error)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main();
