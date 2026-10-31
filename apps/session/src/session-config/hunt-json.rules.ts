/**
 * The scalar rules of a repository's hunt.json (`hunt-json.value-object.ts` describes the contract) as zod schemas.
 * Each reports exactly the problems of hunt.json's contract for the value it checks, in the order the document walk
 * reports them: one predicate refine with its message per rule, `abort` where a failed rule makes the rest moot. The
 * value objects of the slice build their state schemas from the same rules.
 */
import * as z from "zod/mini";
import { REMOTE_SECRET_NAME } from "../../../../libs/domain/src/remote-secrets/remote-secret.value-object.ts";
import { ZodSingleLine } from "../../../../libs/domain/src/shared/text.rules.ts";

/** Ports no service may use, with what holds them on the session VM; hunt-ctl's RESERVED_PORTS lists the same. */
export const RESERVED_PORTS: ReadonlyMap<number, string> = new Map([
  [2019, "Caddy's admin API"],
  [2375, "the Docker API"],
  [2376, "the Docker API over TLS"],
  [5355, "LLMNR of systemd-resolved"],
  [8080, "the session VM's preview proxy"],
  [9222, "the remote debugging port of the desktop's Chromium"],
  [9230, "the desktop's Waymote gateway"],
  [9231, "the desktop's proxy for the desktop client"],
  [9232, "the review server of the preview proxy"],
  [20201, "the Google Ops Agent's OpenTelemetry collector"],
  [20202, "the Google Ops Agent's Fluent Bit"],
]);

/** The rule every entry of a list of glob patterns (`worktreeInclude`, `swf.humanReviewPaths`) must follow. */
export const GLOB_PATTERN_RULE = "must be a glob pattern relative to the worktree: one line of at most 255 characters, not absolute, without a .. segment";
/** Any `${services.…}` placeholder of an `env` value. */
export const SERVICE_PLACEHOLDER = /\$\{services\.[^}]*\}/g;
/** A valid `${services.<name>.publicUrl}`, with the name as capture group 1. */
export const PUBLIC_URL_PLACEHOLDER = /\$\{services\.([^.}]+)\.publicUrl\}/g;

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SERVICE_NAME_RULE = `invalid name, must match ${SERVICE_NAME.source}`;
const NON_EMPTY_STRING_RULE = "must be a non-empty string";
const SINGLE_LINE_RULE = "must be a single line";
const MAX_COMMAND_LENGTH = 4096;
const MAX_WORKTREE_PATH_LENGTH = 255;
const WORKTREE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WORKTREE_PATH_SEGMENTS_RULE = `at most ${MAX_WORKTREE_PATH_LENGTH} characters, segments of letters, digits, ".", "_" and "-", none . or ..`;
const FOLDER_RULE = `must be a folder relative to the worktree such as "apps/web": ${WORKTREE_PATH_SEGMENTS_RULE}`;
const FILE_RULE = `must be a file relative to the worktree such as ".claude/declined-guardrails.jsonl": ${WORKTREE_PATH_SEGMENTS_RULE}`;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const PORT_RULE = `must be an integer from ${MIN_PORT} to ${MAX_PORT}`;
const ENV_VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = ["CLAUDE_", "HUNT_"];
const CONTRACT_2_PLACEHOLDER = /\$\{HUNT_[A-Za-z0-9_]*\}/g;
/** A `${services.<name>.publicUrl}` and nothing else, with the name as capture group 1. */
const SERVICE_PLACEHOLDER_FORM = /^\$\{services\.([^.}]+)\.publicUrl\}$/;
/** A `remoteSecrets` value, with the name of the remote secret as capture group 1. */
const REMOTE_SECRET_REFERENCE = new RegExp(`^\\$(${REMOTE_SECRET_NAME.source.slice(1, -1)})$`);
const REMOTE_SECRET_REFERENCE_RULE = `must be "$<NAME>", the name of a remote secret matching ${REMOTE_SECRET_NAME.source}`;
const MAX_GLOB_PATTERNS = 64;
const MAX_GLOB_PATTERN_LENGTH = 255;
const GLOB_PATTERN_LIST_RULE = `must be a list of at most ${MAX_GLOB_PATTERNS} glob patterns`;
const MAX_MODEL_LENGTH = 128;
/** The full ID of a Claude model, with an optional context hint: `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-5-5[1m]`. */
const MODEL_ID = /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\[\d+m\])?$/;
const MODEL_RULE = `must be the full ID of a Claude model such as "claude-opus-5-5", at most ${MAX_MODEL_LENGTH} characters, not an alias such as "opus"`;
const MAX_SKILL_NAME_LENGTH = 64;
/** A skill name as Claude Code accepts it (`is_skill_name` in `apps/client/src-tauri/src/agent/guardrail_skill.rs`). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_RULE = `must be the kebab-case name of a skill such as "guardrail": letters, digits and "-", at most ${MAX_SKILL_NAME_LENGTH} characters`;

/** `version`: the contract version, 3. */
export const ZodContractVersion = z.literal(3, { error: "must be 3" });

/** The name of a service or a check. */
export const ZodServiceName = z.string({ error: SERVICE_NAME_RULE }).check(z.regex(SERVICE_NAME, SERVICE_NAME_RULE));

