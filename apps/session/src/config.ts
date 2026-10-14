/**
 * The `preview` section of a repository's `hunt.json` in contract version 2. Every session runs on a VM of its own,
 * where its agent starts the app as a developer would locally; the section holds only what differs on the VM:
 *
 *   "preview": {
 *     "version": 2,
 *     "env": { "BACKEND_DOMAIN": "${HUNT_PREVIEW_URL_3000}" },
 *     "main": 4200,
 *     "routes": { "/api/": 3000, "/admin-api/": 3000 },
 *     "tls": [3000]
 *   }
 *
 * - `version` must be 2. Every other field is optional; a repository without hunt.json or without its `preview`
 *   section gets no variables, no main port and no routes.
 * - `env`: variables every command of the agent inherits. Keys match `^[A-Z_][A-Z0-9_]*$` and do not start with
 *   `CLAUDE_` or `HUNT_`; values are single lines. `${HUNT_PREVIEW_URL}` in a value becomes the main URL
 *   `https://<short>.<domain>`, `${HUNT_PREVIEW_URL_<port>}` the URL of a port, `https://<short>-<port>.<domain>`.
 * - `main`: the port `https://<short>.<domain>` serves.
 * - `routes`: path prefix → port, on every preview host of the session ahead of the host's own port; the longest
 *   matching prefix wins. A prefix starts and ends with `/`; its segments hold letters, digits, `.`, `_`, `~` and `-`.
 * - `tls`: ports whose dev servers speak HTTPS; their certificates are not checked, so self-signed ones work.
 * - Ports are integers from 1024 to 65535 and not reserved (RESERVED_PORTS). Unknown fields are errors.
 *
 * `<short>` is the first 8 hex digits of the session ID. `configCli.ts` writes the session's environment and the
 * configuration of the VM's preview proxy, which serves every port of the VM at `https://<short>-<port>.<domain>`.
 */
import { isRecord } from "../../../libs/domain/src/jsonRpc.ts";

export interface PreviewRoute {
  /** Starts and ends with `/`. */
  prefix: string;
  port: number;
}

export interface PreviewConfig {
  env: Record<string, string>;
  main: number | null;
  /** In the order of hunt.json. */
  routes: PreviewRoute[];
  tls: number[];
}

/** The host names of a session's preview: `<short>.<domain>` and `<short>-<port>.<domain>`. */
export interface SessionHost {
  /** The first 8 hex digits of the session ID. */
  short: string;
  domain: string;
}

