/**
 * The `preview` section of a repository's `hunt.json` (contract version 1) and the plan built from it. `hunt-ctl` builds
 * the plan with `planCli.ts` in a sandbox, starts the services and routes it lists and hands it to the supervisor in the
 * session container (`supervisor.ts`), which runs the steps and processes.
 *
 *   "preview": {
 *     "services": { "db": { "kind": "postgres-18", "env": { "POSTGRES_PASSWORD": "dev" }, "memory": "1g" } },
 *     "env": { "DATABASE_URL": "postgres://postgres:dev@127.0.0.1:5432/postgres", "APP_URL": "${HUNT_PREVIEW_URL}" },
 *     "prepare": [{ "name": "install", "run": "npm ci" }],
 *     "init": [{ "name": "seed", "run": "npm run db:seed", "cwd": "apps/api" }],
 *     "processes": {
 *       "api": { "run": "npm run start:api", "port": 3000, "ready": "/health", "main": true },
 *       "worker": { "run": "npm run start:worker" }
 *     }
 *   }
 *
 * - `services`: name → `{kind, env?, memory?}` from SERVICE_CATALOG, at most one per kind; steps and processes reach a
 *   service on 127.0.0.1 at its catalog port. `memory` is `<n>m` or `<n>g`, at least 64m, at most 4g for all together.
 * - `env` applies to every step and process, an item's own `env` on top of it. Keys match `^[A-Z_][A-Z0-9_]*$` and do
 *   not start with `CLAUDE_` or `HUNT_`; values are single lines. `${HUNT_PREVIEW_URL}` in a value becomes the main
 *   URL, `${HUNT_PREVIEW_URL_<port>}` the URL of a process's port.
 * - `prepare` runs at every start, `init` once per data generation; each holds at most 10 steps `{name, run, cwd?, env?}`.
 * - `processes`: name → `{run, cwd?, env?, port?, protocol?, ready?, main?, optional?}`, at most 8, exactly one `main`
 *   with a port. `protocol` (`http` or `https`) is what the process serves on its port; `ready` is a path that must
 *   answer below 500 before the process counts as ready; `optional` processes start only when requested, with the plan
 *   or later one by one. A process with a port listens on 0.0.0.0: the readiness check, like the edge proxy, connects to
 *   the container's address.
 * - Names match `^[a-z][a-z0-9-]{0,23}$` (no process is called `setup`, the steps' log); ports are integers from 1024 to
 *   65535, unique and not reserved (isReservedPort); `cwd` is relative to the worktree, without `..`; `run` is one line
 *   of bash. Unknown fields are errors.
 *
 * Every process with a port is served at `https://<short>-<port>.<domain>`, the main process also at
 * `https://<short>.<domain>`; `<short>` is the first 8 hex digits of the session ID.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isRecord } from "../jsonRpc.ts";

export type ServiceKind = "postgres-18" | "redis-7.2";
export type Protocol = "http" | "https";

interface CatalogEntry {
  port: number;
  /** The environment variables the service takes. */
  env: readonly string[];
  memoryMb: number;
}

