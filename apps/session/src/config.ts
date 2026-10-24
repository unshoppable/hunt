/**
 * A repository's `hunt.json` in contract version 3: the services of the repository, which Hunt runs on a session's VM
 * as systemd units that the agent starts when its task needs them, each with the ignored files it needs in a worktree,
 * the checks a person runs from the client's Checks tab, and the settings of the sessions the gateway's poller starts
 * for the repository's `swf` issues.
 *
 *   {
 *     "version": 3,
 *     "swf": { "model": "claude-opus-5-5" },
 *     "services": {
 *       "backend": {
 *         "command": "npm run start:backend", "port": 3000, "tls": true, "guarded": false,
 *         "env": { "UI_BASE_URL": "${services.ui.publicUrl}" },
 *         "remoteSecrets": { "OPENAI_API_KEY": "$MED_OPENAI_API_KEY" },
 *         "worktreeInclude": ["apps/backend/.env.private"]
 *       },
 *       "ui": { "command": "npm start", "cwd": "apps/ui", "port": 4200, "env": { "BACKEND_ORIGIN": "${services.backend.publicUrl}" } }
 *     },
 *     "checks": {
 *       "format": { "command": "npm run format:check" },
 *       "test": { "command": "npm test", "cwd": "apps/web" }
 *     }
 *   }
 *
 * - `version` must be 3; `services`, when present, holds 1 to 64 services in the order of the file, each named by
 *   `^[a-z][a-z0-9-]{0,31}$`. A repository without hunt.json or `services` has no services. Unknown fields are errors,
 *   contract 2's `preview` section among them.
 * - `command`: one non-empty line of at most 4096 characters, which bash runs in the service's folder.
 * - `cwd`: that folder relative to the worktree, the worktree itself without it; at most 255 characters, segments of
 *   letters, digits, `.`, `_` and `-`, none `.` or `..`.
 * - `port`: an integer from 1024 to 65535, not reserved (RESERVED_PORTS) and the port of no other service.
 * - `tls`: whether the service speaks HTTPS, false by default; its certificate is not checked, so a self-signed one works.
 * - `guarded`: true by default. Every service answers at `https://<short>-<port>.<domain>` behind IAP's Google login; a
 *   service with false also answers at `https://<short>-<port>-open.<domain>` without IAP, behind the app's own login only.
 * - `env`: variables of this service only. Keys match `^[A-Z_][A-Z0-9_]*$` and do not start with `CLAUDE_` or `HUNT_`;
 *   values are single lines. `${services.<name>.publicUrl}` in a value becomes the URL of that service, its open URL when
 *   it is not guarded; every other `${…}` but contract 2's `${HUNT_…}` stays as it is.
 * - `remoteSecrets`: variables of this service whose values are remote secrets (`libs/domain/src/remoteSecrets.ts`),
 *   which a person stores in Hunt under Settings → Remote VM and the gateway puts on the VM. Keys follow the rules of
 *   `env` and appear in only one of the two; each value is `$<NAME>`, the name of a remote secret, which must exist.
 * - `worktreeInclude`: the ignored files this service needs, which git leaves out of a checkout, such as its
 *   `.env.private`: up to 64 glob patterns relative to the worktree (`*` stays within a folder, `**` crosses folders),
 *   each one line of at most 255 characters that is not absolute and has no `..` segment; none by default. Hunt copies
 *   the matching files of the repository's checkout into every worktree it creates and takes them along to the session
 *   VM; the VM only validates the list.
 * - `swf`: optional, with the only field `model`, the model of Claude Code in a session of the poller: the full ID of a
 *   Claude model such as `claude-opus-5-5` (MODEL_ID), at most 128 characters, never an alias such as `opus`, whose
 *   model changes with Claude Code's releases. The poller sets it as the session's `model` config option; without it, or when the agent knows no such model (the relay logs that), Claude
 *   Code's default model applies. Sessions started from Hunt keep the model their user picks.
 * - `checks`: optional, at most 32 commands such as the linter or the tests, in the order of the file, each named like a
 *   service, with the only fields `command` and `cwd`, which follow the rules of a service's. The client's Checks tab
 *   runs them in the worktree on the Mac, or on the session VM through `hunt-ctl check`, and shows their output and
 *   exit status.
 *
 * `<short>` is the first 8 hex digits of the session ID. `configCli.ts` writes the session's environment, one
 * environment file per service and the configuration of the VM's preview proxy.
 */
