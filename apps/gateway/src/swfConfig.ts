/**
 * The configuration of hunt-swf, the gateway's GitHub poller (`swf.ts`), in `/etc/hunt/swf.json`: the repositories it
 * checks for open issues with the label `label`, how many of its session VMs may be up at once, and the instance
 * template (and machine type) it creates them from. Hunt writes the file through `hunt-ctl swf-config`, which runs
 *
 *   node swfConfig.ts --validate
 *
 * with the JSON object on stdin: it prints the normalized configuration as one line of JSON and exits 0, or prints
 * `{"ok": false, "problems": […]}` and exits 1. No file or no repositories leaves the poller idle.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SWF_CONFIG_PATH = "/etc/hunt/swf.json";
export const DEFAULT_LABEL = "swf";
export const DEFAULT_MAX_SESSIONS = 2;
export const MAX_SESSIONS_LIMIT = 10;
export const DEFAULT_TEMPLATE = "tpl-hunt-session";

export interface SwfConfig {
  /** `<owner>/<repo>` of each repository, in the order the poller checks them. */
  repos: string[];
  /** How many session VMs the poller started may run at once; 0 pauses it. */
  maxSessions: number;
  /** The label that asks for a session; the poller adds `<label>:running`, `<label>:done` and `<label>:failed`. */
  label: string;
  template: string;
  /** A machine type other than the template's; null keeps the template's. */
  machineType: string | null;
}

/** `<owner>/<repo>` with the characters `hunt-ctl` accepts; no part starts with a dot. */
const REPOSITORY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const LABEL = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
const COMPUTE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

export type ParsedSwfConfig = { config: SwfConfig; problems?: undefined } | { config?: undefined; problems: string[] };

/** Validates and normalizes a parsed swf.json; missing fields get their defaults, repositories are deduplicated. */
export function parseSwfConfig(value: unknown): ParsedSwfConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { problems: ["the configuration must be a JSON object"] };
  const raw = value as Record<string, unknown>;
  const problems: string[] = [];

  const repos: string[] = [];
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) {
    problems.push("repos: must be a list of <owner>/<repo>");
  }
  for (const [index, entry] of (Array.isArray(raw.repos) ? raw.repos : []).entries()) {
    const repo = typeof entry === "string" ? entry.trim() : "";
    if (!REPOSITORY.test(repo)) {
      problems.push(`repos[${index}]: ${JSON.stringify(entry)} is no <owner>/<repo>`);
      continue;
    }
    if (!repos.some((known) => known.toLowerCase() === repo.toLowerCase())) {
      repos.push(repo);
    }
  }

  const maxSessions = raw.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (typeof maxSessions !== "number" || !Number.isInteger(maxSessions) || maxSessions < 0 || maxSessions > MAX_SESSIONS_LIMIT) {
    problems.push(`maxSessions: must be a whole number from 0 to ${MAX_SESSIONS_LIMIT}`);
  }
  const label = raw.label ?? DEFAULT_LABEL;
  if (typeof label !== "string" || !LABEL.test(label)) {
    problems.push("label: must be 1 to 40 lowercase letters, digits, ':', '_' or '-'");
  }
  const template = raw.template ?? DEFAULT_TEMPLATE;
  if (typeof template !== "string" || !COMPUTE_NAME.test(template)) {
    problems.push("template: must be a Compute Engine name");
  }
  const machineType = raw.machineType === "" ? null : (raw.machineType ?? null);
  if (machineType !== null && (typeof machineType !== "string" || !COMPUTE_NAME.test(machineType))) {
    problems.push("machineType: must be a Compute Engine name or null");
  }

  if (problems.length > 0) return { problems };
  return { config: { repos, maxSessions: maxSessions as number, label: label as string, template: template as string, machineType: machineType as string | null } };
}

/** The configuration in `path`; null when there is no such file. Throws for a file that is no valid configuration. */
export function readSwfConfig(path = SWF_CONFIG_PATH): SwfConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`failed to read ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to read ${path}: ${(error as Error).message}`);
  }
  const parsed = parseSwfConfig(value);
  if (parsed.problems) throw new Error(`failed to read ${path}: ${parsed.problems.join("; ")}`);
  return parsed.config;
}

/** `--validate`: see the module comment. */
function validateStdin(): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, problems: [`stdin holds no JSON: ${(error as Error).message}`] })}\n`);
    process.exit(1);
  }
  const parsed = parseSwfConfig(value);
  if (parsed.problems) {
    process.stdout.write(`${JSON.stringify({ ok: false, problems: parsed.problems })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(parsed.config)}\n`);
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--validate" || process.argv.length !== 3) {
    process.stderr.write("usage: swfConfig.ts --validate < config.json\n");
    process.exit(2);
  }
  validateStdin();
}
