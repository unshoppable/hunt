/**
 * A repository's `hunt.json` in contract version 3: the services of the repository, which Hunt runs on a session's VM
 * as systemd units that the agent starts when its task needs them, each with the ignored files it needs in a worktree,
 * the checks a person runs from the client's Checks tab, the settings of the sessions the gateway's poller starts
 * for the repository's `swf` issues, and the folder of its architectural decision records.
 *
 *   {
 *     "version": 3,
 *     "adrDir": "docs/adr",
 *     "swf": {
 *       "model": "claude-opus-5-5", "humanReviewPaths": ["apps/backend/migrations/**"],
 *       "skills": { "plan": "swf-plan", "implement": "swf-implement", "verify": "swf-verify", "gate": "swf-gate", "pr": "swf-pr" }
 *     },
 *     "services": {
 *       "backend": {
 *         "command": "npm run start:backend", "port": 3000, "tls": true, "guarded": false,
 *         "env": { "UI_BASE_URL": "${services.ui.publicUrl}" },
 *         "remoteSecrets": { "OPENAI_API_KEY": "$MED_OPENAI_API_KEY" },
 *         "worktreeInclude": ["apps/backend/.env.private"]
 *       },
 *       "ui": { "command": "npm start", "cwd": "apps/ui", "port": 4200, "env": { "BACKEND_ORIGIN": "${services.backend.publicUrl}" } },
 *       "storybook": { "command": "npm run storybook", "port": 6006, "review": false }
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
 * - `port`: an integer from 1024 to 65535, not reserved (RESERVED_PORTS in `hunt-json.rules.ts`) and the port of no
 *   other service.
 * - `tls`: whether the service speaks HTTPS, false by default; its certificate is not checked, so a self-signed one works.
 * - `guarded`: true by default. Every service answers at `https://<short>-<port>.<domain>` behind IAP's Google login; a
 *   service with false also answers at `https://<short>-<port>-open.<domain>` without IAP, behind the app's own login only.
 * - `review`: true by default: the HTML pages of the service's guarded host get Hunt's review widget, with which a
 *   person comments on an element of the page for the agent (`../review/review-server.service.ts`); false leaves its pages unchanged.
 * - `env`: variables of this service only. Keys match `^[A-Z_][A-Z0-9_]*$` and do not start with `CLAUDE_` or `HUNT_`;
 *   values are single lines. `${services.<name>.publicUrl}` in a value becomes the URL of that service, its open URL when
 *   it is not guarded; every other `${…}` but contract 2's `${HUNT_…}` stays as it is.
 * - `remoteSecrets`: variables of this service whose values are remote secrets (`libs/domain/src/remote-secrets/remote-secret.value-object.ts`),
 *   which a person stores in Hunt under Settings → Remote VM and the gateway puts on the VM. Keys follow the rules of
 *   `env` and appear in only one of the two; each value is `$<NAME>`, the name of a remote secret, which must exist.
 * - `worktreeInclude`: the ignored files this service needs, which git leaves out of a checkout, such as its
 *   `.env.private`: up to 64 glob patterns relative to the worktree (`*` stays within a folder, `**` crosses folders),
 *   each one line of at most 255 characters that is not absolute and has no `..` segment (GLOB_PATTERN_RULE); none by
 *   default. Hunt copies the matching files of the repository's checkout into every worktree it creates and takes them
 *   along to the session VM; the VM only validates the list.
 * - `swf`: optional, the settings of the poller's sessions, with the fields `model`, `humanReviewPaths` and `skills`; a
 *   repository without it takes no part in the poller's workflow, and none of its rules applies:
 *   - `model`: the model of Claude Code in a session of the poller: the full ID of a Claude model such as
 *     `claude-opus-5-5` (ZodModelId), at most 128 characters, never an alias such as `opus`, whose model changes with
 *     Claude Code's releases. The poller sets it as the session's `model` config option; without it, or when the agent
 *     knows no such model (the relay logs that), Claude Code's default model applies. Sessions started from Hunt keep
 *     the model their user picks.
 *   - `humanReviewPaths`: glob patterns that follow the rules of `worktreeInclude`; a pull request of a poller session
 *     that touches a file matching one of them always needs a human reviewer. None by default; the VM only validates
 *     the list and reports it to the poller.
 *   - `skills`: required with the section: the Claude Code skills (`.claude/skills/<name>/SKILL.md`, names like
 *     `guardrailSkill`) with which the repository refines the agent steps of the poller's pipeline, keyed by the step
 *     (`plan`, `implement`, `verify`, `gate`, `pr`; AGENT_STEPS): the step's prompt tells the agent to invoke the skill
 *     first. Every agent step must have one; Hunt has no default, so a missing map and each step it leaves out are
 *     problems, which the client's dialog on opening a session of the repository offers to fix (entries `swf-<step>`
 *     and the skill files from its templates). The worktree must hold the skill file of every step, which
 *     `session-config.service.ts` checks; the VM reports the skills to the poller.
 * - `checks`: optional, at most 32 commands such as the linter or the tests, in the order of the file, each named like a
 *   service, with the only fields `command` and `cwd`, which follow the rules of a service's. The client's Checks tab
 *   runs them in the worktree on the Mac, or on the session VM through `hunt-ctl check`, and shows their output and
 *   exit status.
 * - `adrDir`: optional, the folder of the repository's architectural decision records, which the client's guardrails
 *   window lists and writes; it follows the rules of a service's `cwd` and is `.claude/resources/adrs` without it. The
 *   VM only validates it.
 * - `guardrailSkill`: optional, the name of the Claude Code skill (`.claude/skills/<name>/SKILL.md`) the client's
 *   "Guardrail" button invokes and whose criteria decide when the button lights up: kebab-case of letters and digits,
 *   at most 64 characters, `guardrail` without it. The client writes the skill from its template when a session
 *   starts in a worktree that lacks it; the VM only validates the name.
 *
 * `<short>` is the first 8 hex digits of the session ID. `session-config.main.ts` writes the session's environment, one
 * environment file per service and the configuration of the VM's preview proxy.
 *
 * `HuntJson` is the file as the aggregate of its ServiceConfig, CheckConfig and SwfSettings. `fromDocument` walks a
 * parsed document by hand and reports every problem, each starting with the path of the offending value: the unknown
 * fields of an object before its fields, the fields in the order above, each scalar checked against its rule in
 * `hunt-json.rules.ts` (`problems.utils.ts` holds the walk's plumbing). zod's own objects would report unknown fields
 * last and skip the rules across fields after a type error. The two rules across services, a port of each service's
 * own and a declared service for each `${services.<name>.publicUrl}`, the walk reports where it meets them and the
 * aggregate's schema checks as well.
 */