import { join } from "node:path";
import { isRecord } from "../../../libs/domain/src/jsonRpc.ts";
import { REMOTE_SECRET_NAME } from "../../../libs/domain/src/remoteSecrets.ts";

export interface ServiceConfig {
  name: string;
  command: string;
  /** Relative to the worktree; null for the worktree itself. */
  cwd: string | null;
  port: number;
  tls: boolean;
  guarded: boolean;
  /** The service's variables as hunt.json declares them, placeholders unresolved. */
  env: Record<string, string>;
  /** The service's variables whose values are remote secrets: variable → name of the remote secret, without the `$`. */
  remoteSecrets: Record<string, string>;
  /** The glob patterns of the ignored files the service needs in a worktree, relative to the worktree. */
  worktreeInclude: string[];
}

export interface CheckConfig {
  name: string;
  command: string;
  /** Relative to the worktree; null for the worktree itself. */
  cwd: string | null;
}

/** The host names of a session's preview: `<short>-<port>.<domain>` and `<short>-<port>-open.<domain>`. */
export interface SessionHost {
  /** The first 8 hex digits of the session ID. */
  short: string;
  domain: string;
}

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
  /** The section of the agent's prompt that lists the services; empty without services. */
  servicesPrompt: string;
  /** `swf.model` of hunt.json; null without one. */
  swfModel: string | null;
}

export interface CaddyRoute {
  match?: Record<string, unknown>[];
  handle: Record<string, unknown>[];
  terminal?: boolean;
}

export interface CaddyLog {
  level?: string;
  writer?: { output: "file"; filename: string; roll_size_mb: number; roll_keep: number };
  /** `level_format: "upper"` keeps the console format free of color codes. */
  encoder?: { format: string; level_format?: string };
  include?: string[];
  exclude?: string[];
}

export interface CaddyConfig {
  admin: { listen: string; config: { persist: boolean } };
  logging: { logs: { default: CaddyLog; access: CaddyLog } };
  apps: {
    http: {
      servers: {
        preview: {
          listen: string[];
          protocols: string[];
          automatic_https: { disable: boolean };
          trusted_proxies: { source: "static"; ranges: string[] };
          logs: { default_logger_name: string };
          routes: CaddyRoute[];
          /** What answers a request that `routes` failed to deliver. */
          errors: { routes: CaddyRoute[] };
        };
      };
    };
  };
}

/** Every problem found in a `hunt.json` or the session's host names, each starting with the path of the offending value. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Ports no service may use, with what holds them on the session VM; hunt-ctl's RESERVED_PORTS lists the same. */
const RESERVED_PORTS: ReadonlyMap<number, string> = new Map([
  [2019, "Caddy's admin API"],
  [2375, "the Docker API"],
  [2376, "the Docker API over TLS"],
  [5355, "LLMNR of systemd-resolved"],
  [8080, "the session VM's preview proxy"],
  [20201, "the Google Ops Agent's OpenTelemetry collector"],
  [20202, "the Google Ops Agent's Fluent Bit"],
]);

/** Where the preview proxy listens; the gateway forwards every preview request there with its original Host header. */
const PROXY_LISTEN = ":8080";
/** The gateway's health check, answered on every host. */
const HEALTH_PATH = "/hunt-healthz";
/** Caddy's admin API, in the runtime folder of hunt-proxy.service. */
const PROXY_ADMIN = "unix//run/hunt-proxy/admin.sock";
/** The access log of every preview request, in the logs folder of hunt-proxy.service; `hunt-idle-check` reads it. */
const ACCESS_LOG = "/var/log/hunt-proxy/access.log";
/** Caddy names the access logger of a server `http.log.access.<default_logger_name>`. */
const ACCESS_LOGGER = "preview";