export interface SessionConfig {
  /** The checked `preview` section. */
  preview: PreviewConfig;
  /** The repository's variables with their placeholders resolved, after HUNT_PREVIEW_URL and HUNT_PREVIEW_URL_TEMPLATE. */
  env: Record<string, string>;
  proxy: CaddyConfig;
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

/** Ports no preview may use, with what holds them on the session VM. */
const RESERVED_PORTS: ReadonlyMap<number, string> = new Map([
  [2019, "Caddy's admin API"],
  [2375, "the Docker API"],
  [2376, "the Docker API over TLS"],
  [8080, "the session VM's preview proxy"],
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

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ["CLAUDE_", "HUNT_"];
const PLACEHOLDER = /\$\{(HUNT_[A-Za-z0-9_]*)\}/g;
const URL_PLACEHOLDER = /^HUNT_PREVIEW_URL(?:_([0-9]+))?$/;
const ROUTE_PREFIX = /^\/(?:[A-Za-z0-9._~-]+\/)+$/;
const ROUTE_PREFIX_RULE = 'must be a path prefix such as "/api/": starting and ending with /, segments of letters, digits, ".", "_", "~" and "-", none . or ..';
const SHORT = /^[0-9a-f]{8}$/;
/**
 * At least two labels, the last of letters only; hunt-ctl's DOMAIN_PATTERN, apps/client/src-tauri/src/remote/preview.rs
 * and apps/client/src/state/settings.ts check the same.
 */
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Leaves room for the `<short>-<port>.` in front of the domain within the 253 characters of a host name. */
const MAX_DOMAIN_LENGTH = 253 - "01234567-65535.".length;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const PREVIEW_FIELDS = ["version", "env", "main", "routes", "tls"];

/** The private ranges of a VPC's internal addresses: the gateway connects from one, so its X-Forwarded-* headers pass on. */
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const IAP_HEADERS = ["X-Goog-Iap-Jwt-Assertion", "X-Goog-Authenticated-User-Email", "X-Goog-Authenticated-User-Id"];
const IAP_COOKIE = "(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*";
/** A port from 1024 to 65535, without leading zeros, as capture group 1. */
const PORT_PATTERN = "(102[4-9]|10[3-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const NO_MAIN_BODY = "This session has no main port: the preview section of the repository's hunt.json sets none.\n";

function mainUrl(host: SessionHost): string {
  return `https://${host.short}.${host.domain}`;
}

function portUrl(host: SessionHost, port: number): string {
  return `https://${host.short}-${port}.${host.domain}`;
}

/** Checks `huntJson` (the parsed file, undefined without one) and the session's host names; throws a ConfigError. */
export function buildSessionConfig(huntJson: unknown, host: SessionHost): SessionConfig {
  const problems = new Problems();
  if (!SHORT.test(host.short)) {
    problems.add("short", "must be the first 8 hex digits of the session ID, in lowercase");
  }
  if (!isDomain(host.domain)) {
    problems.add("domain", "must be a lowercase host name with at least two labels, the last of letters only");
  }
  const config = parseSection(huntJson, problems);
  if (problems.messages.length > 0) throw new ConfigError(problems.messages);
  return { preview: config, env: sessionEnv(config, host), proxy: proxyConfig(config, host) };
}

/** Checks the `preview` section of `huntJson` (the parsed file, undefined without one); throws a ConfigError. */
export function parsePreviewConfig(huntJson: unknown): PreviewConfig {
  const problems = new Problems();
  const config = parseSection(huntJson, problems);
  if (problems.messages.length > 0) throw new ConfigError(problems.messages);
  return config;
}

/**
 * The session's environment: `HUNT_PREVIEW_URL`, `HUNT_PREVIEW_URL_TEMPLATE` (the URL of a port with `{port}` in its
 * place) and the repository's variables with their placeholders resolved.
 */
export function sessionEnv(config: PreviewConfig, host: SessionHost): Record<string, string> {
  const env: Record<string, string> = {
    HUNT_PREVIEW_URL: mainUrl(host),
    HUNT_PREVIEW_URL_TEMPLATE: `https://${host.short}-{port}.${host.domain}`,
  };
  for (const [key, value] of Object.entries(config.env)) {
    env[key] = value.replace(PLACEHOLDER, (_placeholder, name: string) => {
      const port = URL_PLACEHOLDER.exec(name)?.[1];
      return port ? portUrl(host, Number(port)) : mainUrl(host);
    });
  }
  return env;
}

/**
 * `env` as a systemd EnvironmentFile: one double-quoted assignment per line with `\`, `"`, `` ` `` and `$` escaped, which
 * systemd and a POSIX shell read back verbatim. Values must be single lines.
 */
export function envFile(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([key, value]) => `${key}="${value.replace(/[\\"`$]/g, "\\$&")}"`);
  return `# The session's environment from the preview section of the repository's hunt.json.\n${lines.join("\n")}\n`;
}

/**
 * The Caddy configuration of the session VM's preview proxy. It listens on PROXY_LISTEN in plain HTTP behind the
 * gateway and sends `<short>.<domain>` to the main port and `<short>-<port>.<domain>` to that port, both on localhost,
 * which reaches servers bound to 127.0.0.1 as well as ::1, except for the path prefixes of `routes`, which go to their
 * own port on every host. Ports in `tls` are reached over HTTPS without checking the certificate. Every upstream gets
 * the request's own Host header, which Caddy would replace with the upstream's address for HTTPS, but never IAP's
 * headers and cookies; responses are flushed at once (server-sent events). HEALTH_PATH answers 200 on every host and
 * the reserved ports answer 403. Every request except the health check goes to ACCESS_LOG as one JSON line; Caddy
 * writes Cookie and Authorization headers there redacted. Caddy's own warnings and errors, such as an upstream that
 * refuses the connection, go to stderr, hunt-proxy's journal, as one readable line each.
 */
export function proxyConfig(config: PreviewConfig, host: SessionHost): CaddyConfig {
  const mainHost = `${host.short}.${host.domain}`;
  const portHost = (port: number) => `${host.short}-${port}.${host.domain}`;
  const portHostMatch = {
    vars_regexp: { "{http.request.host}": { name: "port", pattern: `^${host.short}-${PORT_PATTERN}\\.${host.domain.replaceAll(".", "\\.")}$` } },
  };
  const tls = new Set(config.tls);
  const upstream = (port: number) => proxy(`localhost:${port}`, tls.has(port));
  const prefixes = [...config.routes].sort((first, second) => second.prefix.length - first.prefix.length);
  const sessionRoutes: CaddyRoute[] = [
    ...prefixes.map(({ prefix, port }) => ({ match: [{ path: [`${prefix}*`] }], handle: [upstream(port)], terminal: true })),
    {
      match: [{ host: [mainHost] }],
      handle: [config.main ? upstream(config.main) : { handler: "static_response", status_code: 404, body: NO_MAIN_BODY }],
      terminal: true,
    },
    ...config.tls.map((port) => ({ match: [{ host: [portHost(port)] }], handle: [upstream(port)], terminal: true })),
    { match: [portHostMatch], handle: [proxy("localhost:{http.regexp.port.1}", false)], terminal: true },
  ];
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
              {
                match: [{ host: [...RESERVED_PORTS.keys()].map(portHost) }],
                handle: [{ handler: "static_response", status_code: 403, body: "This port is not served.\n" }],
                terminal: true,
              },
              { match: [{ host: [mainHost] }, portHostMatch], handle: [{ handler: "subroute", routes: sessionRoutes }], terminal: true },
              { handle: [{ handler: "static_response", status_code: 404 }] },
            ],
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