export const SERVICE_CATALOG: Record<ServiceKind, CatalogEntry> = {
  "postgres-18": { port: 5432, env: ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"], memoryMb: 1024 },
  "redis-7.2": { port: 6379, env: [], memoryMb: 256 },
};

/** The log of the prepare and init steps, next to one log per process; no process may have this name. */
export const SETUP_LOG = "setup";

export interface PlanService {
  name: string;
  kind: ServiceKind;
  port: number;
  env: Record<string, string>;
  memoryMb: number;
}

/** `127.0.0.1:<port>` in the session container, forwarded to `<host>:<port>`, a service container. */
export interface PlanForward {
  port: number;
  host: string;
}

export interface PlanStep {
  name: string;
  run: string;
  /** Relative to the worktree; `.` is the worktree itself. */
  cwd: string;
  env: Record<string, string>;
}

export interface PlanProcess {
  name: string;
  run: string;
  cwd: string;
  env: Record<string, string>;
  port: number | null;
  protocol: Protocol;
  ready: string | null;
  main: boolean;
  optional: boolean;
  /** Whether applying the plan starts the process: every process that is not optional, and the requested optional ones. */
  autostart: boolean;
}

/** A host name of the preview and the port and protocol of the process that serves it. */
export interface PlanRoute {
  host: string;
  port: number;
  protocol: Protocol;
}

export interface PlanUrls {
  main: string;
  /** By process name, for every process with a port; the main process has the main URL. */
  processes: Record<string, string>;
}

export interface PreviewPlan {
  version: 1;
  sessionId: string;
  short: string;
  domain: string;
  services: PlanService[];
  forwards: PlanForward[];
  env: Record<string, string>;
  prepare: PlanStep[];
  init: PlanStep[];
  /** SHA-256 over the services and the init steps: a change of either runs the init steps again. */
  initHash: string;
  /** Every process of the preview; the supervisor starts the `autostart` ones with the plan and the others on request. */
  processes: PlanProcess[];
  routes: PlanRoute[];
  urls: PlanUrls;
}

export interface PlanOptions {
  sessionId: string;
  domain: string;
  /** Optional processes to run. */
  withOptional?: readonly string[];
}

/** Every problem found in a `hunt.json` or a plan, each starting with the path of the offending value. */
export class ContractError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ContractError";
    this.problems = problems;
  }
}

