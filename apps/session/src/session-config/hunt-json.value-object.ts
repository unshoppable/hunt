/**
 * A repository's `hunt.json` in contract version 3: the services of the repository, which Hunt runs on a session's VM
 * as systemd units that the agent starts when its task needs them, each with the ignored files it needs in a worktree,
 * the checks a person runs from the client's Checks tab, the settings of the sessions the gateway's poller starts
 * for the repository's `swf` issues, the folder of its architectural decision records and the file of its declined
 * guardrail suggestions.
 *
 *   {
 *     "version": 3,
 *     "adrDir": "docs/adr",
 *     "declinedGuardrailsFile": "docs/declined-guardrails.jsonl",
 *     "swf": {
 *       "model": "claude-opus-5-5", "effort": "high", "maxGateRuns": 5, "humanReviewPaths": ["apps/backend/migrations/**"],
 *       "steps": {
 *         "plan": { "skill": "swf-plan" },
 *         "implement": { "skill": "swf-implement", "model": "claude-sonnet-5-5", "effort": "medium", "checks": ["format", "test"] },
 *         "verify": { "skill": "swf-verify", "maxReturns": 5 },
 *         "review": { "skill": "swf-review", "effort": "max" },
 *         "pr": { "skill": "swf-pr" },
 *         "pr-gate": { "maxReturns": 3 }
 *       }
 *     },
 *     "services": {
 *       "backend": {
 *         "command": "npm run start:backend", "port": 3000, "tls": true, "guarded": false,
 *         "env": { "UI_BASE_URL": "${services.ui.publicUrl}" },
 *         "remoteSecrets": { "OPENAI_API_KEY": "$MED_OPENAI_API_KEY" },
 *         "worktreeInclude": ["apps/backend/.env.private"]
 *       },
 *       "ui": { "command": "npm start", "cwd": "apps/ui", "port": 4200, "frontend": true, "env": { "BACKEND_ORIGIN": "${services.backend.publicUrl}" } },
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
 * - `frontend`: false by default: whether the service shows pages in a browser, such as a dev server. "Browser" of a
 *   local session in Hunt opens a tab at `http://localhost:<port>` (`https://` with `tls`) for each such service that runs.
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
 * - `swf`: optional, the settings of the poller's sessions, with the fields `model`, `effort`, `maxGateRuns`,
 *   `questionPrefix`, `projectStatus`, `mergeMethod`, `humanReviewPaths`, `steps` and `skills`; a repository without it
 *   takes no part in the poller's workflow, and none of its rules applies. `swf-settings.value-object.ts` resolves the
 *   defaults:
 *   - `model`: the model of every agent step that sets none: the full ID of a Claude model such as `claude-opus-5-5`
 *     (ZodModelId), at most 128 characters, never an alias such as `opus`, whose model changes with Claude Code's
 *     releases. The poller sets it as the session's `model` config option; without it, or when the agent knows no such
 *     model (the relay logs that), Claude Code's default model applies. Sessions started from Hunt keep the model their
 *     user picks.
 *   - `effort`: the effort of every agent step that sets none, one of EFFORTS (`low` to `max`), set as the `effort`
 *     config option; Claude Code's default without it.
 *   - `maxGateRuns`: how often a step's result may fail its gate before the agent escalates, an integer of at least 1;
 *     DEFAULT_MAX_GATE_RUNS without it.
 *   - `questionPrefix`: what the agent puts in front of the issue's title while it waits for an answer to a question
 *     (`<prefix>: <title>`) and in bold at the start of the question's comment: one line of at most 40 characters that
 *     does not end with a colon; DEFAULT_QUESTION_PREFIX (`❓ RÜCKFRAGE`) without it.
 *   - `projectStatus`: the names of the Status options the poller sets on the issue in every GitHub Project (v2) it is
 *     an item of, each one line of at most 60 characters, matched regardless of case: `inProgress` once the issue is
 *     claimed, `inReview` once its pull request waits for its review, `done` once it is merged. All three or none;
 *     DEFAULT_PROJECT_STATUS (`In Progress`, `In Review`, `Done`) without it.
 *   - `mergeMethod`: how the poller merges the pull request, `squash`, `merge` or `rebase` (MERGE_METHODS);
 *     DEFAULT_MERGE_METHOD (`squash`) without it.
 *   - `humanReviewPaths`: glob patterns that follow the rules of `worktreeInclude`: the files whose change makes a pull
 *     request of a poller session need a human reviewer. Hunt does not read them; the repository's review workflow
 *     does, from hunt.json. None by default; the VM only validates the list.
 *   - `steps`: the settings of each step (SWF_STEPS), each optional: an agent step (`plan`, `implement`, `verify`,
 *     `review`, `pr`) takes `skill`, `model`, `effort` and `checks`, a step that sends the pipeline back (`verify`,
 *     `review`, `pr-gate`, `merge`; RETURNING_STEPS) `maxReturns`, a step whose findings carry a severity
 *     (`verify`, `review`; SCORING_STEPS) `minSeverity`; any other field of a step is a problem. Older files may name
 *     a retired step (RETIRED_STEPS): `human-review`, pr-gate's former name (RENAMED_STEPS), sets pr-gate, and both
 *     together are a problem; the entry of `checks` is ignored, whatever it holds.
 *     - `skill`: the Claude Code skill (`.claude/skills/<name>/SKILL.md`, a name like `guardrailSkill`) with which the
 *       repository refines the step: its prompt tells the agent to invoke the skill first. Every agent step must have
 *       one, here or in `skills`; Hunt has no default, so a step without one is a problem, which the client's dialog on
 *       opening a session of the repository offers to fix (entries `swf-<step>` and the skill files from its
 *       templates). The worktree must hold the skill file of every step, which `session-config.service.ts` checks.
 *     - `model`, `effort`: the step's own, which follow the rules of the section's and win over them.
 *     - `maxReturns`: how often the step may send the pipeline back to implement before the agent escalates, an
 *       integer from 1 to 20; DEFAULT_MAX_RETURNS without it.
 *     - `minSeverity`: the severity (1 to 5, the scale of the step's prompt) from which a finding of the step sends the
 *       pipeline back to implement; a finding below it stays in the step result as a suggestion. DEFAULT_MIN_SEVERITY
 *       (3) without it.
 *     - `checks`: the step's gate, the checks of hunt.json's `checks` that must pass before the step's result is
 *       accepted: `"*"` for every check, or a list of at most 32 names of checks (`[]` for none), run in the order of
 *       `checks`. Without it, every check for the steps of GATED_BY_DEFAULT (`implement`) and none for the others.
 *   - `skills`: the alias of `steps.<step>.skill`, keyed by agent step (AGENT_STEPS), as older files write the skills.
 *     A step may name its skill in both places only when they agree. Without `steps` and `skills` the section names
 *     no skill, which is one problem.
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
 * - `declinedGuardrailsFile`: optional, the file the client appends a guardrail suggestion to when the user declines
 *   it and that the guardrail skill greps; it follows the rules of a service's `cwd` and is
 *   `.claude/declined-guardrails.jsonl` without it. The VM only validates it.
 *
 * `<short>` is the first 8 hex digits of the session ID. `session-config.main.ts` writes the session's environment, one
 * environment file per service and the configuration of the VM's preview proxy.
 *
 * `HuntJson` is the file as the aggregate of its ServiceConfig, CheckConfig and SwfSettings. `fromDocument` walks a
 * parsed document by hand and reports every problem, each starting with the path of the offending value: the unknown
 * fields of an object before its fields, the fields in the order above, each scalar checked against its rule in
 * `hunt-json.rules.ts` (`problems.utils.ts` holds the walk's plumbing). zod's own objects would report unknown fields
 * last and skip the rules across fields after a type error. The three rules across sections, a port of each service's
 * own, a declared service for each `${services.<name>.publicUrl}` and a declared check for each name of a gate, the
 * walk reports where it meets them and the aggregate's schema checks as well.
 */