const ROOT_FIELDS = ["version", "swf", "services", "checks"];
const SWF_FIELDS = ["model"];
const MAX_MODEL_LENGTH = 128;
/** The full ID of a Claude model, with an optional context hint: `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-5-5[1m]`. */
const MODEL_ID = /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\[\d+m\])?$/;
const MODEL_RULE = `must be the full ID of a Claude model such as "claude-opus-5-5", at most ${MAX_MODEL_LENGTH} characters, not an alias such as "opus"`;
/** The rule a `worktreeInclude` entry must follow. */
export const WORKTREE_INCLUDE_RULE = "must be a glob pattern relative to the worktree: one line of at most 255 characters, not absolute, without a .. segment";
const MAX_WORKTREE_INCLUDE = 64;
const SERVICE_FIELDS = ["command", "cwd", "port", "tls", "guarded", "env", "remoteSecrets", "worktreeInclude"];
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_SERVICES = 64;
const CHECK_FIELDS = ["command", "cwd"];
const MAX_CHECKS = 32;
const MAX_COMMAND_LENGTH = 4096;
const MAX_CWD_LENGTH = 255;
const CWD = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const CWD_RULE =
  `must be a folder relative to the worktree such as "apps/web": at most ${MAX_CWD_LENGTH} characters, ` +
  'segments of letters, digits, ".", "_" and "-", none . or ..';
const LINE_BREAK = /[\n\r\0]/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ["CLAUDE_", "HUNT_"];
/** A `remoteSecrets` value, with the name of the remote secret as capture group 1. */
const REMOTE_SECRET_REFERENCE = new RegExp(`^\\$(${REMOTE_SECRET_NAME.source.slice(1, -1)})$`);
const CONTRACT_2_PROBLEM = 'the preview section of contract 2 is no longer read; hunt.json holds {"version": 3, "services": {…}} at its root';
const CONTRACT_2_PLACEHOLDER = /\$\{HUNT_[A-Za-z0-9_]*\}/g;
/** Any `${services.…}`; capture group 1 must be `<name>.publicUrl`. */
const SERVICE_PLACEHOLDER = /\$\{services\.([^}]*)\}/g;
const SERVICE_REFERENCE = /^([^.]+)\.publicUrl$/;
/** A valid `${services.<name>.publicUrl}`, with the name as capture group 1. */
const PUBLIC_URL_PLACEHOLDER = /\$\{services\.([^.}]+)\.publicUrl\}/g;
const SHORT = /^[0-9a-f]{8}$/;
/** At least two labels, the last of letters only; hunt-ctl's DOMAIN_PATTERN and apps/client/src-tauri/src/remote/preview.rs check the same. */
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Leaves room for the `<short>-<port>-open.` in front of the domain within the 253 characters of a host name. */
const MAX_DOMAIN_LENGTH = 253 - "01234567-65535-open.".length;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** The private ranges of a VPC's internal addresses: the gateway connects from one, so its X-Forwarded-* headers pass on. */
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const IAP_HEADERS = ["X-Goog-Iap-Jwt-Assertion", "X-Goog-Authenticated-User-Email", "X-Goog-Authenticated-User-Id"];
const IAP_COOKIE = "(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*";
/** A port from 1024 to 65535, without leading zeros, as capture group 1. */
const PORT_PATTERN = "(102[4-9]|10[3-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const NO_SERVICES_PROMPT = [
  "### The repository's services",
  "",
  "The repository has no hunt.json or declares no services in it: run the app as a developer would locally, in the tmux " +
    "session `app` as described above.",
].join("\n");
const NOT_OPEN_BODY = 'This port has no public host: only a service with "guarded": false in the repository\'s hunt.json has one.\n';
/** Caddy's error status when the upstream of a reverse_proxy refuses the connection, because nothing listens on its port. */
const UNREACHABLE = "{http.error.status_code} == 502";
/** What an open host answers when its service does not run; the gateway's edge answers the same while the VM is off. */
const NOT_RUNNING_BODY = "The preview is not running.\n";

function portHost(host: SessionHost, port: number): string {
  return `${host.short}-${port}.${host.domain}`;
}

function openHost(host: SessionHost, port: number): string {
  return `${host.short}-${port}-open.${host.domain}`;
}

/** The URL that `${services.<name>.publicUrl}` stands for: the open host of a service that is not guarded, else its port host. */
export function publicUrl(service: Pick<ServiceConfig, "port" | "guarded">, host: SessionHost): string {
  return `https://${service.guarded ? portHost(host, service.port) : openHost(host, service.port)}`;
}

