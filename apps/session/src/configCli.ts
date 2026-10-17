/**
 * Writes a session VM's configuration from its repository's hunt.json (see `config.ts`); `hunt-ctl session-config` runs
 * it as root:
 *
 *   node configCli.ts --worktree <dir> --short <8 hex digits> --domain <domain> --env-out <file> --caddy-out <file>
 *     --services-dir <dir> [--secrets <file>]
 *
 * --secrets names the remote secrets the gateway put on the VM (`/etc/hunt/remote-secrets.json`, the JSON object of
 * `libs/domain/src/remoteSecrets.ts`), from which the services get the ones their `remoteSecrets` name; a missing file
 * means none.
 *
 * Writes the session's environment as a systemd EnvironmentFile to --env-out, the Caddy configuration of the VM's
 * preview proxy to --caddy-out and the environment of each service to `<services-dir>/<name>.env`, each through a
 * temporary file and a rename, mode 0644; the services' files, which hold remote secrets and only systemd reads, get
 * 0600. It creates --services-dir (0755) when it is missing and deletes the `*.env` files there of services that
 * hunt.json no longer declares; other files stay. Prints one line of JSON:
 * `{"ok": true, "services": [{"name", "port", "tls", "guarded"}], "services_prompt": "…", "agent_md": "…"}` with the
 * services in the order of hunt.json, the section of the agent's prompt that lists them (or says there are none) and
 * the text of the repository's hunt.agent.md (instructions for the agent, at most 20 KiB) when it has one, or
 * `{"ok": false, "problems": […]}`, each problem starting with the path of the offending value; then it writes nothing
 * and exits with 1. The agent controls the worktree, so hunt.json and hunt.agent.md are read only as regular files,
 * never through a symlink.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "../../../libs/domain/src/errors.ts";
import { parseRemoteSecrets } from "../../../libs/domain/src/remoteSecrets.ts";
import { buildSessionConfig, ConfigError, envFile } from "./config.ts";

const HUNT_JSON_MAX_BYTES = 256 * 1024;
const AGENT_MD_NAME = "hunt.agent.md";
const AGENT_MD_MAX_BYTES = 20 * 1024;
const ENV_SUFFIX = ".env";
const USAGE =
  "usage: configCli.ts --worktree <dir> --short <8 hex digits> --domain <domain> --env-out <file> --caddy-out <file> --services-dir <dir> " +
  "[--secrets <file>]";
const FLAGS = {
  "--worktree": "worktree",
  "--short": "short",
  "--domain": "domain",
  "--env-out": "envOut",
  "--caddy-out": "caddyOut",
  "--services-dir": "servicesDir",
} as const;
const OPTIONAL_FLAGS = { "--secrets": "secrets" } as const;

type Options = Record<(typeof FLAGS)[keyof typeof FLAGS], string> & Partial<Record<(typeof OPTIONAL_FLAGS)[keyof typeof OPTIONAL_FLAGS], string>>;

interface ServiceSummary {
  name: string;
  port: number;
  tls: boolean;
  guarded: boolean;
}

interface Result {
  ok: boolean;
  problems?: string[];
  services?: ServiceSummary[];
  services_prompt?: string;
  agent_md?: string;
}

function parseArguments(args: string[]): Options {
  const options: Partial<Options> = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    const key = Object.hasOwn(FLAGS, flag) ? FLAGS[flag as keyof typeof FLAGS] : OPTIONAL_FLAGS[flag as keyof typeof OPTIONAL_FLAGS];
    if (!key) throw new Error(`unknown argument ${flag}; ${USAGE}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[key] = value;
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

/** The remote secrets in the file `path`, none without the file or a path; anything else is a problem. */
function readRemoteSecrets(path: string | undefined, problems: string[]): Record<string, string> {
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    problems.push(`remote secrets: cannot read ${path}: ${messageOf(error)}`);
    return {};
  }
  try {
    return parseRemoteSecrets(text);
  } catch (error) {
    problems.push(`remote secrets: ${path}: ${messageOf(error)}`);
    return {};
  }
}

/** Replaces `path` with `text` at once, so that no reader sees a partial file. */
function writeAtomic(path: string, text: string, mode = 0o644): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

/** Writes `<dir>/<name>.env` for each entry of `envs` and deletes every other `*.env` file in `dir`. */
function writeServiceEnvs(dir: string, envs: Record<string, Record<string, string>>): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const [name, env] of Object.entries(envs)) {
    writeAtomic(join(dir, `${name}${ENV_SUFFIX}`), envFile(env, `The environment of the service ${name} from the repository's hunt.json.`), 0o600);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || !entry.name.endsWith(ENV_SUFFIX)) continue;
    if (Object.hasOwn(envs, entry.name.slice(0, -ENV_SUFFIX.length))) continue;
    rmSync(join(dir, entry.name));
  }
}

function run(args: string[]): Result {
  const options = parseArguments(args);
  const problems: string[] = [];
  const huntJsonText = readWorktreeFile(options.worktree, "hunt.json", HUNT_JSON_MAX_BYTES, problems);
  const agentMd = readWorktreeFile(options.worktree, AGENT_MD_NAME, AGENT_MD_MAX_BYTES, problems)?.trim();
  const secrets = readRemoteSecrets(options.secrets, problems);
  let huntJson: unknown;
  try {
    huntJson = huntJsonText === undefined ? undefined : JSON.parse(huntJsonText);
  } catch (error) {
    problems.push(`hunt.json: not valid JSON: ${messageOf(error)}`);
  }
  let result: Result;
  try {
    const config = buildSessionConfig(huntJson, { short: options.short, domain: options.domain }, options.worktree, secrets);
    if (problems.length > 0) return { ok: false, problems };
    writeAtomic(options.envOut, envFile(config.env, "The session's environment, written by Hunt."));
    writeAtomic(options.caddyOut, `${JSON.stringify(config.proxy, null, 2)}\n`);
    writeServiceEnvs(options.servicesDir, config.serviceEnvs);
    const services = config.services.map(({ name, port, tls, guarded }) => ({ name, port, tls, guarded }));
    result = { ok: true, services, services_prompt: config.servicesPrompt };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, problems: [...problems, ...error.problems] };
  }
  return agentMd ? { ...result, agent_md: agentMd } : result;
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