const NAME = /^[a-z][a-z0-9-]{0,23}$/;
const NAME_RULE = "must match ^[a-z][a-z0-9-]{0,23}$";
const SETUP_RESERVED = "setup is reserved for the log of the prepare and init steps";
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ["CLAUDE_", "HUNT_"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Leaves room for the `<short>-<port>.` in front of the domain within the 253 characters of a host name. */
const MAX_DOMAIN_LENGTH = 253 - "01234567-65535.".length;
const MEMORY = /^([1-9][0-9]{0,6})([mg])$/;
const READY_PATH = /^\/[\x21-\x7e]*$/;
const PLACEHOLDER = /\$\{(HUNT_[A-Za-z0-9_]*)\}/g;
const URL_PLACEHOLDER = /^HUNT_PREVIEW_URL(?:_([1-9][0-9]{0,4}))?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_STEPS = 10;
const MAX_PROCESSES = 8;
const MIN_SERVICE_MEMORY_MB = 64;
const MAX_SERVICE_MEMORY_MB = 4096;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const PREVIEW_FIELDS = ["services", "env", "prepare", "init", "processes"];
const SERVICE_FIELDS = ["kind", "env", "memory"];
const STEP_FIELDS = ["name", "run", "cwd", "env"];
const PROCESS_FIELDS = ["run", "cwd", "env", "port", "protocol", "ready", "main", "optional"];
const PLAN_FIELDS = ["version", "sessionId", "short", "domain", "services", "forwards", "env", "prepare", "init", "initHash", "processes", "routes", "urls"];
const PLAN_PROCESS_FIELDS = ["name", ...PROCESS_FIELDS, "autostart"];

export function isName(value: string): boolean {
  return NAME.test(value);
}

/** Ports no process may use: Caddy's admin API (2019), the service ports and 9200–9249, which Hunt keeps for itself. */
export function isReservedPort(port: number): boolean {
  return port === 2019 || (port >= 9200 && port <= 9249) || Object.values(SERVICE_CATALOG).some((service) => service.port === port);
}

export function mainUrl(short: string, domain: string): string {
  return `https://${short}.${domain}`;
}

export function portUrl(short: string, domain: string, port: number): string {
  return `https://${short}-${port}.${domain}`;
}

/** The variables every step and process gets: `HUNT_PREVIEW_URL` and `HUNT_PREVIEW_URL_<port>` per process port. */
export function previewUrlEnv(plan: PreviewPlan): Record<string, string> {
  const env: Record<string, string> = { HUNT_PREVIEW_URL: plan.urls.main };
  for (const spec of plan.processes) {
    if (spec.port) {
      env[`HUNT_PREVIEW_URL_${spec.port}`] = portUrl(plan.short, plan.domain, spec.port);
    }
  }
  return env;
}

/** Checks `huntJson` (the parsed file) and builds the plan of the session's preview; throws a ContractError. */
export function buildPlan(huntJson: unknown, options: PlanOptions): PreviewPlan {
  const problems = new Problems();
  const sessionId = UUID.test(options.sessionId) ? options.sessionId : problems.add("session", "must be a session ID, a lowercase UUID");
  const domain = isDomain(options.domain) ? options.domain : problems.add("domain", "must be a lowercase host name with at least two labels");
  const root = record(huntJson, "hunt.json", null, problems);
  if (root && root.preview === undefined) {
    problems.add("preview", "missing: hunt.json has no preview section");
  }
  const preview = root?.preview === undefined ? undefined : record(root.preview, "preview", PREVIEW_FIELDS, problems);
  if (!preview) throw new ContractError(problems.messages);

  const drafts = parseProcesses(preview.processes, problems);
  const ports = new Set(drafts.flatMap((draft) => (draft.port ? [draft.port] : [])));
  const processes = drafts.map(({ rawEnv, envPath, ...draft }) => ({ ...draft, env: environment(rawEnv, envPath, ports, problems) }));
  const services = parseServices(preview.services, ports, problems);
  const env = environment(preview.env, "preview.env", ports, problems);
  const prepare = parseSteps(preview.prepare, "preview.prepare", ports, problems);
  const init = parseSteps(preview.init, "preview.init", ports, problems);
  for (const name of options.withOptional ?? []) {
    if (!drafts.some((draft) => draft.name === name)) {
      problems.add("with", `preview.processes has no process ${name}`);
    }
  }
  if (problems.messages.length > 0 || !sessionId || !domain) throw new ContractError(problems.messages);

  const short = sessionId.slice(0, 8);
  const expand = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandPlaceholders(value, short, domain)]));
  const requested = new Set(options.withOptional ?? []);
  const planProcesses: PlanProcess[] = processes.map(({ name, run, cwd, env: own, port, protocol, ready, main, optional }) => {
    return { name, run, cwd, env: expand(own), port, protocol, ready, main, optional, autostart: !optional || requested.has(name) };
  });
  const main = planProcesses.find((spec) => spec.main);
  if (!main?.port) throw new ContractError(["preview.processes: the main process needs a port"]);

  const routes: PlanRoute[] = [{ host: `${short}.${domain}`, port: main.port, protocol: main.protocol }];
  const processUrls: Record<string, string> = {};
  for (const spec of planProcesses) {
    if (!spec.port) continue;
    routes.push({ host: `${short}-${spec.port}.${domain}`, port: spec.port, protocol: spec.protocol });
    processUrls[spec.name] = spec.main ? mainUrl(short, domain) : portUrl(short, domain, spec.port);
  }
  const planServices = services.map((service) => ({ ...service, env: expand(service.env) }));
  const planInit = init.map((step) => ({ ...step, env: expand(step.env) }));
  return {
    version: 1,
    sessionId,
    short,
    domain,
    services: planServices,
    forwards: planServices.map((service) => ({ port: service.port, host: service.name })),
    env: expand(env),
    prepare: prepare.map((step) => ({ ...step, env: expand(step.env) })),
    init: planInit,
    initHash: createHash("sha256").update(canonicalJson({ services: planServices, init: planInit })).digest("hex"),
    processes: planProcesses,
    routes,
    urls: { main: mainUrl(short, domain), processes: processUrls },
  };
}