import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { isReturningStep, isScoringStep, type ProjectStatus, type StepSettings } from "../../../../libs/domain/src/swf/step-settings.value-object.ts";
import { AGENT_STEPS, isAgentStep, RENAMED_STEPS, RETIRED_STEPS, SWF_STEPS, type AgentStep, type SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { CheckConfig } from "./check-config.value-object.ts";
import { ConfigError } from "./config.error.ts";
import {
  SERVICE_PLACEHOLDER,
  ZodCommandLine,
  ZodContractVersion,
  ZodEffort,
  ZodEnvValue,
  ZodEnvVariableName,
  ZodFlag,
  ZodStepChecks,
  ZodGlobPatterns,
  ZodMaxGateRuns,
  ZodMaxReturns,
  ZodMergeMethod,
  ZodMinSeverity,
  ZodModelId,
  ZodNoContract2Placeholders,
  ZodProjectStatusName,
  ZodQuestionPrefix,
  ZodRemoteSecretReference,
  ZodServiceName,
  ZodServicePlaceholder,
  ZodServicePort,
  ZodSkillName,
  ZodWorktreeFile,
  ZodWorktreeFolder,
} from "./hunt-json.rules.ts";
import { at, parseField, parseOptionalField, Problems, record } from "./problems.utils.ts";
import { ServiceConfig } from "./service-config.value-object.ts";
import { SwfSettings } from "./swf-settings.value-object.ts";

const ROOT_FIELDS = ["version", "adrDir", "guardrailSkill", "declinedGuardrailsFile", "swf", "services", "checks"];
const SWF_FIELDS = ["model", "effort", "maxGateRuns", "questionPrefix", "projectStatus", "mergeMethod", "humanReviewPaths", "steps", "skills"];
const PROJECT_STATUS_FIELDS = ["inProgress", "inReview", "done"];
const STEP_FIELDS = ["skill", "model", "effort", "maxReturns", "minSeverity", "checks"];
const SERVICE_FIELDS = ["command", "cwd", "port", "tls", "guarded", "review", "frontend", "env", "remoteSecrets", "worktreeInclude"];
const CHECK_FIELDS = ["command", "cwd"];
const MAX_SERVICES = 64;
const SERVICES_RULE = `must hold 1 to ${MAX_SERVICES} services`;
const MAX_CHECKS = 32;
const CHECKS_RULE = `must hold at most ${MAX_CHECKS} checks`;
const CONTRACT_2_PROBLEM = 'the preview section of contract 2 is no longer read; hunt.json holds {"version": 3, "services": {…}} at its root';
/** Hunt has no default skill: the client's dialog on opening a session of the repository adds the missing entries. */
const SKILLS_RULE = `must name the skill of every agent step (${AGENT_STEPS.join(", ")}); Hunt asks to add them when a session of the repository opens`;
const STEP_SKILL_RULE = "must name the skill of the step; Hunt asks to add it when a session of the repository opens";
const MAX_RETURNS_STEP_RULE = "only a step that sends the pipeline back has maxReturns (verify, review, pr-gate, merge)";
const MIN_SEVERITY_STEP_RULE = "only a step whose findings carry a severity has minSeverity (verify, review)";

const ZodHuntJsonState = z
  .object({
    /** Always 3; the walk requires the field, the state fills it in. */
    version: z._default(ZodContractVersion, 3),
    /** The folder of the architectural decision records relative to the worktree; null for the client's default. */
    adrDir: z._default(z.nullable(ZodWorktreeFolder), null),
    /** The skill of the client's "Guardrail" button; null for the client's default. */
    guardrailSkill: z._default(z.nullable(ZodSkillName), null),
    /** The file of the declined guardrail suggestions relative to the worktree; null for the client's default. */
    declinedGuardrailsFile: z._default(z.nullable(ZodWorktreeFile), null),
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
    z.refine((state) => declaresGateChecks(state.swf, state.checks), "every gate names a check of hunt.json"),
  );

/** A service of the document as far as the walk could read it; it becomes a ServiceConfig when the document has no problem. */
interface ServiceDraft extends Partial<z.input<typeof ServiceConfig.schema>> {
  name: string;
  port: number;
  remoteSecrets: Record<string, string>;
}

type CheckDraft = Partial<z.input<typeof CheckConfig.schema>>;

/** The `swf` section as far as the walk could read it, `swf.skills` merged into the agent steps. */
type SwfDraft = z.input<typeof SwfSettings.schema>;
type StepDraft = NonNullable<SwfDraft["steps"][SwfStep]>;

/** The document as far as the walk could read it; it becomes a HuntJson when the document has no problem. */
type HuntJsonDraft = Omit<z.input<typeof ZodHuntJsonState>, "services"> & { services: ServiceDraft[] };

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

  /** The settings of every step of the swf pipeline with the defaults applied; null without the `swf` section. */
  get stepSettings(): StepSettings | null {
    return this.swf?.resolve(this.checks.map((check) => check.name)) ?? null;
  }

  /** The check `name`; throws a ConfigError when hunt.json declares no such check. */
  findCheck(name: string): CheckConfig {
    const check = this.checks.find((candidate) => candidate.name === name);
    if (!check) throw new ConfigError([`${at("checks", name)}: no such check`]);
    return check;
  }
}

function declaresGateChecks(swf: SwfSettings | null, checks: readonly CheckConfig[]): boolean {
  return (swf?.gateChecks ?? []).every((name) => checks.some((check) => check.name === name));
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
    declinedGuardrailsFile: parseOptionalField(ZodWorktreeFile, root.declinedGuardrailsFile, "declinedGuardrailsFile", problems),
    swf: parseSwf(root.swf, declaredNames(root.checks), problems),
    services: parseServices(root.services, problems),
    checks: parseChecks(root.checks, problems),
  };
}

