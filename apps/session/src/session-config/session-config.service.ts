/**
 * What `session-config.main.ts` runs (its comment documents the command line and the output): reads hunt.json and
 * hunt.agent.md of the worktree, as regular files only, and the remote secrets, builds the session's configuration from
 * them (`buildSessionConfig`), checks that the worktree holds the skill file of every agent step when hunt.json has a
 * `swf` section and writes its files, or looks a check up.
 */
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { parseRemoteSecrets } from "../../../../libs/domain/src/remote-secrets/remote-secrets.utils.ts";
import type { AgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { ConfigError } from "./config.error.ts";
import { HuntJson } from "./hunt-json.value-object.ts";
import type { CaddyConfig } from "./preview-proxy.types.ts";
import { proxyConfig } from "./preview-proxy.utils.ts";
import { at } from "./problems.utils.ts";
import type { ServiceConfig } from "./service-config.value-object.ts";
import { envFile, serviceEnvs, sessionEnv } from "./service-environment.utils.ts";
import { servicesPrompt } from "./services-prompt.utils.ts";
import { SessionHost } from "./session-host.value-object.ts";

const HUNT_JSON_MAX_BYTES = 256 * 1024;
const AGENT_MD_NAME = "hunt.agent.md";
const AGENT_MD_MAX_BYTES = 20 * 1024;
const ENV_SUFFIX = ".env";
const USAGE =
  "usage: configCli.ts --worktree <dir> --short <8 hex digits> --domain <domain> --env-out <file> --caddy-out <file> --services-dir <dir> " +
  "[--secrets <file>], or configCli.ts --worktree <dir> --check <name>";
const FLAGS = {
  "--worktree": "worktree",
  "--short": "short",
  "--domain": "domain",
  "--env-out": "envOut",
  "--caddy-out": "caddyOut",
  "--services-dir": "servicesDir",
} as const;
const OPTIONAL_FLAGS = { "--secrets": "secrets" } as const;
const CHECK_FLAG = "--check";
const CHECK_FLAGS = { "--worktree": "worktree", [CHECK_FLAG]: "check" } as const;

type Options = Record<(typeof FLAGS)[keyof typeof FLAGS], string> & Partial<Record<(typeof OPTIONAL_FLAGS)[keyof typeof OPTIONAL_FLAGS], string>>;
type CheckOptions = Record<(typeof CHECK_FLAGS)[keyof typeof CHECK_FLAGS], string>;
/** Flag → the key of its value. */
type Flags = Readonly<Record<string, string>>;

interface ServiceSummary {
  name: string;
  port: number;
  tls: boolean;
  guarded: boolean;
}

/** Everything the session VM needs of hunt.json and the session's host names. */
export interface SessionConfig {
  /** In the order of hunt.json. */
  services: ServiceConfig[];
  /** The session's environment, which every command on the VM inherits. */
  env: Record<string, string>;
  /**
   * The environment of each service by name: its variables with their placeholders resolved, its remote secrets, then
   * HUNT_SERVICE_DIR and HUNT_SERVICE_COMMAND.
   */
  serviceEnvs: Record<string, Record<string, string>>;
  proxy: CaddyConfig;
  /** The section of the agent's prompt that lists the services; it says so without services. */
  servicesPrompt: string;
  /** `swf.model` of hunt.json; null without one. */
  swfModel: string | null;
  /** `swf.humanReviewPaths` of hunt.json, glob patterns relative to the worktree; empty without one. */
  swfHumanReviewPaths: string[];
  /** The skill of every agent step, `swf.skills` of hunt.json, which names them all; null without the `swf` section. */
  swfSkills: Record<AgentStep, string> | null;
}

/** What the command prints as one line of JSON. */
export interface SessionConfigResult {
  ok: boolean;
  problems?: string[];
  services?: ServiceSummary[];
  services_prompt?: string;
  agent_md?: string;
  swf_model?: string;
  swf_human_review_paths?: string[];
  swf_skills?: Record<AgentStep, string>;
  command?: string;
  cwd?: string | null;
}

/** The value of each flag in `args` by the key `required` or `optional` maps it to; every flag of `required` must be given. */
function parseArguments(args: string[], required: Flags, optional: Flags = {}): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    const key = Object.hasOwn(required, flag) ? required[flag] : Object.hasOwn(optional, flag) ? optional[flag] : undefined;
    if (!key) throw new Error(`unknown argument ${flag}; ${USAGE}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    options[key] = value;
  }
  const missing = Object.entries(required).filter(([, key]) => !options[key]);
  if (missing.length > 0) throw new Error(`missing ${missing.map(([flag]) => flag).join(", ")}; ${USAGE}`);
  return options;
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

/**
 * Reports each agent step whose skill (`skills`, by step) has no file `.claude/skills/<name>/SKILL.md` in the worktree
 * `dir`, where Claude Code looks for it.
 */
function reportMissingSkillFiles(dir: string, skills: Readonly<Record<AgentStep, string>>, problems: string[]): void {
  for (const [step, name] of Object.entries(skills)) {
    const file = `.claude/skills/${name}/SKILL.md`;
    if (statSync(join(dir, file), { throwIfNoEntry: false })?.isFile()) continue;
    problems.push(`${at(at("swf", "skills"), step)}: no skill file ${file}; Hunt offers to create it when a session of the repository opens`);
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

/** The parsed hunt.json of the worktree `dir`, undefined without one; anything else is a problem. */
function readHuntJson(dir: string, problems: string[]): unknown {
  const text = readWorktreeFile(dir, "hunt.json", HUNT_JSON_MAX_BYTES, problems);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`hunt.json: not valid JSON: ${messageOf(error)}`);
    return undefined;
  }
}

/**
 * Checks `huntJson` (the parsed file, undefined without one) and the session's host names and builds everything the
 * session VM needs; `worktree` is the session's worktree on the VM and `secrets` the remote secrets the gateway put
 * there, of which every one a service names must exist. Throws a ConfigError with the problems of the host names first.
 */
export function buildSessionConfig(
  huntJson: unknown,
  host: Pick<SessionHost, "short" | "domain">,
  worktree: string,
  secrets: Readonly<Record<string, string>> = {},
): SessionConfig {
  const parsedHost = SessionHost.fromParts(host);
  const parsedHuntJson = HuntJson.fromDocument(huntJson, new Set(Object.keys(secrets)));
  if (parsedHost.problems || parsedHuntJson.problems) {
    throw new ConfigError([...(parsedHost.problems ?? []), ...(parsedHuntJson.problems ?? [])]);
  }
  const { sessionHost } = parsedHost;
  const { services, swf } = parsedHuntJson.huntJson;
  return {
    services,
    env: sessionEnv(sessionHost),
    serviceEnvs: serviceEnvs(services, sessionHost, worktree, secrets),
    proxy: proxyConfig(services, sessionHost),
    servicesPrompt: servicesPrompt(services, sessionHost),
    swfModel: swf?.model ?? null,
    swfHumanReviewPaths: swf?.humanReviewPaths ?? [],
    swfSkills: swf?.skills ?? null,
  };
}

/** The command line and folder of the check `options.check` of the worktree's hunt.json. */
function runCheck(options: CheckOptions): SessionConfigResult {
  const problems: string[] = [];
  const huntJson = readHuntJson(options.worktree, problems);
  if (problems.length > 0) return { ok: false, problems };
  const parsed = HuntJson.fromDocument(huntJson);
  if (parsed.problems) return { ok: false, problems: parsed.problems };
  try {
    const { command, cwd } = parsed.huntJson.findCheck(options.check);
    return { ok: true, command, cwd };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, problems: error.problems };
  }
}

/** Runs the command line `args`: writes the session's configuration, or with --check looks the check up. */
export function runSessionConfig(args: string[]): SessionConfigResult {
  if (args.includes(CHECK_FLAG)) return runCheck(parseArguments(args, CHECK_FLAGS) as CheckOptions);
  const options = parseArguments(args, FLAGS, OPTIONAL_FLAGS) as Options;
  const problems: string[] = [];
  const huntJson = readHuntJson(options.worktree, problems);
  const agentMd = readWorktreeFile(options.worktree, AGENT_MD_NAME, AGENT_MD_MAX_BYTES, problems)?.trim();
  const secrets = readRemoteSecrets(options.secrets, problems);
  let result: SessionConfigResult;
  try {
    const config = buildSessionConfig(huntJson, { short: options.short, domain: options.domain }, options.worktree, secrets);
    if (config.swfSkills) {
      reportMissingSkillFiles(options.worktree, config.swfSkills, problems);
    }
    if (problems.length > 0) return { ok: false, problems };
    writeAtomic(options.envOut, envFile(config.env, "The session's environment, written by Hunt."));
    writeAtomic(options.caddyOut, `${JSON.stringify(config.proxy, null, 2)}\n`);
    writeServiceEnvs(options.servicesDir, config.serviceEnvs);
    const services = config.services.map(({ name, port, tls, guarded }) => ({ name, port, tls, guarded }));
    result = {
      ok: true,
      services,
      services_prompt: config.servicesPrompt,
      ...(config.swfModel ? { swf_model: config.swfModel } : {}),
      ...(config.swfHumanReviewPaths.length > 0 ? { swf_human_review_paths: config.swfHumanReviewPaths } : {}),
      ...(config.swfSkills ? { swf_skills: config.swfSkills } : {}),
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, problems: [...problems, ...error.problems] };
  }
  return agentMd ? { ...result, agent_md: agentMd } : result;
}