/** Checks a plan that comes back to the relay, over the control socket or from its state directory; throws a ContractError. */
export function parsePlan(value: unknown): PreviewPlan {
  const problems = new Problems();
  const plan = record(value, "plan", PLAN_FIELDS, problems);
  if (!plan) throw new ContractError(problems.messages);
  if (plan.version !== 1) {
    problems.add("plan.version", "must be 1");
  }
  const sessionId = typeof plan.sessionId === "string" && UUID.test(plan.sessionId) ? plan.sessionId : problems.add("plan.sessionId", "must be a lowercase UUID");
  const domain = typeof plan.domain === "string" && isDomain(plan.domain) ? plan.domain : problems.add("plan.domain", "must be a lowercase host name");
  if (sessionId && plan.short !== sessionId.slice(0, 8)) {
    problems.add("plan.short", "must be the first 8 hex digits of plan.sessionId");
  }
  for (const field of ["services", "routes"]) {
    if (!Array.isArray(plan[field])) {
      problems.add(`plan.${field}`, "must be an array");
    }
  }
  const forwards = parseForwards(plan.forwards, problems);
  const env = environment(plan.env, "plan.env", null, problems);
  const prepare = parseSteps(plan.prepare, "plan.prepare", null, problems);
  const init = parseSteps(plan.init, "plan.init", null, problems);
  const initHash = typeof plan.initHash === "string" && SHA256_HEX.test(plan.initHash) ? plan.initHash : problems.add("plan.initHash", "must be a SHA-256 in hex");
  const processes = parsePlanProcesses(plan.processes, problems);
  const urls = parseUrls(plan.urls, problems);
  if (problems.messages.length > 0 || !sessionId || !domain || !initHash || !urls) throw new ContractError(problems.messages);
  const services = plan.services as PlanService[];
  const routes = plan.routes as PlanRoute[];
  return { version: 1, sessionId, short: sessionId.slice(0, 8), domain, services, forwards, env, prepare, init, initHash, processes, routes, urls };
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

function singleLine(value: unknown, path: string, problems: Problems): string | undefined {
  if (typeof value !== "string") return problems.add(path, "must be a string");
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) return problems.add(path, "must be a single line");
  return value;
}

function command(value: unknown, path: string, problems: Problems): string | undefined {
  const text = singleLine(value, path, problems);
  if (text !== undefined && !text.trim()) return problems.add(path, "must not be empty");
  return text;
}

/** A `cwd`, normalized; `.` when there is none. */
function directory(value: unknown, path: string, problems: Problems): string | undefined {
  if (value === undefined) return ".";
  const text = singleLine(value, path, problems);
  if (text === undefined) return undefined;
  if (!text || text.startsWith("/") || text.split("/").includes("..")) return problems.add(path, "must be a path inside the worktree, relative and without ..");
  return posix.normalize(text).replace(/\/+$/, "") || ".";
}

function envKeyProblem(key: string): string | null {
  if (!ENV_KEY.test(key)) return "invalid name, must match ^[A-Z_][A-Z0-9_]*$";
  if (RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) return "reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt";
  return null;
}

/** An `env` object of single-line strings; placeholders are checked against the process ports unless `ports` is null. */
function environment(
  value: unknown,
  path: string,
  ports: ReadonlySet<number> | null,
  problems: Problems,
  keyProblem: (key: string) => string | null = envKeyProblem,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (value === undefined) return env;
  const entries = record(value, path, null, problems);
  for (const [key, entry] of Object.entries(entries ?? {})) {
    const entryPath = at(path, key);
    const problem = keyProblem(key);
    if (problem) {
      problems.add(entryPath, problem);
      continue;
    }
    const text = singleLine(entry, entryPath, problems);
    if (text === undefined) continue;
    if (ports) {
      checkPlaceholders(text, entryPath, ports, problems);
    }
    env[key] = text;
  }
  return env;
}

function checkPlaceholders(value: string, path: string, ports: ReadonlySet<number>, problems: Problems): void {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const port = URL_PLACEHOLDER.exec(match[1]);
    if (!port) {
      problems.add(path, `unknown placeholder ${match[0]}`);
    } else if (port[1] && !ports.has(Number(port[1]))) {
      problems.add(path, `${match[0]} names port ${port[1]}, which no process has`);
    }
  }
}