/** The names of the entries of the object `value` that follow ZodServiceName, for the references the walk meets before the entries. */
function declaredNames(value: unknown): ReadonlySet<string> {
  return new Set(Object.keys(isRecord(value) ? value : {}).filter((name) => ZodServiceName.safeParse(name).success));
}

/** The optional `swf` section, whose gates may name the checks `checkNames`; undefined without the section. */
function parseSwf(value: unknown, checkNames: ReadonlySet<string>, problems: Problems): SwfDraft | undefined {
  if (value === undefined) return undefined;
  const fields = record(value, "swf", SWF_FIELDS, problems);
  if (!fields) return undefined;
  const model = parseOptionalField(ZodModelId, fields.model, at("swf", "model"), problems);
  const effort = parseOptionalField(ZodEffort, fields.effort, at("swf", "effort"), problems);
  const maxGateRuns = parseOptionalField(ZodMaxGateRuns, fields.maxGateRuns, at("swf", "maxGateRuns"), problems);
  const questionPrefix = parseOptionalField(ZodQuestionPrefix, fields.questionPrefix, at("swf", "questionPrefix"), problems);
  const projectStatus = parseProjectStatus(fields.projectStatus, problems);
  const mergeMethod = parseOptionalField(ZodMergeMethod, fields.mergeMethod, at("swf", "mergeMethod"), problems);
  // Validated only: the repository's review workflow reads the paths, Hunt does not.
  parseOptionalField(ZodGlobPatterns, fields.humanReviewPaths, at("swf", "humanReviewPaths"), problems);
  const steps = parseSteps(fields.steps, checkNames, problems);
  const aliases = parseSkillAliases(fields.skills, problems);
  if (fields.steps === undefined && fields.skills === undefined) {
    problems.add(at("swf", "steps"), SKILLS_RULE);
  } else {
    mergeSkills(fields, steps, aliases, problems);
  }
  return { model, effort, maxGateRuns, questionPrefix, projectStatus, mergeMethod, steps };
}