/** `command`: one non-empty line of at most 4096 characters; a line break and the length are both reported. */
export const ZodCommandLine = z.string({ error: NON_EMPTY_STRING_RULE }).check(
  z.refine((command) => command.trim() !== "", { error: NON_EMPTY_STRING_RULE, abort: true }),
  ZodSingleLine(SINGLE_LINE_RULE),
  z.refine((command) => command.length <= MAX_COMMAND_LENGTH, `must be at most ${MAX_COMMAND_LENGTH} characters long`),
);

/** `cwd` and `adrDir`: a folder relative to the worktree, whose segments are none `.` or `..`. */
export const ZodWorktreeFolder = z.string({ error: FOLDER_RULE }).check(z.refine(isWorktreePath, FOLDER_RULE));

/** `declinedGuardrailsFile`: a file relative to the worktree, whose segments are none `.` or `..`. */
export const ZodWorktreeFile = z.string({ error: FILE_RULE }).check(z.refine(isWorktreePath, FILE_RULE));

/** `port`: an integer from 1024 to 65535 that is not reserved (RESERVED_PORTS). */
export const ZodServicePort = z.number({ error: PORT_RULE }).check(
  z.refine((port) => Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT, { error: PORT_RULE, abort: true }),
  z.refine((port) => !RESERVED_PORTS.has(port), { error: (issue) => `${issue.input} is reserved for ${RESERVED_PORTS.get(Number(issue.input))}` }),
);

/** `tls`, `guarded` and `review`. */
export const ZodFlag = z.boolean({ error: "must be true or false" });

/** A key of `env` or `remoteSecrets`: the name of a variable that Hunt's own variables leave free. */
export const ZodEnvVariableName = z.string().check(
  z.regex(ENV_VARIABLE_NAME, { error: `invalid name, must match ${ENV_VARIABLE_NAME.source}`, abort: true }),
  z.refine((name) => !RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)), "reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt"),
);

/** A value of `env`: one line. */
export const ZodEnvValue = z.string({ error: "must be a string" }).check(ZodSingleLine(SINGLE_LINE_RULE));

/** An `env` value without the `${HUNT_…}` placeholders of contract 2; one issue for each it holds. */
export const ZodNoContract2Placeholders = z.string().check(
  z.superRefine((value, context) => {
    for (const [placeholder] of value.matchAll(CONTRACT_2_PLACEHOLDER)) {
      context.addIssue({ code: "custom", input: value, message: `${placeholder} is a placeholder of contract 2, use \${services.<name>.publicUrl}` });
    }
  }),
);

/** A `${services.…}` placeholder of an `env` value in the form `${services.<name>.publicUrl}`; parses to the name. */
export const ZodServicePlaceholder = z.pipe(
  z.string().check(
    z.refine((placeholder) => SERVICE_PLACEHOLDER_FORM.test(placeholder), {
      error: (issue) => `unknown placeholder ${issue.input}, the form is \${services.<name>.publicUrl}`,
    }),
  ),
  z.transform((placeholder) => placeholder.replace(SERVICE_PLACEHOLDER_FORM, "$1")),
);

/** A value of `remoteSecrets`: `$<NAME>`, the name of a remote secret; parses to the name without the `$`. */
export const ZodRemoteSecretReference = z.pipe(
  z.string({ error: REMOTE_SECRET_REFERENCE_RULE }).check(z.regex(REMOTE_SECRET_REFERENCE, REMOTE_SECRET_REFERENCE_RULE)),
  z.transform((reference) => reference.slice(1)),
);

/** An entry of `worktreeInclude` or `swf.humanReviewPaths` (GLOB_PATTERN_RULE). */
export const ZodGlobPattern = z.string({ error: GLOB_PATTERN_RULE }).check(
  z.refine(
    (pattern) =>
      pattern.trim() !== "" &&
      !/[\r\n]/.test(pattern) &&
      pattern.length <= MAX_GLOB_PATTERN_LENGTH &&
      !pattern.startsWith("/") &&
      !pattern.split("/").includes(".."),
    GLOB_PATTERN_RULE,
  ),
);

/** `worktreeInclude` and `swf.humanReviewPaths`: at most 64 glob patterns, each entry that breaks ZodGlobPattern reported at its index. */
export const ZodGlobPatterns = z.pipe(
  z.array(z.unknown(), { error: GLOB_PATTERN_LIST_RULE }).check(z.maxLength(MAX_GLOB_PATTERNS, GLOB_PATTERN_LIST_RULE)),
  z.array(ZodGlobPattern),
);

/** `swf.model`: the full ID of a Claude model, never an alias. */
export const ZodModelId = z.string({ error: MODEL_RULE }).check(z.refine((model) => model.length <= MAX_MODEL_LENGTH && MODEL_ID.test(model), MODEL_RULE));

/** `guardrailSkill` and the values of `swf.skills`: the name of a Claude Code skill. */
export const ZodSkillName = z.string({ error: SKILL_NAME_RULE }).check(
  z.refine((skill) => skill.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME.test(skill), SKILL_NAME_RULE),
);

/** Whether `path` stays inside the worktree: relative, at most 255 characters, no segment `.` or `..`. */
function isWorktreePath(path: string): boolean {
  return path.length <= MAX_WORKTREE_PATH_LENGTH && WORKTREE_PATH.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..");
}