function expandPlaceholders(value: string, short: string, domain: string): string {
  return value.replace(PLACEHOLDER, (_placeholder, name: string) => {
    const port = URL_PLACEHOLDER.exec(name)?.[1];
    return port ? portUrl(short, domain, Number(port)) : mainUrl(short, domain);
  });
}

function isDomain(value: string): boolean {
  const labels = value.split(".");
  return value.length <= MAX_DOMAIN_LENGTH && labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

function processPort(value: unknown, path: string, problems: Problems): number | undefined {
  const isInRange = typeof value === "number" && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
  if (!isInRange) return problems.add(path, "must be an integer from 1024 to 65535");
  if (isReservedPort(value)) return problems.add(path, `${value} is reserved; 2019, 5432, 6379 and 9200–9249 are not available`);
  return value;
}

function flag(value: unknown, path: string, problems: Problems): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  problems.add(path, "must be true or false");
  return false;
}

function parseServices(value: unknown, ports: ReadonlySet<number>, problems: Problems): PlanService[] {
  const path = "preview.services";
  const services: PlanService[] = [];
  if (value === undefined) return services;
  const owners = new Map<ServiceKind, string>();
  for (const [name, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const servicePath = at(path, name);
    if (!NAME.test(name)) {
      problems.add(servicePath, `invalid name, ${NAME_RULE}`);
      continue;
    }
    const spec = record(entry, servicePath, SERVICE_FIELDS, problems);
    const kind = spec && serviceKind(spec.kind, at(servicePath, "kind"), problems);
    if (!spec || !kind) continue;
    const owner = owners.get(kind);
    if (owner) {
      problems.add(at(servicePath, "kind"), `only one ${kind} service is possible: 127.0.0.1:${SERVICE_CATALOG[kind].port} goes to ${owner}`);
      continue;
    }
    owners.set(kind, name);
    const env = environment(spec.env, at(servicePath, "env"), ports, problems, (key) => catalogKeyProblem(kind, key));
    const memoryMb = memory(spec.memory, at(servicePath, "memory"), SERVICE_CATALOG[kind].memoryMb, problems);
    if (memoryMb === undefined) continue;
    services.push({ name, kind, port: SERVICE_CATALOG[kind].port, env, memoryMb });
  }
  const totalMb = services.reduce((sum, service) => sum + service.memoryMb, 0);
  if (totalMb > MAX_SERVICE_MEMORY_MB) {
    problems.add(path, `the services need ${totalMb}m of memory together, at most 4g are possible`);
  }
  return services;
}

function serviceKind(value: unknown, path: string, problems: Problems): ServiceKind | undefined {
  if (typeof value === "string" && Object.hasOwn(SERVICE_CATALOG, value)) return value as ServiceKind;
  return problems.add(path, `must be one of ${Object.keys(SERVICE_CATALOG).join(", ")}`);
}

function catalogKeyProblem(kind: ServiceKind, key: string): string | null {
  const allowed = SERVICE_CATALOG[kind].env;
  if (allowed.includes(key)) return null;
  return allowed.length > 0 ? `not taken by ${kind}, which takes ${allowed.join(", ")}` : `${kind} takes no environment variables`;
}

function memory(value: unknown, path: string, fallbackMb: number, problems: Problems): number | undefined {
  if (value === undefined) return fallbackMb;
  const match = typeof value === "string" ? MEMORY.exec(value) : null;
  if (!match) return problems.add(path, 'must be a size such as "512m" or "1g"');
  const megabytes = Number(match[1]) * (match[2] === "g" ? 1024 : 1);
  if (megabytes < MIN_SERVICE_MEMORY_MB) return problems.add(path, "must be at least 64m");
  return megabytes;
}

function parseSteps(value: unknown, path: string, ports: ReadonlySet<number> | null, problems: Problems): PlanStep[] {
  const steps: PlanStep[] = [];
  if (value === undefined) return steps;
  if (!Array.isArray(value)) {
    problems.add(path, "must be an array of steps");
    return steps;
  }
  if (value.length > MAX_STEPS) {
    problems.add(path, `has ${value.length} steps, at most ${MAX_STEPS} are possible`);
  }
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const stepPath = at(path, index);
    const spec = record(entry, stepPath, STEP_FIELDS, problems);
    if (!spec) continue;
    const name = uniqueName(spec.name, at(stepPath, "name"), names, "step", problems);
    const run = command(spec.run, at(stepPath, "run"), problems);
    const cwd = directory(spec.cwd, at(stepPath, "cwd"), problems);
    const env = environment(spec.env, at(stepPath, "env"), ports, problems);
    if (name && run !== undefined && cwd) {
      steps.push({ name, run, cwd, env });
    }
  }
  return steps;
}