/**
 * The optional `swf.projectStatus`: the names of the Status options of the issue's GitHub Projects, `inProgress`,
 * `inReview` and `done`, every one of them given; undefined without the field or when it is no object or incomplete.
 */
function parseProjectStatus(value: unknown, problems: Problems): ProjectStatus | undefined {
  if (value === undefined) return undefined;
  const path = at("swf", "projectStatus");
  const fields = record(value, path, PROJECT_STATUS_FIELDS, problems);
  if (!fields) return undefined;
  const inProgress = parseField(ZodProjectStatusName, fields.inProgress, at(path, "inProgress"), problems);
  const inReview = parseField(ZodProjectStatusName, fields.inReview, at(path, "inReview"), problems);
  const done = parseField(ZodProjectStatusName, fields.done, at(path, "done"), problems);
  if (inProgress === undefined || inReview === undefined || done === undefined) return undefined;
  return { inProgress, inReview, done };
}

/**
 * The steps of `swf.steps` in the order of the steps, as far as they are objects; none when the section is missing or no
 * object. A step may be set under its former name (RENAMED_STEPS), but not under both; the entry of any other retired
 * step is left unread.
 */
function parseSteps(value: unknown, checkNames: ReadonlySet<string>, problems: Problems): Partial<Record<SwfStep, StepDraft>> {
  const steps: Partial<Record<SwfStep, StepDraft>> = {};
  if (value === undefined) return steps;
  const fields = record(value, at("swf", "steps"), [...SWF_STEPS, ...RETIRED_STEPS.keys()], problems);
  if (!fields) return steps;
  for (const step of SWF_STEPS) {
    const former: string | undefined = [...RENAMED_STEPS].find(([name, successor]) => successor === step && fields[name] !== undefined)?.[0];
    if (former !== undefined && fields[step] !== undefined) {
      problems.add(at(at("swf", "steps"), former), `the former name of ${step}, which is set as well`);
      continue;
    }
    const key = former ?? step;
    if (fields[key] === undefined) continue;
    const entry = parseStep(step, key, fields[key], checkNames, problems);
    if (!entry) continue;
    steps[step] = entry;
  }
  return steps;
}