/**
 * Checks `huntJson` (the parsed file, undefined without one) and the session's host names and builds everything the
 * session VM needs; `worktree` is the session's worktree on the VM and `secrets` the remote secrets the gateway put
 * there, of which every one a service names must exist. Throws a ConfigError.
 */
export function buildSessionConfig(huntJson: unknown, host: SessionHost, worktree: string, secrets: Readonly<Record<string, string>> = {}): SessionConfig {
  const problems = new Problems();
  if (!SHORT.test(host.short)) {
    problems.add("short", "must be the first 8 hex digits of the session ID, in lowercase");
  }
  if (!isDomain(host.domain)) {
    problems.add("domain", "must be a lowercase host name with at least two labels, the last of letters only");
  }
  const { services, swfModel } = parseRoot(huntJson, problems);
  for (const service of services) {
    for (const [key, name] of Object.entries(service.remoteSecrets)) {
      if (Object.hasOwn(secrets, name)) continue;
      problems.add(at(at(at("services", service.name), "remoteSecrets"), key), `no remote secret ${name}; set it in Hunt under Settings → Remote VM`);
    }
  }
  if (problems.messages.length > 0) throw new ConfigError(problems.messages);
  return {
    services,
    env: sessionEnv(host),
    serviceEnvs: serviceEnvs(services, host, worktree, secrets),
    proxy: proxyConfig(services, host),
    servicesPrompt: servicesPrompt(services, host),
    swfModel,
  };
}

/** The services of `huntJson` (the parsed file, undefined without one) in the order of the file; throws a ConfigError. */
export function parseServices(huntJson: unknown): ServiceConfig[] {
  const problems = new Problems();
  const { services } = parseRoot(huntJson, problems);
  if (problems.messages.length > 0) throw new ConfigError(problems.messages);
  return services;
}

/** The checks of `huntJson` (the parsed file, undefined without one) in the order of the file; throws a ConfigError. */
export function parseChecks(huntJson: unknown): CheckConfig[] {
  const problems = new Problems();
  const { checks } = parseRoot(huntJson, problems);
  if (problems.messages.length > 0) throw new ConfigError(problems.messages);
  return checks;
}

/** The check `name` of `huntJson`; throws a ConfigError when hunt.json is invalid or declares no such check. */
export function findCheck(huntJson: unknown, name: string): CheckConfig {
  const check = parseChecks(huntJson).find((candidate) => candidate.name === name);
  if (!check) throw new ConfigError([`${at("checks", name)}: no such check`]);
  return check;
}

/** The session's environment: `HUNT_PREVIEW_URL_TEMPLATE`, the URL of a port with `{port}` in its place. */
export function sessionEnv(host: SessionHost): Record<string, string> {
  return { HUNT_PREVIEW_URL_TEMPLATE: `https://${host.short}-{port}.${host.domain}` };
}

/**
 * The environment of each service by name: its variables with `${services.<name>.publicUrl}` resolved, its remote
 * secrets from `secrets` (a missing one is left out), then `HUNT_SERVICE_DIR`, the folder the service runs in, and
 * `HUNT_SERVICE_COMMAND`, its command line.
 */
export function serviceEnvs(
  services: readonly ServiceConfig[],
  host: SessionHost,
  worktree: string,
  secrets: Readonly<Record<string, string>> = {},
): Record<string, Record<string, string>> {
  const urls = new Map(services.map((service) => [service.name, publicUrl(service, host)]));
  const resolve = (value: string) => value.replace(PUBLIC_URL_PLACEHOLDER, (placeholder, name: string) => urls.get(name) ?? placeholder);
  const envs: Record<string, Record<string, string>> = {};
  for (const service of services) {
    envs[service.name] = {
      ...Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key, resolve(value)])),
      ...Object.fromEntries(Object.entries(service.remoteSecrets).flatMap(([key, name]) => (Object.hasOwn(secrets, name) ? [[key, secrets[name]]] : []))),
      HUNT_SERVICE_DIR: service.cwd ? join(worktree, service.cwd) : worktree,
      HUNT_SERVICE_COMMAND: service.command,
    };
  }
  return envs;
}

/**
 * `env` as a systemd EnvironmentFile: `header` as a comment line, then one double-quoted assignment per line with `\`,
 * `"`, `` ` `` and `$` escaped, which systemd and a POSIX shell read back verbatim. Values must be single lines.
 */