function uniqueName(value: unknown, path: string, taken: Set<string>, kind: string, problems: Problems): string | undefined {
  if (typeof value !== "string" || !NAME.test(value)) return problems.add(path, NAME_RULE);
  if (taken.has(value)) return problems.add(path, `${value} is the name of another ${kind}`);
  taken.add(value);
  return value;
}

interface ProcessDraft extends Omit<PlanProcess, "env" | "autostart"> {
  rawEnv: unknown;
  envPath: string;
}

/** The processes without their `env`, which is checked once all ports are known. */
function parseProcesses(value: unknown, problems: Problems): ProcessDraft[] {
  const path = "preview.processes";
  const drafts: ProcessDraft[] = [];
  if (value === undefined) {
    problems.add(path, "missing: a preview needs a main process");
    return drafts;
  }
  const entries = Object.entries(record(value, path, null, problems) ?? {});
  if (entries.length > MAX_PROCESSES) {
    problems.add(path, `has ${entries.length} processes, at most ${MAX_PROCESSES} are possible`);
  }
  const portOwners = new Map<number, string>();
  let mains = 0;
  for (const [name, entry] of entries) {
    const processPath = at(path, name);
    if (!NAME.test(name) || name === SETUP_LOG) {
      problems.add(processPath, name === SETUP_LOG ? SETUP_RESERVED : `invalid name, ${NAME_RULE}`);
      continue;
    }
    const spec = record(entry, processPath, PROCESS_FIELDS, problems);
    if (!spec) continue;
    const hasPort = spec.port !== undefined;
    const run = command(spec.run, at(processPath, "run"), problems);
    const cwd = directory(spec.cwd, at(processPath, "cwd"), problems);
    const port = hasPort ? processPort(spec.port, at(processPath, "port"), problems) : null;
    const protocol = protocolOf(spec.protocol, at(processPath, "protocol"), hasPort, problems);
    const ready = readyPathOf(spec.ready, at(processPath, "ready"), hasPort, problems);
    const main = flag(spec.main, at(processPath, "main"), problems);
    const optional = flag(spec.optional, at(processPath, "optional"), problems);
    if (port) {
      const owner = portOwners.get(port);
      if (owner) {
        problems.add(at(processPath, "port"), `${port} is the port of ${owner} already`);
      }
      portOwners.set(port, name);
    }
    if (main) {
      mains++;
      if (!hasPort) {
        problems.add(processPath, "the main process needs a port");
      }
      if (optional) {
        problems.add(at(processPath, "optional"), "the main process cannot be optional");
      }
    }
    if (run === undefined || !cwd || port === undefined || !protocol || ready === undefined) continue;
    drafts.push({ name, run, cwd, port, protocol, ready, main, optional, rawEnv: spec.env, envPath: at(processPath, "env") });
  }
  if (mains !== 1) {
    problems.add(path, `needs exactly one process with "main": true, not ${mains}`);
  }
  return drafts;
}