/**
 * The settings of `step` at `swf.steps.<key>`, `key` being the step's name or its former one: `skill`, `model`, `effort`
 * and `checks` belong to an agent step, `maxReturns` to a returning step, `minSeverity` to a scoring step, and each name
 * of the gate must be one of `checkNames`; undefined when the value is no object.
 */
function parseStep(step: SwfStep, key: string, value: unknown, checkNames: ReadonlySet<string>, problems: Problems): StepDraft | undefined {
  const path = at(at("swf", "steps"), key);
  const fields = record(value, path, STEP_FIELDS, problems);
  if (!fields) return undefined;
  const isAgent = isAgentStep(step);
  const field = <TSchema extends z.ZodMiniType>(schema: TSchema, name: string, allowed: boolean, rule: string): z.output<TSchema> | undefined => {
    if (allowed) return parseOptionalField(schema, fields[name], at(path, name), problems);
    if (fields[name] !== undefined) {
      problems.add(at(path, name), rule);
    }
    return undefined;
  };
  const skill = field(ZodSkillName, "skill", isAgent, "only an agent step has a skill");
  const model = field(ZodModelId, "model", isAgent, "only an agent step has a model");
  const effort = field(ZodEffort, "effort", isAgent, "only an agent step has an effort");
  const maxReturns = field(ZodMaxReturns, "maxReturns", isReturningStep(step), MAX_RETURNS_STEP_RULE);
  const minSeverity = field(ZodMinSeverity, "minSeverity", isScoringStep(step), MIN_SEVERITY_STEP_RULE);
  const checks = field(ZodStepChecks, "checks", isAgent, "only an agent step has checks");
  for (const name of Array.isArray(checks) ? checks : []) {
    if (checkNames.has(name)) continue;
    problems.add(at(path, "checks"), `no such check ${name}`);
  }
  return { skill, model, effort, maxReturns, minSeverity, checks };
}

/** The usable skills of `swf.skills`, the alias of `swf.steps.<step>.skill`, by agent step; none when the map is missing or no object. */
function parseSkillAliases(value: unknown, problems: Problems): Partial<Record<AgentStep, string>> {
  const skills: Partial<Record<AgentStep, string>> = {};
  if (value === undefined) return skills;
  const fields = record(value, at("swf", "skills"), AGENT_STEPS, problems);
  if (!fields) return skills;
  for (const step of AGENT_STEPS) {
    const skill = parseOptionalField(ZodSkillName, fields[step], at(at("swf", "skills"), step), problems);
    if (!skill) continue;
    skills[step] = skill;
  }
  return skills;
}

/**
 * Sets the skill of every agent step in `steps` from `steps.<step>.skill` or its alias in `aliases`. Reports a step
 * whose two skills differ, and a step for which `swf` (the section's fields) holds nothing in either place.
 */
function mergeSkills(
  swf: Record<string, unknown>,
  steps: Partial<Record<SwfStep, StepDraft>>,
  aliases: Partial<Record<AgentStep, string>>,
  problems: Problems,
): void {
  for (const step of AGENT_STEPS) {
    const path = at(at(at("swf", "steps"), step), "skill");
    const skill = steps[step]?.skill;
    const alias = aliases[step];
    if (skill && alias && skill !== alias) {
      problems.add(path, `differs from ${at(at("swf", "skills"), step)}`);
    }
    if (holdsNothingAt(swf.steps, [step, "skill"]) && holdsNothingAt(swf.skills, [step])) {
      problems.add(path, STEP_SKILL_RULE);
    }
    steps[step] = { ...steps[step], skill: skill ?? alias };
  }
}

/** Whether `value` holds nothing at the path `keys`: it is undefined, or an object whose value at the first key holds nothing at the rest. */
function holdsNothingAt(value: unknown, keys: readonly string[]): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || keys.length === 0) return false;
  return holdsNothingAt(value[keys[0]], keys.slice(1));
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
  const frontend = parseOptionalField(ZodFlag, fields.frontend, at(path, "frontend"), problems);
  const env = parseEnvironment(fields.env, at(path, "env"), names, problems);
  const remoteSecrets = parseRemoteSecrets(fields.remoteSecrets, at(path, "remoteSecrets"), env, problems);
  const worktreeInclude = parseOptionalField(ZodGlobPatterns, fields.worktreeInclude, at(path, "worktreeInclude"), problems);
  if (!port) return undefined;
  return { name, command, cwd, port, tls, guarded, review, frontend, env, remoteSecrets, worktreeInclude };
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