import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { AGENT_STEPS, type AgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { CheckConfig } from "./check-config.value-object.ts";
import { ConfigError } from "./config.error.ts";
import {
  SERVICE_PLACEHOLDER,
  ZodCommandLine,
  ZodContractVersion,
  ZodEnvValue,
  ZodEnvVariableName,
  ZodFlag,
  ZodGlobPatterns,
  ZodModelId,
  ZodNoContract2Placeholders,
  ZodRemoteSecretReference,
  ZodServiceName,
  ZodServicePlaceholder,
  ZodServicePort,
  ZodSkillName,
  ZodWorktreeFolder,
} from "./hunt-json.rules.ts";
import { at, parseField, parseOptionalField, Problems, record } from "./problems.utils.ts";
import { ServiceConfig } from "./service-config.value-object.ts";
import { SwfSettings } from "./swf-settings.value-object.ts";

const ROOT_FIELDS = ["version", "adrDir", "guardrailSkill", "swf", "services", "checks"];
const SWF_FIELDS = ["model", "humanReviewPaths", "skills"];
const SERVICE_FIELDS = ["command", "cwd", "port", "tls", "guarded", "review", "env", "remoteSecrets", "worktreeInclude"];
const CHECK_FIELDS = ["command", "cwd"];
const MAX_SERVICES = 64;
const SERVICES_RULE = `must hold 1 to ${MAX_SERVICES} services`;
const MAX_CHECKS = 32;
const CHECKS_RULE = `must hold at most ${MAX_CHECKS} checks`;
const CONTRACT_2_PROBLEM = 'the preview section of contract 2 is no longer read; hunt.json holds {"version": 3, "services": {…}} at its root';
/** Hunt has no default skill: the client's dialog on opening a session of the repository adds the missing entries. */
const SKILLS_RULE = `must name the skill of every agent step (${AGENT_STEPS.join(", ")}); Hunt asks to add them when a session of the repository opens`;
const STEP_SKILL_RULE = "must name the skill of the step; Hunt asks to add it when a session of the repository opens";

const ZodHuntJsonState = z
  .object({
    /** Always 3; the walk requires the field, the state fills it in. */
    version: z._default(ZodContractVersion, 3),
    /** The folder of the architectural decision records relative to the worktree; null for the client's default. */
    adrDir: z._default(z.nullable(ZodWorktreeFolder), null),
    /** The skill of the client's "Guardrail" button; null for the client's default. */
    guardrailSkill: z._default(z.nullable(ZodSkillName), null),
    /** The settings of the poller's sessions; null without the `swf` section. */
    swf: z._default(z.nullable(SwfSettings.createParser()), null),
    /** In the order of the file. */
    services: z._default(z.array(ServiceConfig.createParser()).check(z.maxLength(MAX_SERVICES, SERVICES_RULE)), () => []),
    /** In the order of the file. */
    checks: z._default(z.array(CheckConfig.createParser()).check(z.maxLength(MAX_CHECKS, CHECKS_RULE)), () => []),
  })
  .check(
    z.refine((state) => new Set(state.services.map((service) => service.port)).size === state.services.length, "every service has a port of its own"),
    z.refine((state) => declaresReferencedServices(state.services), "every ${services.<name>.publicUrl} names a service of hunt.json"),
  );

/** A service of the document as far as the walk could read it; it becomes a ServiceConfig when the document has no problem. */
interface ServiceDraft extends Partial<z.input<typeof ServiceConfig.schema>> {
  name: string;
  port: number;
  remoteSecrets: Record<string, string>;
}

type CheckDraft = Partial<z.input<typeof CheckConfig.schema>>;

/** The `swf` section as far as the walk could read it; `skills` names every agent step when the document has no problem. */
type SwfDraft = Omit<z.input<typeof SwfSettings.schema>, "skills"> & { skills: Partial<Record<AgentStep, string>> | undefined };

/** The document as far as the walk could read it; it becomes a HuntJson when the document has no problem. */
type HuntJsonDraft = Omit<z.input<typeof ZodHuntJsonState>, "services" | "swf"> & { services: ServiceDraft[]; swf: SwfDraft | undefined };

export interface HuntJson extends z.infer<typeof ZodHuntJsonState> {}

/** A repository's hunt.json; see the module comment. */
export class HuntJson extends ValueObject<typeof ZodHuntJsonState> {
  static readonly schema = ZodHuntJsonState;

  constructor(value: z.input<typeof ZodHuntJsonState>) {
    super(value);
  }

  /** The hunt.json of a repository without one: no services, no checks, no swf settings and the defaults of the other fields. */
  static none(): HuntJson {
    return new HuntJson({});
  }

  /**
   * The hunt.json of `document` (the parsed file, undefined without one), or every problem of it. With
   * `remoteSecretNames`, the remote secrets the gateway put on the VM, each remote secret a service names must be one of
   * them; the problems of those that are not come last.
   */
  static fromDocument(
    document: unknown,
    remoteSecretNames?: ReadonlySet<string>,
  ): { huntJson: HuntJson; problems?: undefined } | { huntJson?: undefined; problems: string[] } {
    if (document === undefined) return { huntJson: HuntJson.none() };
    const problems = new Problems();
    const draft = parseRoot(document, problems);
    if (draft && remoteSecretNames) {
      reportMissingRemoteSecrets(draft.services, remoteSecretNames, problems);
    }
    if (!draft || problems.messages.length > 0) return { problems: problems.messages };
    return { huntJson: new HuntJson(draft) };
  }

  /** The check `name`; throws a ConfigError when hunt.json declares no such check. */
  findCheck(name: string): CheckConfig {
    const check = this.checks.find((candidate) => candidate.name === name);
    if (!check) throw new ConfigError([`${at("checks", name)}: no such check`]);
    return check;
  }
}

function declaresReferencedServices(services: readonly ServiceConfig[]): boolean {
  const names = new Set(services.map((service) => service.name));
  return services.every((service) => service.referencedServices.every((name) => names.has(name)));
}

/** The root of `document`; undefined when it is no object. */
function parseRoot(document: unknown, problems: Problems): HuntJsonDraft | undefined {
  const root = record(document, "hunt.json", null, problems);
  if (!root) return undefined;
  for (const key of Object.keys(root)) {
    if (ROOT_FIELDS.includes(key)) continue;
    problems.add(at("", key), key === "preview" ? CONTRACT_2_PROBLEM : "unknown field");
  }
  return {
    version: parseField(ZodContractVersion, root.version, "version", problems),
    adrDir: parseOptionalField(ZodWorktreeFolder, root.adrDir, "adrDir", problems),
    guardrailSkill: parseOptionalField(ZodSkillName, root.guardrailSkill, "guardrailSkill", problems),
    swf: parseSwf(root.swf, problems),
    services: parseServices(root.services, problems),
    checks: parseChecks(root.checks, problems),
  };
}

/** The optional `swf` section, whose `skills` is required; undefined without the section. */
function parseSwf(value: unknown, problems: Problems): SwfDraft | undefined {
  if (value === undefined) return undefined;
  const fields = record(value, "swf", SWF_FIELDS, problems);
  if (!fields) return undefined;
  return {
    model: parseOptionalField(ZodModelId, fields.model, at("swf", "model"), problems),
    humanReviewPaths: parseOptionalField(ZodGlobPatterns, fields.humanReviewPaths, at("swf", "humanReviewPaths"), problems),
    skills: parseStepSkills(fields.skills, at("swf", "skills"), problems),
  };
}

/**
 * The map of every agent step to the repository's skill at `path` (`swf.skills`): the steps whose name is usable. A
 * missing map and each step the map leaves out are problems; undefined when the map is missing or no object.
 */
function parseStepSkills(value: unknown, path: string, problems: Problems): Partial<Record<AgentStep, string>> | undefined {
  if (value === undefined) return problems.add(path, SKILLS_RULE);
  const fields = record(value, path, AGENT_STEPS, problems);
  if (!fields) return undefined;
  const skills: Partial<Record<AgentStep, string>> = {};
  for (const step of AGENT_STEPS) {
    const skill = fields[step] === undefined ? problems.add(at(path, step), STEP_SKILL_RULE) : parseField(ZodSkillName, fields[step], at(path, step), problems);
    if (!skill) continue;
    skills[step] = skill;
  }
  return skills;
}

/** The optional `services` section in the order of the file: the services whose name, object and port are usable. */
function parseServices(value: unknown, problems: Problems): ServiceDraft[] {
  if (value === undefined) return [];
  const declared = record(value, "services", null, problems);
  if (!declared) return [];
  const entries = Object.entries(declared);
  if (entries.length === 0 || entries.length > MAX_SERVICES) {
    problems.add("services", SERVICES_RULE);
  }
  const names = new Set(entries.map(([name]) => name).filter((name) => ZodServiceName.safeParse(name).success));
  const portOwners = new Map<number, string>();
  const services: ServiceDraft[] = [];
  for (const [name, entry] of entries) {
    const service = parseService(name, entry, names, problems);
    if (!service) continue;
    const owner = portOwners.get(service.port);
    if (owner) {
      problems.add(at(at("services", name), "port"), `${service.port} is the port of the service ${owner} already`);
    } else {
      portOwners.set(service.port, name);
    }
    services.push(service);
  }
  return services;
}

/** The service `name`, whose placeholders may name the services in `names`; undefined when its name, object or port is unusable. */
function parseService(name: string, value: unknown, names: ReadonlySet<string>, problems: Problems): ServiceDraft | undefined {
  const path = at("services", name);
  if (!parseField(ZodServiceName, name, path, problems)) return undefined;
  const fields = record(value, path, SERVICE_FIELDS, problems);
  if (!fields) return undefined;
  const command = parseField(ZodCommandLine, fields.command, at(path, "command"), problems);
  const cwd = parseOptionalField(ZodWorktreeFolder, fields.cwd, at(path, "cwd"), problems);
  const port = parseField(ZodServicePort, fields.port, at(path, "port"), problems);
  const tls = parseOptionalField(ZodFlag, fields.tls, at(path, "tls"), problems);
  const guarded = parseOptionalField(ZodFlag, fields.guarded, at(path, "guarded"), problems);
  const review = parseOptionalField(ZodFlag, fields.review, at(path, "review"), problems);
  const env = parseEnvironment(fields.env, at(path, "env"), names, problems);
  const remoteSecrets = parseRemoteSecrets(fields.remoteSecrets, at(path, "remoteSecrets"), env, problems);
  const worktreeInclude = parseOptionalField(ZodGlobPatterns, fields.worktreeInclude, at(path, "worktreeInclude"), problems);
  if (!port) return undefined;
  return { name, command, cwd, port, tls, guarded, review, env, remoteSecrets, worktreeInclude };
}

/**
 * The variables at `path` that are single lines. Reports every `${HUNT_…}` of contract 2 in a value and every
 * `${services.…}` that is no `publicUrl` of a service in `names`, in the order of the value.
 */
function parseEnvironment(value: unknown, path: string, names: ReadonlySet<string>, problems: Problems): Record<string, string> {
  const env: Record<string, string> = {};
  if (value === undefined) return env;
  for (const [key, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const entryPath = at(path, key);
    if (!parseField(ZodEnvVariableName, key, entryPath, problems)) continue;
    const line = parseField(ZodEnvValue, entry, entryPath, problems);
    if (line === undefined) continue;
    parseField(ZodNoContract2Placeholders, line, entryPath, problems);
    for (const [placeholder] of line.matchAll(SERVICE_PLACEHOLDER)) {
      const service = parseField(ZodServicePlaceholder, placeholder, entryPath, problems);
      if (!service || names.has(service)) continue;
      problems.add(entryPath, `${placeholder}: hunt.json declares no service ${service}`);
    }
    env[key] = line;
  }
  return env;
}

/** The remote secrets at `path` by variable, without the `$`; a variable may not appear in `env` as well. */
function parseRemoteSecrets(value: unknown, path: string, env: Readonly<Record<string, string>>, problems: Problems): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (value === undefined) return secrets;
  for (const [key, entry] of Object.entries(record(value, path, null, problems) ?? {})) {
    const entryPath = at(path, key);
    if (!parseField(ZodEnvVariableName, key, entryPath, problems)) continue;
    if (Object.hasOwn(env, key)) {
      problems.add(entryPath, "is set in env already");
      continue;
    }
    const name = parseField(ZodRemoteSecretReference, entry, entryPath, problems);
    if (!name) continue;
    secrets[key] = name;
  }
  return secrets;
}

/** Reports each remote secret a service names that is none of `remoteSecretNames`. */
function reportMissingRemoteSecrets(services: readonly ServiceDraft[], remoteSecretNames: ReadonlySet<string>, problems: Problems): void {
  for (const service of services) {
    for (const [key, name] of Object.entries(service.remoteSecrets)) {
      if (remoteSecretNames.has(name)) continue;
      problems.add(at(at(at("services", service.name), "remoteSecrets"), key), `no remote secret ${name}; set it in Hunt under Settings → Remote VM`);
    }
  }
}

/** The optional `checks` section in the order of the file: the checks whose name and object are usable. */
function parseChecks(value: unknown, problems: Problems): CheckDraft[] {
  if (value === undefined) return [];
  const entries = Object.entries(record(value, "checks", null, problems) ?? {});
  if (entries.length > MAX_CHECKS) {
    problems.add("checks", CHECKS_RULE);
  }
  const checks: CheckDraft[] = [];
  for (const [name, entry] of entries) {
    const path = at("checks", name);
    if (!parseField(ZodServiceName, name, path, problems)) continue;
    const fields = record(entry, path, CHECK_FIELDS, problems);
    if (!fields) continue;
    const command = parseField(ZodCommandLine, fields.command, at(path, "command"), problems);
    checks.push({ name, command, cwd: parseOptionalField(ZodWorktreeFolder, fields.cwd, at(path, "cwd"), problems) });
  }
  return checks;
}