export function envFile(env: Record<string, string>, header: string): string {
  const lines = Object.entries(env).map(([key, value]) => `${key}="${value.replace(/[\\"`$]/g, "\\$&")}"`);
  return `# ${header}\n${lines.join("\n")}\n`;
}

/**
 * The section of the agent's prompt that tells it how to run the services and lists each one with its port, URL and
 * who may open it; without services, it says so.
 */
export function servicesPrompt(services: readonly ServiceConfig[], host: SessionHost): string {
  if (services.length === 0) return NO_SERVICES_PROMPT;
  const rows = services.map((service) => {
    const access = service.guarded ? "Google login" : "public, app login only";
    return `| ${service.name} | ${service.port} | ${publicUrl(service, host)} | ${access} |`;
  });
  return [
    "### The repository's services",
    "",
    "Hunt runs the services of the repository's hunt.json on this VM, each as a systemd unit. Start only the services " +
      "your task needs; the repository's hunt.agent.md, when it has one, says which belong together:",
    "",
    "```",
    "sudo -n hunt-ctl service start <name>…",
    "```",
    "",
    "`restart`, `stop` and `status` take names the same way; `status` without names reports every service. A service " +
      "writes its output to `~/logs/<name>.log`. The variables hunt.json declares for a service apply to that service " +
      "only, not to your shell.",
    "",
    "| Service | Port | URL | Access |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * The Caddy configuration of the session VM's preview proxy. It listens on PROXY_LISTEN in plain HTTP behind the
 * gateway and sends `<short>-<port>.<domain>` to that port and `<short>-<port>-open.<domain>` of a service that is not
 * guarded to the service's port, both on localhost, which reaches servers bound to 127.0.0.1 as well as ::1. The ports of
 * services with `tls` are reached over HTTPS without checking the certificate. Every upstream gets the request's own
 * Host header, which Caddy would replace with the upstream's address for HTTPS, but never IAP's headers and cookies;
 * responses are flushed at once (server-sent events). HEALTH_PATH answers 200 on every host, the reserved ports answer
 * 403, and `<short>.<domain>` and every other `-open` host answer 404 with an explanation. When nothing listens on the
 * port, a port host answers 503 with an explanation that names the service of that port, an open host 503 with
 * NOT_RUNNING_BODY, which tells a stranger nothing about the services. Every request except the health check goes to
 * ACCESS_LOG as one JSON line; Caddy writes Cookie and Authorization headers there redacted. Caddy's own warnings and
 * errors, such as an upstream that refuses the connection, go to stderr, hunt-proxy's journal, as one readable line each.
 */
export function proxyConfig(services: readonly ServiceConfig[], host: SessionHost): CaddyConfig {
  const hostMatch = (name: string, pattern: string) => ({
    vars_regexp: { "{http.request.host}": { name, pattern: `^${host.short}-${pattern}\\.${host.domain.replaceAll(".", "\\.")}$` } },
  });
  const route = (match: Record<string, unknown>, handler: Record<string, unknown>): CaddyRoute => ({ match: [match], handle: [handler], terminal: true });
  const notFound = (body: string) => ({ handler: "static_response", status_code: 404, body });
  const notRunning = (match: Record<string, unknown>, body: string) =>
    route({ ...match, expression: UNREACHABLE }, { handler: "static_response", status_code: 503, body });
  const mainHostBody = `This session has no main page: each service of the repository's hunt.json answers at https://${host.short}-<port>.${host.domain}.\n`;
  return {
    admin: { listen: PROXY_ADMIN, config: { persist: false } },
    logging: {
      logs: {
        default: { level: "WARN", encoder: { format: "console", level_format: "upper" }, exclude: [`http.log.access.${ACCESS_LOGGER}`] },
        access: {
          writer: { output: "file", filename: ACCESS_LOG, roll_size_mb: 20, roll_keep: 2 },
          encoder: { format: "json" },
          include: [`http.log.access.${ACCESS_LOGGER}`],
        },
      },
    },
    apps: {
      http: {
        servers: {
          preview: {
            listen: [PROXY_LISTEN],
            protocols: ["h1"],
            automatic_https: { disable: true },
            trusted_proxies: { source: "static", ranges: PRIVATE_RANGES },
            logs: { default_logger_name: ACCESS_LOGGER },
            routes: [
              {
                match: [{ path: [HEALTH_PATH] }],
                handle: [{ handler: "vars", log_skip: true }, { handler: "static_response", status_code: 200, body: "ok" }],
                terminal: true,
              },
              route(
                { host: [...RESERVED_PORTS.keys()].map((port) => portHost(host, port)) },
                { handler: "static_response", status_code: 403, body: "This port is not served.\n" },
              ),
              route({ host: [`${host.short}.${host.domain}`] }, notFound(mainHostBody)),
              ...services
                .filter((service) => !service.guarded)
                .map((service) => route({ host: [openHost(host, service.port)] }, proxy(`localhost:${service.port}`, service.tls))),
              route(hostMatch("open", "[0-9]+-open"), notFound(NOT_OPEN_BODY)),
              ...services
                .filter((service) => service.tls)
                .map((service) => route({ host: [portHost(host, service.port)] }, proxy(`localhost:${service.port}`, true))),
              route(hostMatch("port", PORT_PATTERN), proxy("localhost:{http.regexp.port.1}", false)),
              { handle: [{ handler: "static_response", status_code: 404 }] },
            ],
            errors: {
              routes: [
                notRunning(hostMatch("open", "[0-9]+-open"), NOT_RUNNING_BODY),
                ...services.map((service) =>
                  notRunning(
                    { host: [portHost(host, service.port)] },
                    `The service ${service.name} is not running, so nothing answers on port ${service.port}. Ask the agent to start it, then reload this page.\n`,
                  ),
                ),
                notRunning(hostMatch("port", PORT_PATTERN), "Nothing answers on port {http.regexp.port.1} of the session VM.\n"),
              ],
            },
          },
        },
      },
    },
  };
}

function proxy(dial: string, tls: boolean): Record<string, unknown> {
  return {
    handler: "reverse_proxy",
    upstreams: [{ dial }],
    flush_interval: -1,
    headers: {
      request: {
        set: { Host: ["{http.request.hostport}"] },
        delete: IAP_HEADERS,
        replace: { Cookie: [{ search_regexp: IAP_COOKIE, replace: "" }] },
      },
    },
    ...(tls ? { transport: { protocol: "http", tls: { insecure_skip_verify: true } } } : {}),
  };
}

/** Collects the problems of a document; `add` returns undefined, so a check can `return problems.add(…)`. */
class Problems {
  readonly messages: string[] = [];

  add(path: string, message: string): undefined {
    this.messages.push(`${path}: ${message}`);
    return undefined;
  }
}

/** The path of `key` in the object at `path`; an empty `path` is the root of hunt.json. */
function at(path: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path ? `${path}.${key}` : key;
}

/** `value` as an object; keys outside `fields` are reported as unknown unless `fields` is null. */
function record(value: unknown, path: string, fields: readonly string[] | null, problems: Problems): Record<string, unknown> | undefined {
  if (!isRecord(value)) return problems.add(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (fields && !fields.includes(key)) {
      problems.add(at(path, key), "unknown field");
    }
  }
  return value;
}

/** The services and checks of `huntJson` in the order of the file and its `swf.model`; nothing of these without the file. */
function parseRoot(huntJson: unknown, problems: Problems): { services: ServiceConfig[]; checks: CheckConfig[]; swfModel: string | null } {
  const empty = { services: [], checks: [], swfModel: null };
  if (huntJson === undefined) return empty;
  const root = record(huntJson, "hunt.json", null, problems);
  if (!root) return empty;
  for (const key of Object.keys(root)) {
    if (ROOT_FIELDS.includes(key)) continue;
    problems.add(at("", key), key === "preview" ? CONTRACT_2_PROBLEM : "unknown field");
  }
  if (root.version !== 3) {
    problems.add("version", "must be 3");
  }
  const swfModel = parseSwfModel(root.swf, problems);
  const declared = root.services === undefined ? undefined : record(root.services, "services", null, problems);
  const entries = Object.entries(declared ?? {});
  if (declared && (entries.length === 0 || entries.length > MAX_SERVICES)) {
    problems.add("services", `must hold 1 to ${MAX_SERVICES} services`);
  }
  const names = new Set(entries.map(([name]) => name).filter((name) => SERVICE_NAME.test(name)));
  const portOwners = new Map<number, string>();
  const services: ServiceConfig[] = [];
  for (const [name, value] of entries) {
    const service = parseService(name, value, names, problems);
    if (!service) continue;
    const owner = portOwners.get(service.port);
    if (owner) {
      problems.add(at(at("services", name), "port"), `${service.port} is the port of the service ${owner} already`);
    } else {
      portOwners.set(service.port, name);
    }
    services.push(service);
  }
  return { services, checks: checkList(root.checks, problems), swfModel };
}

/** The checks of the optional `checks` section in the order of the file; see the module comment. Every problem is reported. */
function checkList(value: unknown, problems: Problems): CheckConfig[] {
  if (value === undefined) return [];
  const entries = Object.entries(record(value, "checks", null, problems) ?? {});
  if (entries.length > MAX_CHECKS) {
    problems.add("checks", `must hold at most ${MAX_CHECKS} checks`);
  }
  const checks: CheckConfig[] = [];
  for (const [name, entry] of entries) {
    const path = at("checks", name);
    if (!SERVICE_NAME.test(name)) {
      problems.add(path, `invalid name, must match ${SERVICE_NAME.source}`);
      continue;
    }
    const fields = record(entry, path, CHECK_FIELDS, problems);
    if (!fields) continue;
    checks.push({ name, command: commandLine(fields.command, at(path, "command"), problems), cwd: folder(fields.cwd, at(path, "cwd"), problems) });
  }
  return checks;
}

/** The `model` of the optional `swf` section; null without one. */
function parseSwfModel(value: unknown, problems: Problems): string | null {
  if (value === undefined) return null;
  const fields = record(value, "swf", SWF_FIELDS, problems);
  if (!fields || fields.model === undefined) return null;
  const model = fields.model;
  if (typeof model === "string" && model.length <= MAX_MODEL_LENGTH && MODEL_ID.test(model)) return model;
  problems.add(at("swf", "model"), MODEL_RULE);
  return null;
}

/** The optional `worktreeInclude` list of a service at `path`; see the module comment. Every problem is reported. */
function worktreeInclude(value: unknown, path: string, problems: Problems): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WORKTREE_INCLUDE) {
    problems.add(path, `must be a list of at most ${MAX_WORKTREE_INCLUDE} glob patterns`);
    return [];
  }
  const patterns: string[] = [];
  value.forEach((pattern, index) => {
    const isUsable =
      typeof pattern === "string" &&
      pattern.trim() !== "" &&
      !/[\r\n]/.test(pattern) &&
      pattern.length <= 255 &&
      !pattern.startsWith("/") &&
      !pattern.split("/").includes("..");
    if (!isUsable) {
      problems.add(`${path}[${index}]`, WORKTREE_INCLUDE_RULE);
      return;
    }
    patterns.push(pattern as string);
  });
  return patterns;
}