function protocolOf(value: unknown, path: string, hasPort: boolean, problems: Problems): Protocol | undefined {
  if (value === undefined) return "http";
  if (!hasPort) return problems.add(path, "needs a port");
  if (value === "http" || value === "https") return value;
  return problems.add(path, 'must be "http" or "https"');
}

function readyPathOf(value: unknown, path: string, hasPort: boolean, problems: Problems): string | null | undefined {
  if (value === undefined) return null;
  if (!hasPort) return problems.add(path, "needs a port");
  if (typeof value !== "string" || !READY_PATH.test(value)) return problems.add(path, 'must be a path such as "/health"');
  return value;
}

function parseForwards(value: unknown, problems: Problems): PlanForward[] {
  const forwards: PlanForward[] = [];
  if (!Array.isArray(value)) {
    problems.add("plan.forwards", "must be an array");
    return forwards;
  }
  for (const [index, entry] of value.entries()) {
    const path = at("plan.forwards", index);
    const spec = record(entry, path, ["port", "host"], problems);
    if (!spec) continue;
    if (typeof spec.port !== "number" || !Number.isInteger(spec.port) || spec.port < 1 || spec.port > MAX_PORT) {
      problems.add(at(path, "port"), "must be a port number");
    } else if (typeof spec.host !== "string" || !NAME.test(spec.host)) {
      problems.add(at(path, "host"), "must be the name of a service");
    } else {
      forwards.push({ port: spec.port, host: spec.host });
    }
  }
  return forwards;
}

function parsePlanProcesses(value: unknown, problems: Problems): PlanProcess[] {
  const path = "plan.processes";
  const processes: PlanProcess[] = [];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROCESSES) {
    problems.add(path, `must be an array of 1 to ${MAX_PROCESSES} processes`);
    return processes;
  }
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const processPath = at(path, index);
    const spec = record(entry, processPath, PLAN_PROCESS_FIELDS, problems);
    if (!spec) continue;
    const hasPort = spec.port !== null;
    const namePath = at(processPath, "name");
    const name = spec.name === SETUP_LOG ? problems.add(namePath, SETUP_RESERVED) : uniqueName(spec.name, namePath, names, "process", problems);
    const run = command(spec.run, at(processPath, "run"), problems);
    const cwd = directory(spec.cwd, at(processPath, "cwd"), problems);
    const env = environment(spec.env, at(processPath, "env"), null, problems);
    const port = hasPort ? processPort(spec.port, at(processPath, "port"), problems) : null;
    const protocol = spec.protocol === "http" || spec.protocol === "https" ? spec.protocol : problems.add(at(processPath, "protocol"), 'must be "http" or "https"');
    const ready = spec.ready === null ? null : readyPathOf(spec.ready, at(processPath, "ready"), hasPort, problems);
    const main = flag(spec.main, at(processPath, "main"), problems);
    const optional = flag(spec.optional, at(processPath, "optional"), problems);
    const autostart = flag(spec.autostart, at(processPath, "autostart"), problems);
    if (!name || run === undefined || !cwd || port === undefined || !protocol || ready === undefined) continue;
    processes.push({ name, run, cwd, env, port, protocol, ready, main, optional, autostart });
  }
  return processes;
}

function parseUrls(value: unknown, problems: Problems): PlanUrls | undefined {
  const urls = record(value, "plan.urls", ["main", "processes"], problems);
  if (!urls) return undefined;
  const main = typeof urls.main === "string" ? urls.main : problems.add("plan.urls.main", "must be a string");
  const processes = record(urls.processes, "plan.urls.processes", null, problems);
  if (!main || !processes) return undefined;
  const byName: Record<string, string> = {};
  for (const [name, url] of Object.entries(processes)) {
    if (typeof url === "string") {
      byName[name] = url;
    } else {
      problems.add(at("plan.urls.processes", name), "must be a string");
    }
  }
  return { main, processes: byName };
}

/** JSON with the keys of every object sorted, so that equal values hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