function at(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
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

function parseSection(huntJson: unknown, problems: Problems): PreviewConfig {
  const config: PreviewConfig = { env: {}, main: null, routes: [], tls: [] };
  if (huntJson === undefined) return config;
  const root = record(huntJson, "hunt.json", null, problems);
  if (root?.preview === undefined) return config;
  const preview = record(root.preview, "preview", PREVIEW_FIELDS, problems);
  if (!preview) return config;
  if (preview.version !== 2) {
    problems.add("preview.version", "must be 2");
  }
  config.env = environment(preview.env, problems);
  config.main = preview.main === undefined ? null : (checkPort(preview.main, "preview.main", problems) ?? null);
  config.routes = parseRoutes(preview.routes, problems);
  config.tls = parseTls(preview.tls, problems);
  return config;
}

function environment(value: unknown, problems: Problems): Record<string, string> {
  const path = "preview.env";
  const env: Record<string, string> = {};
  if (value === undefined) return env;
  for (const [key, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const entryPath = at(path, key);
    if (!ENV_KEY.test(key)) {
      problems.add(entryPath, "invalid name, must match ^[A-Z_][A-Z0-9_]*$");
      continue;
    }
    if (RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      problems.add(entryPath, "reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt");
      continue;
    }
    if (typeof entry !== "string") {
      problems.add(entryPath, "must be a string");
      continue;
    }
    if (/[\n\r\0]/.test(entry)) {
      problems.add(entryPath, "must be a single line");
      continue;
    }
    if (checkPlaceholders(entry, entryPath, problems)) {
      env[key] = entry;
    }
  }
  return env;
}

/** Whether every `${HUNT_…}` in `value` is a preview URL placeholder with a usable port. */
function checkPlaceholders(value: string, path: string, problems: Problems): boolean {
  let isValid = true;
  for (const match of value.matchAll(PLACEHOLDER)) {
    const placeholder = URL_PLACEHOLDER.exec(match[1]);
    if (!placeholder) {
      problems.add(path, `unknown placeholder ${match[0]}, only \${HUNT_PREVIEW_URL} and \${HUNT_PREVIEW_URL_<port>} are possible`);
      isValid = false;
      continue;
    }
    const portText = placeholder[1];
    if (portText === undefined) continue;
    const portNumber = /^[1-9][0-9]*$/.test(portText) ? Number(portText) : NaN;
    if (checkPort(portNumber, path, problems, `${match[0]}: the port `) === undefined) {
      isValid = false;
    }
  }
  return isValid;
}

function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** `value` as a port; `label` goes in front of the problem. */
function checkPort(value: unknown, path: string, problems: Problems, label = ""): number | undefined {
  if (!isPortNumber(value)) return problems.add(path, `${label}must be an integer from 1024 to 65535`);
  const holder = RESERVED_PORTS.get(value);
  if (holder) return problems.add(path, `${label}${value} is reserved for ${holder}`);
  return value;
}

function parseRoutes(value: unknown, problems: Problems): PreviewRoute[] {
  const path = "preview.routes";
  const routes: PreviewRoute[] = [];
  if (value === undefined) return routes;
  for (const [prefix, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const routePath = at(path, prefix);
    const isPrefix = ROUTE_PREFIX.test(prefix) && !prefix.split("/").some((segment) => segment === "." || segment === "..");
    if (!isPrefix) {
      problems.add(routePath, ROUTE_PREFIX_RULE);
      continue;
    }
    const routePort = checkPort(entry, routePath, problems);
    if (routePort !== undefined) {
      routes.push({ prefix, port: routePort });
    }
  }
  return routes;
}

function parseTls(value: unknown, problems: Problems): number[] {
  const path = "preview.tls";
  const ports: number[] = [];
  if (value === undefined) return ports;
  if (!Array.isArray(value)) {
    problems.add(path, "must be an array of ports");
    return ports;
  }
  for (const [index, entry] of value.entries()) {
    const tlsPort = checkPort(entry, at(path, index), problems);
    if (tlsPort === undefined) continue;
    if (ports.includes(tlsPort)) {
      problems.add(at(path, index), `${tlsPort} is listed already`);
      continue;
    }
    ports.push(tlsPort);
  }
  return ports;
}

function isDomain(value: string): boolean {
  return value.length <= MAX_DOMAIN_LENGTH && DOMAIN.test(value);
}