/** The service `name`; undefined when its name, object or port is unusable. Every problem is reported. */
function parseService(name: string, value: unknown, names: ReadonlySet<string>, problems: Problems): ServiceConfig | undefined {
  const path = at("services", name);
  if (!SERVICE_NAME.test(name)) return problems.add(path, `invalid name, must match ${SERVICE_NAME.source}`);
  const fields = record(value, path, SERVICE_FIELDS, problems);
  if (!fields) return undefined;
  const command = commandLine(fields.command, at(path, "command"), problems);
  const cwd = folder(fields.cwd, at(path, "cwd"), problems);
  const port = checkPort(fields.port, at(path, "port"), problems);
  const tls = flag(fields.tls, false, at(path, "tls"), problems);
  const guarded = flag(fields.guarded, true, at(path, "guarded"), problems);
  const env = environment(fields.env, at(path, "env"), names, problems);
  const secrets = remoteSecrets(fields.remoteSecrets, at(path, "remoteSecrets"), env, problems);
  const include = worktreeInclude(fields.worktreeInclude, at(path, "worktreeInclude"), problems);
  if (port === undefined) return undefined;
  return { name, command, cwd, port, tls, guarded, env, remoteSecrets: secrets, worktreeInclude: include };
}

function commandLine(value: unknown, path: string, problems: Problems): string {
  if (typeof value !== "string" || !value.trim()) {
    problems.add(path, "must be a non-empty string");
    return "";
  }
  if (LINE_BREAK.test(value)) {
    problems.add(path, "must be a single line");
  }
  if (value.length > MAX_COMMAND_LENGTH) {
    problems.add(path, `must be at most ${MAX_COMMAND_LENGTH} characters long`);
  }
  return value;
}

/** `value` as a folder relative to the worktree; null without one. */
function folder(value: unknown, path: string, problems: Problems): string | null {
  if (value === undefined) return null;
  const isFolder =
    typeof value === "string" &&
    value.length <= MAX_CWD_LENGTH &&
    CWD.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..");
  if (isFolder) return value;
  problems.add(path, CWD_RULE);
  return null;
}

/** `value` as a boolean; `fallback` without one. */
function flag(value: unknown, fallback: boolean, path: string, problems: Problems): boolean {
  if (typeof value === "boolean") return value;
  if (value !== undefined) {
    problems.add(path, "must be true or false");
  }
  return fallback;
}

/** The variables at `path`, whose placeholders may name the services in `names`. */
function environment(value: unknown, path: string, names: ReadonlySet<string>, problems: Problems): Record<string, string> {
  const env: Record<string, string> = {};
  if (value === undefined) return env;
  for (const [key, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const entryPath = at(path, key);
    if (!isEnvKey(key, entryPath, problems)) continue;
    if (typeof entry !== "string") {
      problems.add(entryPath, "must be a string");
      continue;
    }
    if (LINE_BREAK.test(entry)) {
      problems.add(entryPath, "must be a single line");
      continue;
    }
    checkPlaceholders(entry, entryPath, names, problems);
    env[key] = entry;
  }
  return env;
}

/** The remote secrets at `path` by variable, without the `$`; a variable may not appear in `env` as well. */
function remoteSecrets(value: unknown, path: string, env: Readonly<Record<string, string>>, problems: Problems): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (value === undefined) return secrets;
  for (const [key, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const entryPath = at(path, key);
    if (!isEnvKey(key, entryPath, problems)) continue;
    if (Object.hasOwn(env, key)) {
      problems.add(entryPath, "is set in env already");
      continue;
    }
    const name = typeof entry === "string" ? REMOTE_SECRET_REFERENCE.exec(entry)?.[1] : undefined;
    if (!name) {
      problems.add(entryPath, `must be "$<NAME>", the name of a remote secret matching ${REMOTE_SECRET_NAME.source}`);
      continue;
    }
    secrets[key] = name;
  }
  return secrets;
}

/** Whether `key` may name a variable of a service; reports why not. */
function isEnvKey(key: string, path: string, problems: Problems): boolean {
  if (!ENV_KEY.test(key)) {
    problems.add(path, "invalid name, must match ^[A-Z_][A-Z0-9_]*$");
    return false;
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    problems.add(path, "reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt");
    return false;
  }
  return true;
}

/** Reports every `${HUNT_…}` of contract 2 in `value` and every `${services.…}` that is no `publicUrl` of a service in `names`. */
function checkPlaceholders(value: string, path: string, names: ReadonlySet<string>, problems: Problems): void {
  for (const [placeholder] of value.matchAll(CONTRACT_2_PLACEHOLDER)) {
    problems.add(path, `${placeholder} is a placeholder of contract 2, use \${services.<name>.publicUrl}`);
  }
  for (const [placeholder, reference] of value.matchAll(SERVICE_PLACEHOLDER)) {
    const name = SERVICE_REFERENCE.exec(reference)?.[1];
    if (name === undefined) {
      problems.add(path, `unknown placeholder ${placeholder}, the form is \${services.<name>.publicUrl}`);
      continue;
    }
    if (!names.has(name)) {
      problems.add(path, `${placeholder}: hunt.json declares no service ${name}`);
    }
  }
}

function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** `value` as a port. */
function checkPort(value: unknown, path: string, problems: Problems): number | undefined {
  if (!isPortNumber(value)) return problems.add(path, "must be an integer from 1024 to 65535");
  const holder = RESERVED_PORTS.get(value);
  if (holder) return problems.add(path, `${value} is reserved for ${holder}`);
  return value;
}

function isDomain(value: string): boolean {
  return value.length <= MAX_DOMAIN_LENGTH && DOMAIN.test(value);
}
