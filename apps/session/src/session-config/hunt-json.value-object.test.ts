import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STEPS, SWF_STEPS } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import { ConfigError } from "./config.error.ts";
import { GLOB_PATTERN_RULE } from "./hunt-json.rules.ts";
import { HuntJson } from "./hunt-json.value-object.ts";
import type { CaddyConfig, CaddyRoute } from "./preview-proxy.types.ts";
import { proxyConfig } from "./preview-proxy.utils.ts";
import { ServiceConfig } from "./service-config.value-object.ts";
import { envFile, sessionEnv } from "./service-environment.utils.ts";
import { servicesPrompt } from "./services-prompt.utils.ts";
import { buildSessionConfig } from "./session-config.service.ts";
import { SessionHost } from "./session-host.value-object.ts";
import { SwfSettings } from "./swf-settings.value-object.ts";

const CONFIG_CLI = fileURLToPath(new URL("./session-config.main.ts", import.meta.url));
const HOST = new SessionHost({ short: "7c0c6f2e", domain: "hunt.example.com" });
const WORKTREE = "/home/agent/acme";
const PORT_RULE = "must be an integer from 1024 to 65535";
const NAME_RULE = "invalid name, must match ^[a-z][a-z0-9-]{0,31}$";
const CWD_RULE =
  'must be a folder relative to the worktree such as "apps/web": at most 255 characters, segments of letters, digits, ".", "_" and "-", none . or ..';
const FILE_RULE =
  'must be a file relative to the worktree such as ".claude/declined-guardrails.jsonl": at most 255 characters, segments of letters, digits, ".", "_" and "-", none . or ..';
const CONTRACT_2_PROBLEM = 'preview: the preview section of contract 2 is no longer read; hunt.json holds {"version": 3, "services": {…}} at its root';
const IAP_HEADERS = ["X-Goog-Iap-Jwt-Assertion", "X-Goog-Authenticated-User-Email", "X-Goog-Authenticated-User-Id"];
const REMOTE_SECRET_RULE = 'must be "$<NAME>", the name of a remote secret matching ^[A-Z][A-Z0-9_]{0,63}$';
const MODEL_RULE = 'must be the full ID of a Claude model such as "claude-opus-5-5", at most 128 characters, not an alias such as "opus"';
const SKILL_NAME_RULE = 'must be the kebab-case name of a skill such as "guardrail": letters, digits and "-", at most 64 characters';
const SKILLS_RULE = "must name the skill of every agent step (plan, implement, verify, review, pr); Hunt asks to add them when a session of the repository opens";
const STEP_SKILL_RULE = "must name the skill of the step; Hunt asks to add it when a session of the repository opens";
/** The skill of every agent step as a hunt.json names them under `swf.skills`. */
const SKILLS = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", review: "swf-review", pr: "swf-pr" };
/** The same skills as a hunt.json names them under `swf.steps`. */
const STEPS = Object.fromEntries(AGENT_STEPS.map((step) => [step, { skill: SKILLS[step] }]));
const EFFORT_RULE = "must be one of low, medium, high, xhigh, max";
const MAX_RETURNS_RULE = "must be an integer from 1 to 20";
const MAX_RETURNS_STEP_RULE = "only a step that sends the pipeline back has maxReturns (verify, review, checks, human-review, merge)";
const MIN_SEVERITY_RULE = "must be an integer from 1 to 5";
const MIN_SEVERITY_STEP_RULE = "only a step whose findings carry a severity has minSeverity (verify, review)";
const GATE_RULE = 'must be "*" for every check or a list of at most 32 names of checks';
const QUESTION_PREFIX_RULE = "must be one non-empty line of at most 40 characters that does not end with a colon";
const PROJECT_STATUS_RULE = "must be one non-empty line of at most 60 characters, the name of a Status option of the GitHub Project";
const MERGE_METHOD_RULE = "must be one of squash, merge, rebase";
/** Hunt's workflow settings, which a section without `questionPrefix`, `projectStatus` and `mergeMethod` resolves to. */
const DEFAULT_WORKFLOW = { questionPrefix: "❓ RÜCKFRAGE", projectStatus: { inProgress: "In Progress", inReview: "In Review", done: "Done" }, mergeMethod: "squash" };
/** The `swf` section of app-framework's hunt.json. */
const APP_FRAMEWORK_SWF = {
  model: "claude-opus-5-5",
  humanReviewPaths: [
    "apps/*/backend/src/migrations/**",
    "**/*auth*",
    "apps/med/backend/src/app/api/commerce/**",
    "libs/shared/backend/src/lib/grouper-client/**",
    "libs/med/domain/src/lib/pepp/**",
    ".github/**",
    ".ci/**",
    ".claude/**",
    "**/CLAUDE.md",
    "libs/workspace/eslint-plugin-code-style/**",
    ".dependency-cruiser*",
    "hunt.json",
  ],
  maxGateRuns: 5,
  questionPrefix: "❓ RÜCKFRAGE",
  projectStatus: { inProgress: "In Progress", inReview: "In Review", done: "Done" },
  mergeMethod: "squash",
  steps: {
    plan: { skill: "swf-plan" },
    implement: { skill: "swf-implement", gate: "*" },
    verify: { skill: "swf-verify", maxReturns: 3, minSeverity: 3 },
    review: { skill: "swf-review", maxReturns: 3, minSeverity: 3 },
    pr: { skill: "swf-pr" },
    checks: { maxReturns: 2 },
    "human-review": { maxReturns: 3 },
    merge: { maxReturns: 2 },
  },
};
const MISSING_SECRET = "services.web.remoteSecrets.OPENAI_API_KEY: no remote secret MED_OPENAI_API_KEY; set it in Hunt under Settings → Remote VM";

/** A hunt.json with every field: a forward and a self reference, a folder, TLS and two services that are not guarded. */
const COMPLETE = {
  version: 3,
  services: {
    backend: {
      command: "npm run start:backend",
      port: 3000,
      tls: true,
      guarded: false,
      env: {
        BACKEND_DOMAIN: "${services.backend.publicUrl}",
        UI_BASE_URL: "${services.ui.publicUrl}/app",
        BOTH: "${services.ui.publicUrl};${services.admin.publicUrl}",
        OTHER: "${HOME}",
        PLAIN: "x",
      },
    },
    ui: { command: "npm start -- --port 4200", cwd: "apps/ui", port: 4200, env: { DEV_BACKEND_ORIGIN: "${services.backend.publicUrl}" } },
    docs: { command: "npx serve docs", port: 4400, tls: true },
    admin: { command: 'echo "$PATH" && npm run admin', port: 4800, guarded: false, review: false },
  },
};

const COMPLETE_SERVICES = [
  {
    name: "backend",
    command: "npm run start:backend",
    cwd: null,
    port: 3000,
    tls: true,
    guarded: false,
    review: true,
    env: COMPLETE.services.backend.env,
    remoteSecrets: {},
    worktreeInclude: [],
  },
  { name: "ui", command: "npm start -- --port 4200", cwd: "apps/ui", port: 4200, tls: false, guarded: true, review: true, env: COMPLETE.services.ui.env, remoteSecrets: {}, worktreeInclude: [] },
  { name: "docs", command: "npx serve docs", cwd: null, port: 4400, tls: true, guarded: true, review: true, env: {}, remoteSecrets: {}, worktreeInclude: [] },
  { name: "admin", command: 'echo "$PATH" && npm run admin', cwd: null, port: 4800, tls: false, guarded: false, review: false, env: {}, remoteSecrets: {}, worktreeInclude: [] },
].map((state) => new ServiceConfig(state));

function problemsOf(huntJson: unknown, host: Pick<SessionHost, "short" | "domain"> = HOST, secrets: Record<string, string> = {}): string[] {
  try {
    buildSessionConfig(huntJson, host, WORKTREE, secrets);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

/** The HuntJson of `document`; throws a ConfigError with its problems. */
function huntJsonOf(document: unknown): HuntJson {
  const parsed = HuntJson.fromDocument(document);
  if (parsed.problems) throw new ConfigError(parsed.problems);
  return parsed.huntJson;
}

function withServices(services: Record<string, unknown>): Record<string, unknown> {
  return { version: 3, services };
}

/** A hunt.json with the one service `web` on port 3000, extended by `fields`. */
function web(fields: Record<string, unknown>): Record<string, unknown> {
  return withServices({ web: { command: "npm start", port: 3000, ...fields } });
}

/** `count` services `s0`, `s1`, … on the ports from 3000 on. */
function numbered(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`s${index}`, { command: "npm start", port: 3000 + index }]));
}

/** A hunt.json with the services of `web({})` and the one check `lint`, extended by `fields`. */
function lint(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...web({}), checks: { lint: { command: "npm run lint", ...fields } } };
}

describe("HuntJson services", () => {
  it("reads every field of every service in the order of hunt.json", () => {
    expect(huntJsonOf(COMPLETE).services).toEqual(COMPLETE_SERVICES);
  });

  it("gives a repository without hunt.json no services and a service without the optional fields no folder, no TLS, IAP and the review widget", () => {
    expect(huntJsonOf(undefined).services).toEqual([]);
    expect(huntJsonOf(web({ worktreeInclude: ["apps/web/.env.private", "config/*.local"] })).services[0].worktreeInclude).toEqual(["apps/web/.env.private", "config/*.local"]);
    expect(huntJsonOf(web({ worktreeInclude: [] })).services[0].worktreeInclude).toEqual([]);
    expect(huntJsonOf(web({})).services).toEqual([{ name: "web", command: "npm start", cwd: null, port: 3000, tls: false, guarded: true, review: true, env: {}, remoteSecrets: {}, worktreeInclude: [] }]);
  });

  it("reads the remote secrets of a service by variable, without the $", () => {
    const huntJson = web({ env: { A: "x" }, remoteSecrets: { OPENAI_API_KEY: "$MED_OPENAI_API_KEY", B: `$B${"9".repeat(63)}` } });
    expect(huntJsonOf(huntJson).services[0].remoteSecrets).toEqual({ OPENAI_API_KEY: "MED_OPENAI_API_KEY", B: `B${"9".repeat(63)}` });
  });

  it("accepts the edges of every rule", () => {
    const longest = { command: "x".repeat(4096), cwd: `${"a".repeat(127)}/${"b".repeat(127)}`, port: 65535 };
    const huntJson = withServices({ ...numbered(62), ["a".repeat(32)]: longest, "w-2": { command: "npm start", cwd: ".config/a.b_c-D9", port: 1024 } });

    expect(huntJsonOf(huntJson).services).toHaveLength(64);
    expect(huntJsonOf(huntJson).services.slice(62)).toEqual([
      { name: "a".repeat(32), ...longest, tls: false, guarded: true, review: true, env: {}, remoteSecrets: {}, worktreeInclude: [] },
      { name: "w-2", command: "npm start", cwd: ".config/a.b_c-D9", port: 1024, tls: false, guarded: true, review: true, env: {}, remoteSecrets: {}, worktreeInclude: [] },
    ]);
  });

  it("reports every problem with the path of the offending value", () => {
    const cases: [unknown, string[]][] = [
      [[], ["hunt.json: must be an object"]],
      ["x", ["hunt.json: must be an object"]],
      [{}, ["version: must be 3"]],
      [{ ...web({}), version: 2 }, ["version: must be 3"]],
      [{ ...web({}), version: "3" }, ["version: must be 3"]],
      [{ preview: { version: 2, main: 4200 } }, [CONTRACT_2_PROBLEM, "version: must be 3"]],
      [{ ...web({}), preview: { version: 2 } }, [CONTRACT_2_PROBLEM]],
      [{ ...web({}), environment: {}, "two words": 1 }, ["environment: unknown field", '["two words"]: unknown field']],
      ...["/srv/adr", "../adr", "a/./b", "", 1].map((adrDir): [unknown, string[]] => [{ ...web({}), adrDir }, [`adrDir: ${CWD_RULE}`]]),
      ...["", "Guardrail", "guard rail", "-guardrail", "a--b", "a".repeat(65), 1].map((guardrailSkill): [unknown, string[]] => [{ ...web({}), guardrailSkill }, [`guardrailSkill: ${SKILL_NAME_RULE}`]]),
      ...["/srv/declines.jsonl", "../declines.jsonl", "", 1].map((declinedGuardrailsFile): [unknown, string[]] => [{ ...web({}), declinedGuardrailsFile }, [`declinedGuardrailsFile: ${FILE_RULE}`]]),
      [{ ...web({}), swf: "claude-opus-5-5" }, ["swf: must be an object"]],
      [{ ...web({}), swf: { model: "claude-opus-5-5", effort: "high", humanReviewPaths: ["**/migrations/**"], skills: SKILLS, color: "red" } }, ["swf.color: unknown field"]],
      [{ ...web({}), swf: {} }, [`swf.steps: ${SKILLS_RULE}`]],
      [{ ...web({}), swf: { model: "claude-opus-5-5", humanReviewPaths: ["**/migrations/**"] } }, [`swf.steps: ${SKILLS_RULE}`]],
      [{ ...web({}), swf: { skills: {} } }, AGENT_STEPS.map((step) => `swf.steps.${step}.skill: ${STEP_SKILL_RULE}`)],
      [{ ...web({}), swf: { steps: {} } }, AGENT_STEPS.map((step) => `swf.steps.${step}.skill: ${STEP_SKILL_RULE}`)],
      [{ ...web({}), swf: { skills: { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", review: "swf-review" } } }, [`swf.steps.pr.skill: ${STEP_SKILL_RULE}`]],
      [{ ...web({}), swf: { skills: { pr: "swf-pr", plan: "swf-plan" } } }, ["implement", "verify", "review"].map((step) => `swf.steps.${step}.skill: ${STEP_SKILL_RULE}`)],
      [{ ...web({}), swf: { steps: { ...STEPS, review: { effort: "max" } }, skills: { plan: "swf-plan" } } }, [`swf.steps.review.skill: ${STEP_SKILL_RULE}`]],
      ...["swf-plan", ["swf-plan"], 1, null].map((skills): [unknown, string[]] => [{ ...web({}), swf: { skills } }, ["swf.skills: must be an object"]]),
      ...["swf-plan", ["swf-plan"], 1, null].map((steps): [unknown, string[]] => [{ ...web({}), swf: { steps } }, ["swf.steps: must be an object"]]),
      [{ ...web({}), swf: { steps: { ...STEPS, plan: "swf-plan" } } }, ["swf.steps.plan: must be an object"]],
      [
        { ...web({}), swf: { skills: { plan: "swf-plan", checks: "swf-checks", merge: "swf-merge" } } },
        ["swf.skills.checks: unknown field", "swf.skills.merge: unknown field", ...["implement", "verify", "review", "pr"].map((step) => `swf.steps.${step}.skill: ${STEP_SKILL_RULE}`)],
      ],
      [
        { ...web({}), swf: { steps: { ...STEPS, deploy: {}, plan: { skill: "swf-plan", color: "red" } } } },
        ["swf.steps.deploy: unknown field", "swf.steps.plan.color: unknown field"],
      ],
      [
        { ...web({}), swf: { steps: { ...STEPS, plan: { skill: "acme-plan" }, pr: { skill: "swf-pr" } }, skills: { ...SKILLS, review: "acme-review" } } },
        ["swf.steps.plan.skill: differs from swf.skills.plan", "swf.steps.review.skill: differs from swf.skills.review"],
      ],
      [
        { ...lint({}), swf: { steps: { ...STEPS, checks: { skill: "swf-checks", model: "claude-opus-5-5", effort: "low", maxReturns: 2, gate: "*" }, merge: { skill: "swf-merge" } } } },
        [
          "swf.steps.checks.skill: only an agent step has a skill",
          "swf.steps.checks.model: only an agent step has a model",
          "swf.steps.checks.effort: only an agent step has an effort",
          "swf.steps.checks.gate: only an agent step has a gate",
          "swf.steps.merge.skill: only an agent step has a skill",
        ],
      ],
      ...["plan", "implement", "pr"].map((step): [unknown, string[]] => [
        { ...web({}), swf: { steps: { ...STEPS, [step]: { skill: `swf-${step}`, maxReturns: 2, minSeverity: 2 } } } },
        [`swf.steps.${step}.maxReturns: ${MAX_RETURNS_STEP_RULE}`, `swf.steps.${step}.minSeverity: ${MIN_SEVERITY_STEP_RULE}`],
      ]),
      ...["checks", "human-review", "merge"].map((step): [unknown, string[]] => [
        { ...web({}), swf: { steps: { ...STEPS, [step]: { minSeverity: 2 } } } },
        [`swf.steps.${step}.minSeverity: ${MIN_SEVERITY_STEP_RULE}`],
      ]),
      ...[0, 6, 2.5, "3", null].map((minSeverity): [unknown, string[]] => [
        { ...web({}), swf: { steps: { ...STEPS, verify: { skill: "swf-verify", minSeverity }, review: { skill: "swf-review", minSeverity } } } },
        [`swf.steps.verify.minSeverity: ${MIN_SEVERITY_RULE}`, `swf.steps.review.minSeverity: ${MIN_SEVERITY_RULE}`],
      ]),
      ...["extreme", "High", "", 1, null].map((effort): [unknown, string[]] => [
        { ...web({}), swf: { effort, steps: { ...STEPS, review: { skill: "swf-review", effort } } } },
        [`swf.effort: ${EFFORT_RULE}`, `swf.steps.review.effort: ${EFFORT_RULE}`],
      ]),
      ...[0, -1, 1.5, "5", null].map((maxGateRuns): [unknown, string[]] => [{ ...web({}), swf: { maxGateRuns, skills: SKILLS } }, ["swf.maxGateRuns: must be an integer of at least 1"]]),
      ...["", " ", "❓ RÜCKFRAGE:", "Frage: ", "Frage\nbitte", "x".repeat(41), 1, null].map((questionPrefix): [unknown, string[]] => [
        { ...web({}), swf: { questionPrefix, skills: SKILLS } },
        [`swf.questionPrefix: ${QUESTION_PREFIX_RULE}`],
      ]),
      ...["In Progress", ["In Progress", "In Review", "Done"], 1, null].map((projectStatus): [unknown, string[]] => [
        { ...web({}), swf: { projectStatus, skills: SKILLS } },
        ["swf.projectStatus: must be an object"],
      ]),
      [{ ...web({}), swf: { projectStatus: { inProgress: "In Progress", inReview: "In Review" }, skills: SKILLS } }, [`swf.projectStatus.done: ${PROJECT_STATUS_RULE}`]],
      [{ ...web({}), swf: { projectStatus: {}, skills: SKILLS } }, ["inProgress", "inReview", "done"].map((name) => `swf.projectStatus.${name}: ${PROJECT_STATUS_RULE}`)],
      [
        { ...web({}), swf: { projectStatus: { inProgress: "", inReview: "a\nb", done: "x".repeat(61) }, skills: SKILLS } },
        ["inProgress", "inReview", "done"].map((name) => `swf.projectStatus.${name}: ${PROJECT_STATUS_RULE}`),
      ],
      [
        { ...web({}), swf: { projectStatus: { ...DEFAULT_WORKFLOW.projectStatus, foo: "Todo" }, skills: SKILLS } },
        ["swf.projectStatus.foo: unknown field"],
      ],
      ...["fast-forward", "Squash", "", 1, null].map((mergeMethod): [unknown, string[]] => [
        { ...web({}), swf: { mergeMethod, skills: SKILLS } },
        [`swf.mergeMethod: ${MERGE_METHOD_RULE}`],
      ]),
      ...[0, 21, 2.5, "3", null].map((maxReturns): [unknown, string[]] => [
        { ...web({}), swf: { steps: { ...STEPS, verify: { skill: "swf-verify", maxReturns }, "human-review": { maxReturns } } } },
        [`swf.steps.verify.maxReturns: ${MAX_RETURNS_RULE}`, `swf.steps.human-review.maxReturns: ${MAX_RETURNS_RULE}`],
      ]),
      ...["all", "", 1, null, { lint: true }, Array.from({ length: 33 }, () => "lint")].map((gate): [unknown, string[]] => [
        { ...lint({}), swf: { steps: { ...STEPS, implement: { skill: "swf-implement", gate } } } },
        [`swf.steps.implement.gate: ${GATE_RULE}`],
      ]),
      [
        { ...lint({}), swf: { steps: { ...STEPS, implement: { skill: "swf-implement", gate: ["lint", "Lint", "test"] } } } },
        [`swf.steps.implement.gate[1]: ${NAME_RULE}`],
      ],
      [
        { ...lint({}), swf: { steps: { ...STEPS, implement: { skill: "swf-implement", gate: ["lint", "test"] }, review: { skill: "swf-review", gate: ["format"] } } } },
        ["swf.steps.implement.gate: no such check test", "swf.steps.review.gate: no such check format"],
      ],
      [{ ...web({}), swf: { steps: { ...STEPS, implement: { skill: "swf-implement", gate: ["lint"] } } } }, ["swf.steps.implement.gate: no such check lint"]],
      ...["", "Swf-Plan", "swf plan", "-swf-plan", "a--b", "a".repeat(65), 1, null].map((plan): [unknown, string[]] => [
        { ...web({}), swf: { skills: { ...SKILLS, plan } } },
        [`swf.skills.plan: ${SKILL_NAME_RULE}`],
      ]),
      [
        { ...web({}), swf: { skills: { plan: "swf-plan", implement: 1, verify: "swf-verify", review: "", pr: "swf-pr" } } },
        [`swf.skills.implement: ${SKILL_NAME_RULE}`, `swf.skills.review: ${SKILL_NAME_RULE}`],
      ],
      ...["", "Swf-Plan", 1, null].map((skill): [unknown, string[]] => [
        { ...web({}), swf: { model: "opus", steps: { ...STEPS, plan: { skill, model: "sonnet" } } } },
        [`swf.model: ${MODEL_RULE}`, `swf.steps.plan.skill: ${SKILL_NAME_RULE}`, `swf.steps.plan.model: ${MODEL_RULE}`],
      ]),
      ...["**/migrations/**", Array.from({ length: 65 }, () => "**/migrations/**")].map((humanReviewPaths): [unknown, string[]] => [
        { ...web({}), swf: { humanReviewPaths, skills: SKILLS } },
        ["swf.humanReviewPaths: must be a list of at most 64 glob patterns"],
      ]),
      [
        { ...web({}), swf: { model: "opus", humanReviewPaths: ["**/migrations/**", "", " ", "/etc/hosts", "../secret", "a/../b", "a\nb", "x".repeat(256), 1], skills: SKILLS } },
        [`swf.model: ${MODEL_RULE}`, ...[1, 2, 3, 4, 5, 6, 7, 8].map((index) => `swf.humanReviewPaths[${index}]: ${GLOB_PATTERN_RULE}`)],
      ],
      ...["", "opus", "sonnet[1m]", "default", "Claude-Opus-5-5", "claude-", "claude-opus-5-5 ", "claude opus", "claude-opus-5-5\nx", `claude-${"x".repeat(122)}`, 5, null].map(
        (model): [unknown, string[]] => [{ ...web({}), swf: { model, skills: SKILLS } }, [`swf.model: ${MODEL_RULE}`]],
      ),
      [{ version: 3, services: [] }, ["services: must be an object"]],
      [withServices({}), ["services: must hold 1 to 64 services"]],
      [withServices(numbered(65)), ["services: must hold 1 to 64 services"]],
      [
        withServices({ Web: {}, "1web": {}, web_ui: {}, "-web": {}, ["a".repeat(33)]: {} }),
        [
          `services.Web: ${NAME_RULE}`,
          `services["1web"]: ${NAME_RULE}`,
          `services.web_ui: ${NAME_RULE}`,
          `services["-web"]: ${NAME_RULE}`,
          `services.${"a".repeat(33)}: ${NAME_RULE}`,
        ],
      ],
      [web({ worktreeInclude: "**/.env.private" }), ["services.web.worktreeInclude: must be a list of at most 64 glob patterns"]],
      [web({ worktreeInclude: Array.from({ length: 65 }, () => ".env") }), ["services.web.worktreeInclude: must be a list of at most 64 glob patterns"]],
      [
        web({ worktreeInclude: ["**/.env.private", "", " ", "/etc/hosts", "../secret", "a/../b", "a\nb", "x".repeat(256), 1] }),
        [1, 2, 3, 4, 5, 6, 7, 8].map((index) => `services.web.worktreeInclude[${index}]: ${GLOB_PATTERN_RULE}`),
      ],
      [withServices({ web: "npm start" }), ["services.web: must be an object"]],
      [web({ run: "npm start", main: true }), ["services.web.run: unknown field", "services.web.main: unknown field"]],
      [withServices({ web: { port: 3000 } }), ["services.web.command: must be a non-empty string"]],
      [web({ command: "" }), ["services.web.command: must be a non-empty string"]],
      [web({ command: "  " }), ["services.web.command: must be a non-empty string"]],
      [web({ command: ["npm", "start"] }), ["services.web.command: must be a non-empty string"]],
      [web({ command: "npm start\nrm -rf /" }), ["services.web.command: must be a single line"]],
      [web({ command: "npm\rstart" }), ["services.web.command: must be a single line"]],
      [web({ command: "x".repeat(4097) }), ["services.web.command: must be at most 4096 characters long"]],
      ...["/srv/app", "../app", "a/../b", "./a", "a/.", "a//b", "a/", "a b", "a\\b", "", "x".repeat(256), 1].map(
        (cwd): [unknown, string[]] => [web({ cwd }), [`services.web.cwd: ${CWD_RULE}`]],
      ),
      [withServices({ web: { command: "npm start" } }), [`services.web.port: ${PORT_RULE}`]],
      [web({ port: "3000" }), [`services.web.port: ${PORT_RULE}`]],
      [web({ port: 3000.5 }), [`services.web.port: ${PORT_RULE}`]],
      [web({ port: 1023 }), [`services.web.port: ${PORT_RULE}`]],
      [web({ port: 65536 }), [`services.web.port: ${PORT_RULE}`]],
      [web({ port: 2019 }), ["services.web.port: 2019 is reserved for Caddy's admin API"]],
      [web({ port: 2375 }), ["services.web.port: 2375 is reserved for the Docker API"]],
      [web({ port: 2376 }), ["services.web.port: 2376 is reserved for the Docker API over TLS"]],
      [web({ port: 5355 }), ["services.web.port: 5355 is reserved for LLMNR of systemd-resolved"]],
      [web({ port: 8080 }), ["services.web.port: 8080 is reserved for the session VM's preview proxy"]],
      [web({ port: 9222 }), ["services.web.port: 9222 is reserved for the remote debugging port of the desktop's Chromium"]],
      [web({ port: 9230 }), ["services.web.port: 9230 is reserved for the desktop's Waymote gateway"]],
      [web({ port: 9231 }), ["services.web.port: 9231 is reserved for the desktop's proxy for the desktop client"]],
      [web({ port: 9232 }), ["services.web.port: 9232 is reserved for the review server of the preview proxy"]],
      [web({ port: 20201 }), ["services.web.port: 20201 is reserved for the Google Ops Agent's OpenTelemetry collector"]],
      [web({ port: 20202 }), ["services.web.port: 20202 is reserved for the Google Ops Agent's Fluent Bit"]],
      [
        withServices({ web: { command: "a", port: 3000 }, api: { command: "b", port: 3000 }, docs: { command: "c", port: 3000 } }),
        ["services.api.port: 3000 is the port of the service web already", "services.docs.port: 3000 is the port of the service web already"],
      ],
      [
        web({ tls: "true", guarded: 0, review: "no" }),
        ["services.web.tls: must be true or false", "services.web.guarded: must be true or false", "services.web.review: must be true or false"],
      ],
      [web({ env: [] }), ["services.web.env: must be an object"]],
      [web({ env: { lower: "x" } }), ["services.web.env.lower: invalid name, must match ^[A-Z_][A-Z0-9_]*$"]],
      [web({ env: { "BAD-KEY": "x" } }), ["services.web.env.BAD-KEY: invalid name, must match ^[A-Z_][A-Z0-9_]*$"]],
      [web({ env: { "1A": "x" } }), ['services.web.env["1A"]: invalid name, must match ^[A-Z_][A-Z0-9_]*$']],
      [web({ env: { HUNT_URL: "x" } }), ["services.web.env.HUNT_URL: reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt"]],
      [web({ env: { CLAUDE_X: "x" } }), ["services.web.env.CLAUDE_X: reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt"]],
      [web({ env: { A: 1, B: null } }), ["services.web.env.A: must be a string", "services.web.env.B: must be a string"]],
      [
        web({ env: { A: "x\ny", B: "x\ry", C: "x\0y" } }),
        ["services.web.env.A: must be a single line", "services.web.env.B: must be a single line", "services.web.env.C: must be a single line"],
      ],
      [
        web({ env: { A: "${HUNT_PREVIEW_URL_3000}", B: "${HUNT_PREVIEW_URL}/app;${HUNT_PREVIEW_URL_TEMPLATE}" } }),
        [
          "services.web.env.A: ${HUNT_PREVIEW_URL_3000} is a placeholder of contract 2, use ${services.<name>.publicUrl}",
          "services.web.env.B: ${HUNT_PREVIEW_URL} is a placeholder of contract 2, use ${services.<name>.publicUrl}",
          "services.web.env.B: ${HUNT_PREVIEW_URL_TEMPLATE} is a placeholder of contract 2, use ${services.<name>.publicUrl}",
        ],
      ],
      [
        web({ env: { A: "${services.api.publicUrl}", B: "${services.Web.publicUrl}" } }),
        [
          "services.web.env.A: ${services.api.publicUrl}: hunt.json declares no service api",
          "services.web.env.B: ${services.Web.publicUrl}: hunt.json declares no service Web",
        ],
      ],
      [
        web({ env: { A: "${services.web.url}", B: "${services.web}", C: "${services..publicUrl}", D: "${services.web.publicUrl.host}" } }),
        [
          "services.web.env.A: unknown placeholder ${services.web.url}, the form is ${services.<name>.publicUrl}",
          "services.web.env.B: unknown placeholder ${services.web}, the form is ${services.<name>.publicUrl}",
          "services.web.env.C: unknown placeholder ${services..publicUrl}, the form is ${services.<name>.publicUrl}",
          "services.web.env.D: unknown placeholder ${services.web.publicUrl.host}, the form is ${services.<name>.publicUrl}",
        ],
      ],
      [web({ remoteSecrets: [] }), ["services.web.remoteSecrets: must be an object"]],
      [
        web({ remoteSecrets: { lower: "$A", HUNT_KEY: "$A" } }),
        [
          "services.web.remoteSecrets.lower: invalid name, must match ^[A-Z_][A-Z0-9_]*$",
          "services.web.remoteSecrets.HUNT_KEY: reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt",
        ],
      ],
      [web({ env: { A: "x" }, remoteSecrets: { A: "$A" } }), ["services.web.remoteSecrets.A: is set in env already"]],
      [
        web({ remoteSecrets: { A: "MED_KEY", B: "${MED_KEY}", C: "$med_key", D: "$", E: 1, F: `$A${"B".repeat(64)}`, G: "$A B" } }),
        ["A", "B", "C", "D", "E", "F", "G"].map((key) => `services.web.remoteSecrets.${key}: ${REMOTE_SECRET_RULE}`),
      ],
      [
        withServices({ Web: { command: "a", port: 3000 }, api: { command: "b", port: 3001, env: { A: "${services.Web.publicUrl}" } } }),
        [`services.Web: ${NAME_RULE}`, "services.api.env.A: ${services.Web.publicUrl}: hunt.json declares no service Web"],
      ],
      [{ version: 3, checks: [] }, ["checks: must be an object"]],
      [{ version: 3, checks: "npm test" }, ["checks: must be an object"]],
      [
        { version: 3, checks: Object.fromEntries(Array.from({ length: 33 }, (_unused, index) => [`c${index}`, { command: "npm test" }])) },
        ["checks: must hold at most 32 checks"],
      ],
      [
        { version: 3, checks: { Lint: {}, "1lint": {}, lint_all: {}, ["a".repeat(33)]: {} } },
        [`checks.Lint: ${NAME_RULE}`, `checks["1lint"]: ${NAME_RULE}`, `checks.lint_all: ${NAME_RULE}`, `checks.${"a".repeat(33)}: ${NAME_RULE}`],
      ],
      [{ version: 3, checks: { lint: "npm run lint" } }, ["checks.lint: must be an object"]],
      [lint({ port: 3000, env: {} }), ["checks.lint.port: unknown field", "checks.lint.env: unknown field"]],
      [{ version: 3, checks: { lint: {} } }, ["checks.lint.command: must be a non-empty string"]],
      [lint({ command: " " }), ["checks.lint.command: must be a non-empty string"]],
      [lint({ command: ["npm", "test"] }), ["checks.lint.command: must be a non-empty string"]],
      [lint({ command: "npm test\nrm -rf /" }), ["checks.lint.command: must be a single line"]],
      [lint({ command: "x".repeat(4097) }), ["checks.lint.command: must be at most 4096 characters long"]],
      ...["/srv/app", "../app", "a/./b", "a b", "", 1].map((cwd): [unknown, string[]] => [lint({ cwd }), [`checks.lint.cwd: ${CWD_RULE}`]]),
    ];

    for (const [huntJson, problems] of cases) {
      expect(problemsOf(huntJson), JSON.stringify(huntJson).slice(0, 200)).toEqual(problems);
    }
  });

  it("reads a hunt.json without services, with or without checks", () => {
    expect(problemsOf({ version: 3 })).toEqual([]);
    expect(problemsOf({ version: 3, checks: {} })).toEqual([]);
    expect(problemsOf({ version: 3, checks: { test: { command: "npm test" } } })).toEqual([]);
    expect(buildSessionConfig({ version: 3, checks: { test: { command: "npm test" } } }, HOST, WORKTREE)).toMatchObject({
      services: [],
      serviceEnvs: {},
      servicesPrompt: servicesPrompt([], HOST),
    });
  });

  it("rejects an invalid short ID or domain together with the problems of hunt.json", () => {
    expect(problemsOf(web({ port: 1 }), { short: "7C0C6F2E", domain: "localhost" })).toEqual([
      "short: must be the first 8 hex digits of the session ID, in lowercase",
      "domain: must be a lowercase host name with at least two labels, the last of letters only",
      `services.web.port: ${PORT_RULE}`,
    ]);
    expect(problemsOf(undefined, { short: "7c0c6f2", domain: "Hunt.Example.com" })).toHaveLength(2);
  });

  it("accepts the domains hunt-ctl accepts: a top-level label of letters and room for the open hosts", () => {
    const domainOfLength = (length: number) => `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(length - 196)}.com`;
    expect(`${HOST.short}-65535-open.${domainOfLength(233)}`).toHaveLength(253);
    for (const domain of ["a-1.b2.example.de", domainOfLength(233)]) {
      expect(problemsOf(undefined, { short: "7c0c6f2e", domain }), domain).toEqual([]);
    }
    for (const domain of ["hunt.example.c0m", "hunt.example.c", "hunt.example.123", "hunt.example.co-m", "-a.example.com", domainOfLength(234)]) {
      expect(problemsOf(undefined, { short: "7c0c6f2e", domain }), domain).toHaveLength(1);
    }
  });
});

describe("HuntJson checks", () => {
  it("reads every check in the order of hunt.json", () => {
    const huntJson = {
      ...COMPLETE,
      checks: {
        format: { command: "npm run format:check" },
        test: { command: "npm test -- --reporter dot", cwd: "apps/web" },
        ["a".repeat(32)]: { command: "x".repeat(4096), cwd: ".config/a.b_c-D9" },
      },
    };

    expect(huntJsonOf(huntJson).checks).toEqual([
      { name: "format", command: "npm run format:check", cwd: null },
      { name: "test", command: "npm test -- --reporter dot", cwd: "apps/web" },
      { name: "a".repeat(32), command: "x".repeat(4096), cwd: ".config/a.b_c-D9" },
    ]);
    expect(huntJsonOf(huntJson).services).toEqual(COMPLETE_SERVICES);
  });

  it("gives a repository without hunt.json or checks no checks and accepts 32 of them", () => {
    expect(huntJsonOf(undefined).checks).toEqual([]);
    expect(huntJsonOf(COMPLETE).checks).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 32 }, (_unused, index) => [`c${index}`, { command: "npm test" }]));
    expect(huntJsonOf({ version: 3, checks: many }).checks).toHaveLength(32);
  });

  it("reports the problems of hunt.json, not only those of its checks", () => {
    expect(() => huntJsonOf({ ...lint({}), version: 2 }).checks).toThrow(new ConfigError(["version: must be 3"]));
  });

  it("finds a check by name and reports a missing one with its path", () => {
    expect(huntJsonOf(lint({ cwd: "apps/web" })).findCheck("lint")).toEqual({ name: "lint", command: "npm run lint", cwd: "apps/web" });
    expect(() => huntJsonOf(lint({})).findCheck("test")).toThrow(new ConfigError(["checks.test: no such check"]));
    expect(() => huntJsonOf(undefined).findCheck("lint")).toThrow(new ConfigError(["checks.lint: no such check"]));
    expect(() => huntJsonOf(lint({ command: "" })).findCheck("lint")).toThrow(new ConfigError(["checks.lint.command: must be a non-empty string"]));
  });
});

describe("HuntJson", () => {
  it("has no services, checks or swf settings without hunt.json", () => {
    expect(HuntJson.none().toJSON()).toEqual({ version: 3, adrDir: null, guardrailSkill: null, declinedGuardrailsFile: null, swf: null, services: [], checks: [] });
    expect(HuntJson.fromDocument(undefined).huntJson?.isEqualTo(HuntJson.none())).toBe(true);
  });

  it("has swf settings only with the swf section, the skills of swf.skills merged into the steps", () => {
    expect(huntJsonOf(web({})).swf).toBeNull();
    expect(huntJsonOf(web({})).stepSettings).toBeNull();
    expect(huntJsonOf({ ...web({}), swf: { skills: SKILLS } }).swf?.isEqualTo(new SwfSettings({ steps: STEPS }))).toBe(true);
    expect(huntJsonOf({ ...web({}), swf: { steps: STEPS, skills: SKILLS } }).swf?.isEqualTo(new SwfSettings({ steps: STEPS }))).toBe(true);
    const mixed = { steps: { plan: { skill: "acme-plan" }, implement: { gate: [] } }, skills: { implement: "swf-implement", verify: "swf-verify", review: "swf-review", pr: "swf-pr" } };
    expect(huntJsonOf({ ...web({}), swf: mixed }).stepSettings?.steps).toMatchObject({ plan: { skill: "acme-plan" }, implement: { skill: "swf-implement", gate: [] } });
  });

  it("resolves the settings of every step of a section that names only the skills, with every check as the gate of implement", () => {
    const checks = Object.fromEntries(["format-check", "i18n-check", "lint", "test", "build", "generate-types"].map((name) => [name, { command: `npm run ${name}` }]));
    const huntJson = huntJsonOf({ ...web({}), swf: { model: "claude-opus-5-5", humanReviewPaths: ["apps/*/backend/src/migrations/**", "hunt.json"], skills: SKILLS }, checks });
    const unset = { effort: null, minSeverity: null, gate: [] };
    expect(huntJson.stepSettings?.toJSON()).toEqual({
      maxGateRuns: 5,
      ...DEFAULT_WORKFLOW,
      steps: {
        plan: { skill: "swf-plan", model: "claude-opus-5-5", ...unset, maxReturns: null },
        implement: { skill: "swf-implement", model: "claude-opus-5-5", ...unset, maxReturns: null, gate: Object.keys(checks) },
        verify: { skill: "swf-verify", model: "claude-opus-5-5", ...unset, maxReturns: 5, minSeverity: 3 },
        review: { skill: "swf-review", model: "claude-opus-5-5", ...unset, maxReturns: 3, minSeverity: 3 },
        pr: { skill: "swf-pr", model: "claude-opus-5-5", ...unset, maxReturns: null },
        checks: { skill: null, model: null, ...unset, maxReturns: 2 },
        "human-review": { skill: null, model: null, ...unset, maxReturns: 3 },
        merge: { skill: null, model: null, ...unset, maxReturns: 2 },
      },
    });
  });

  it("resolves the settings each step sets over the section's and expands its gate in the order of the checks", () => {
    const swf = {
      model: "claude-opus-5-5",
      effort: "high",
      maxGateRuns: 3,
      steps: {
        plan: { skill: "swf-plan" },
        implement: { skill: "swf-implement", model: "claude-sonnet-5-5", effort: "medium", gate: ["test", "lint"] },
        verify: { skill: "swf-verify", maxReturns: 7, minSeverity: 4 },
        review: { skill: "swf-review", effort: "max", gate: "*" },
        pr: { skill: "swf-pr" },
        merge: { maxReturns: 1 },
      },
    };
    const settings = huntJsonOf({ ...web({}), swf, checks: { lint: { command: "npm run lint" }, test: { command: "npm test" }, build: { command: "npm run build" } } }).stepSettings;
    expect(settings?.maxGateRuns).toBe(3);
    expect(settings?.steps).toMatchObject({
      plan: { model: "claude-opus-5-5", effort: "high", gate: [] },
      implement: { model: "claude-sonnet-5-5", effort: "medium", gate: ["lint", "test"] },
      verify: { maxReturns: 7, minSeverity: 4 },
      review: { effort: "max", maxReturns: 3, minSeverity: 3, gate: ["lint", "test", "build"] },
      merge: { maxReturns: 1 },
    });
    expect(huntJsonOf({ ...web({}), swf: { steps: { ...STEPS, implement: { skill: "swf-implement", gate: "*" } } } }).stepSettings?.of("implement").gate).toEqual([]);
  });

  it("reads the question prefix, the project statuses and the merge method of the section and resolves Hunt's without them", () => {
    const workflow = { questionPrefix: "❓ QUESTION", projectStatus: { inProgress: "Doing", inReview: "Review", done: "Shipped" }, mergeMethod: "rebase" };
    const huntJson = huntJsonOf({ ...web({}), swf: { ...workflow, skills: SKILLS } });
    expect(huntJson.swf?.toJSON()).toMatchObject(workflow);
    expect(huntJson.stepSettings?.toJSON()).toMatchObject(workflow);
    expect(huntJsonOf({ ...web({}), swf: { skills: SKILLS } }).swf?.toJSON()).toMatchObject({ questionPrefix: null, projectStatus: null, mergeMethod: null });
    expect(huntJsonOf({ ...web({}), swf: { skills: SKILLS } }).stepSettings?.toJSON()).toMatchObject(DEFAULT_WORKFLOW);
    for (const questionPrefix of ["?", "Frage (bitte):x", "x".repeat(40)]) {
      expect(huntJsonOf({ ...web({}), swf: { questionPrefix, skills: SKILLS } }).stepSettings?.questionPrefix).toBe(questionPrefix);
    }
    for (const mergeMethod of ["squash", "merge", "rebase"] as const) {
      expect(huntJsonOf({ ...web({}), swf: { mergeMethod, skills: SKILLS } }).stepSettings?.mergeMethod).toBe(mergeMethod);
    }
  });

  it("reads app-framework's swf section", () => {
    const checks = Object.fromEntries(["format-check", "i18n-check", "lint", "test", "build", "generate-types"].map((name) => [name, { command: `npm run ${name}` }]));
    const settings = huntJsonOf({ ...web({}), swf: APP_FRAMEWORK_SWF, checks }).stepSettings;
    expect(settings?.toJSON()).toMatchObject({ maxGateRuns: 5, ...DEFAULT_WORKFLOW });
    expect(settings?.steps).toMatchObject({
      plan: { skill: "swf-plan", model: "claude-opus-5-5", effort: null, gate: [] },
      implement: { skill: "swf-implement", gate: Object.keys(checks) },
      verify: { skill: "swf-verify", maxReturns: 3, minSeverity: 3 },
      review: { skill: "swf-review", maxReturns: 3, minSeverity: 3 },
      pr: { skill: "swf-pr" },
      checks: { maxReturns: 2 },
      "human-review": { maxReturns: 3 },
      merge: { maxReturns: 2 },
    });
  });

  it("reports the remote secrets that do not exist after every other problem, only when it knows the existing ones", () => {
    const huntJson = { ...web({ remoteSecrets: { A: "$KEY_A", B: "$KEY_B" } }), checks: { Lint: {} } };
    expect(HuntJson.fromDocument(huntJson).problems).toEqual([`checks.Lint: ${NAME_RULE}`]);
    expect(HuntJson.fromDocument(huntJson, new Set(["KEY_B"])).problems).toEqual([
      `checks.Lint: ${NAME_RULE}`,
      "services.web.remoteSecrets.A: no remote secret KEY_A; set it in Hunt under Settings → Remote VM",
    ]);
  });

  it("refuses services that share a port or name a service it does not hold, and gates that name a check it does not hold", () => {
    const service = { name: "web", command: "npm start", port: 3000 };
    expect(() => new HuntJson({ services: [service, { ...service, name: "api" }] })).toThrow(/a port of its own/);
    expect(() => new HuntJson({ services: [{ ...service, env: { API: "${services.api.publicUrl}" } }] })).toThrow(/names a service of hunt.json/);
    const swf = { steps: { ...STEPS, review: { skill: "swf-review", gate: ["lint"] } } };
    expect(() => new HuntJson({ swf })).toThrow(/every gate names a check of hunt.json/);
    expect(new HuntJson({ swf, checks: [{ name: "lint", command: "npm run lint" }] }).stepSettings?.of("review").gate).toEqual(["lint"]);
  });
});

describe("environments", () => {
  const config = buildSessionConfig(COMPLETE, HOST, WORKTREE);

  it("gives the session only the URL template of its port hosts", () => {
    expect(config.env).toEqual({ HUNT_PREVIEW_URL_TEMPLATE: "https://7c0c6f2e-{port}.hunt.example.com" });
    expect(sessionEnv(HOST)).toEqual(config.env);
    expect(buildSessionConfig(undefined, HOST, WORKTREE).env).toEqual(config.env);
  });

  it("resolves a service's URL to its open host when it is not guarded and to its port host otherwise", () => {
    expect(COMPLETE_SERVICES.map((service) => service.publicUrl(HOST))).toEqual([
      "https://7c0c6f2e-3000-open.hunt.example.com",
      "https://7c0c6f2e-4200.hunt.example.com",
      "https://7c0c6f2e-4400.hunt.example.com",
      "https://7c0c6f2e-4800-open.hunt.example.com",
    ]);
  });

  it("gives each service its variables with self and forward references resolved, then its folder and command", () => {
    expect(Object.keys(config.serviceEnvs)).toEqual(["backend", "ui", "docs", "admin"]);
    expect(Object.keys(config.serviceEnvs.backend)).toEqual([
      ...["BACKEND_DOMAIN", "UI_BASE_URL", "BOTH", "OTHER", "PLAIN"],
      ...["HUNT_SERVICE_DIR", "HUNT_SERVICE_COMMAND"],
    ]);
    expect(config.serviceEnvs).toEqual({
      backend: {
        BACKEND_DOMAIN: "https://7c0c6f2e-3000-open.hunt.example.com",
        UI_BASE_URL: "https://7c0c6f2e-4200.hunt.example.com/app",
        BOTH: "https://7c0c6f2e-4200.hunt.example.com;https://7c0c6f2e-4800-open.hunt.example.com",
        OTHER: "${HOME}",
        PLAIN: "x",
        HUNT_SERVICE_DIR: WORKTREE,
        HUNT_SERVICE_COMMAND: "npm run start:backend",
      },
      ui: {
        DEV_BACKEND_ORIGIN: "https://7c0c6f2e-3000-open.hunt.example.com",
        HUNT_SERVICE_DIR: "/home/agent/acme/apps/ui",
        HUNT_SERVICE_COMMAND: "npm start -- --port 4200",
      },
      docs: { HUNT_SERVICE_DIR: WORKTREE, HUNT_SERVICE_COMMAND: "npx serve docs" },
      admin: { HUNT_SERVICE_DIR: WORKTREE, HUNT_SERVICE_COMMAND: 'echo "$PATH" && npm run admin' },
    });
  });

  it("gives a service the remote secrets it names after its variables and reports each one that is missing", () => {
    const huntJson = web({ env: { PLAIN: "x" }, remoteSecrets: { OPENAI_API_KEY: "$MED_OPENAI_API_KEY", TOKEN: "$TOKEN" } });
    const env = buildSessionConfig(huntJson, HOST, WORKTREE, { MED_OPENAI_API_KEY: "sk-1 $x", TOKEN: "t", OTHER: "o" }).serviceEnvs.web;

    expect(Object.keys(env)).toEqual(["PLAIN", "OPENAI_API_KEY", "TOKEN", "HUNT_SERVICE_DIR", "HUNT_SERVICE_COMMAND"]);
    expect(env).toMatchObject({ PLAIN: "x", OPENAI_API_KEY: "sk-1 $x", TOKEN: "t" });
    expect(problemsOf(huntJson, HOST, { TOKEN: "t" })).toEqual([MISSING_SECRET]);
    expect(problemsOf(huntJson)).toEqual([MISSING_SECRET, "services.web.remoteSecrets.TOKEN: no remote secret TOKEN; set it in Hunt under Settings → Remote VM"]);
  });

  it("returns the parsed services and everything derived from them", () => {
    expect(config.services).toEqual(COMPLETE_SERVICES);
    expect(config.proxy).toEqual(proxyConfig(COMPLETE_SERVICES, HOST));
    expect(config.servicesPrompt).toBe(servicesPrompt(COMPLETE_SERVICES, HOST));
    expect(buildSessionConfig(undefined, HOST, WORKTREE)).toMatchObject({ services: [], serviceEnvs: {}, servicesPrompt: servicesPrompt([], HOST) });
  });

  it("accepts the name of the guardrail skill", () => {
    expect(problemsOf({ ...web({}), guardrailSkill: "team-lessons-2" })).toEqual([]);
  });

  it("accepts the file of the declined guardrail suggestions", () => {
    expect(problemsOf({ ...web({}), declinedGuardrailsFile: ".claude/resources/guardrails/declined-guardrails.jsonl" })).toEqual([]);
  });

  it("accepts the folder of the architectural decision records", () => {
    expect(buildSessionConfig({ ...web({}), adrDir: ".claude/resources/adrs" }, HOST, WORKTREE).services).toEqual(buildSessionConfig(web({}), HOST, WORKTREE).services);
  });

  it("reads the model of swf sessions, none without the swf section or its model", () => {
    expect(config.swfSteps).toBeNull();
    expect(buildSessionConfig(undefined, HOST, WORKTREE).swfSteps).toBeNull();
    expect(buildSessionConfig({ ...web({}), swf: { skills: SKILLS } }, HOST, WORKTREE).swfSteps?.of("plan").model).toBeNull();
    for (const model of ["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-sonnet-5-5[1m]", "claude-3.7-sonnet", `claude-${"x".repeat(121)}`]) {
      expect(buildSessionConfig({ ...web({}), swf: { model, skills: SKILLS } }, HOST, WORKTREE).swfSteps?.of("plan").model).toBe(model);
    }
  });

  it("accepts the paths whose change makes a pull request of swf sessions need a human review without reading them: the repository's review workflow does", () => {
    expect(buildSessionConfig({ ...web({}), swf: { humanReviewPaths: [], skills: SKILLS } }, HOST, WORKTREE)).not.toHaveProperty("swfHumanReviewPaths");
    const humanReviewPaths = [
      "**/migrations/**",
      "libs/shared-backend/src/auth/**",
      "*.sql",
      "x".repeat(255),
      ...Array.from({ length: 60 }, (_unused, index) => `apps/${index}/**`),
    ];
    const config = buildSessionConfig({ ...web({}), swf: { humanReviewPaths, skills: SKILLS } }, HOST, WORKTREE);
    expect(config.swfSteps?.isEqualTo(huntJsonOf({ ...web({}), swf: { skills: SKILLS } }).stepSettings)).toBe(true);
    expect(JSON.stringify(config)).not.toContain("migrations");
  });

  it("reads the skill of every agent step of swf sessions as hunt.json names them, in the order of the steps, and none without the swf section", () => {
    const skillsOf = (swf: unknown) => {
      const steps = buildSessionConfig({ ...web({}), swf }, HOST, WORKTREE).swfSteps;
      return steps && AGENT_STEPS.map((step) => steps.skillOf(step));
    };
    const skills = { plan: "swf-plan", implement: "swf-implement-2", verify: "a".repeat(64), review: "swf-review", pr: "pr" };
    expect(skillsOf({ skills })).toEqual(Object.values(skills));
    const unordered = { pr: "a-pr", review: "a-review", verify: "a-verify", implement: "a-implement", plan: "a-plan" };
    expect(skillsOf({ skills: unordered })).toEqual(["a-plan", "a-implement", "a-verify", "a-review", "a-pr"]);
    expect(Object.keys(buildSessionConfig({ ...web({}), swf: { skills: unordered } }, HOST, WORKTREE).swfSteps?.steps ?? {})).toEqual([...SWF_STEPS]);
    expect(() => buildSessionConfig({ ...web({}), swf: { model: "claude-opus-5-5" } }, HOST, WORKTREE)).toThrow(ConfigError);
    expect(() => buildSessionConfig({ ...web({}), swf: { skills: { review: "acme-review" } } }, HOST, WORKTREE)).toThrow(ConfigError);
  });
});

describe("envFile", () => {
  const TRICKY = {
    QUOTES: `say "hi" and 'bye'`,
    BACKSLASHES: "C:\\path\\ and a trailing \\",
    DOLLARS: "$HOME ${HOME} $(id) `id`",
    SPACES: "  padded  ",
    HASH: "#not a comment ;nor this",
    EMPTY: "",
    UNICODE: "Grüße 🚀",
    HUNT_SERVICE_COMMAND: `npm run dev -- --host "$HOST" | tee 'out.log' && echo \`date\``,
  };

  it("writes the header as a comment and one double-quoted assignment per line and escapes \\, \", ` and $", () => {
    expect(envFile({ A: "x", B: 'a"b\\c`d$e' }, "The environment of web.")).toBe('# The environment of web.\nA="x"\nB="a\\"b\\\\c\\`d\\$e"\n');
  });

  it("reads back verbatim in a shell, which unquotes like systemd's EnvironmentFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunt-env-"));
    try {
      const file = join(dir, "web.env");
      writeFileSync(file, envFile(TRICKY, "The environment of web."));
      const keys = Object.keys(TRICKY);
      const script = `set -a; . "$1"; for key in ${keys.join(" ")}; do printf '%s\\0' "\${!key}"; done`;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script, "bash", file], { encoding: "utf8", env: {} });

      expect(result.stderr).toBe("");
      expect(result.stdout.split("\0").slice(0, -1)).toEqual(Object.values(TRICKY));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("servicesPrompt", () => {
  it("tells the agent how to run the services and lists each with its port, URL and access", () => {
    expect(servicesPrompt(COMPLETE_SERVICES, HOST)).toBe(
      [
        "### The repository's services",
        "",
        "Hunt runs the services of the repository's hunt.json on this VM, each as a systemd unit. Start only the services your task needs; " +
          "the repository's hunt.agent.md, when it has one, says which belong together:",
        "",
        "```",
        "sudo -n hunt-ctl service start <name>…",
        "```",
        "",
        "`restart`, `stop` and `status` take names the same way; `status` without names reports every service. A service writes its output to " +
          "`~/logs/<name>.log`. The variables hunt.json declares for a service apply to that service only, not to your shell.",
        "",
        "| Service | Port | URL | Access |",
        "| --- | --- | --- | --- |",
        "| backend | 3000 | https://7c0c6f2e-3000-open.hunt.example.com | public, app login only |",
        "| ui | 4200 | https://7c0c6f2e-4200.hunt.example.com | Google login |",
        "| docs | 4400 | https://7c0c6f2e-4400.hunt.example.com | Google login |",
        "| admin | 4800 | https://7c0c6f2e-4800-open.hunt.example.com | public, app login only |",
      ].join("\n"),
    );
  });

  it("tells the agent to run the app itself without services", () => {
    expect(servicesPrompt([], HOST)).toBe(
      [
        "### The repository's services",
        "",
        "The repository has no hunt.json or declares no services in it: run the app as a developer would locally, in the " +
          "tmux session `app` as described above.",
      ].join("\n"),
    );
  });
});

describe("proxyConfig", () => {
  const config = proxyConfig(COMPLETE_SERVICES, HOST);
  const server = config.apps.http.servers.preview;

  type HostPattern = { name: string; pattern: string };
  /** The method and headers of a request; a script's GET without `text/html` in Accept by default. */
  type RequestShape = { method: string; headers: Record<string, string> };
  const PAGE_LOAD: RequestShape = { method: "GET", headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } };

  /** Whether `actual` matches a value of Caddy's header matcher, where a leading or trailing `*` stands for any text. */
  function headerMatches(pattern: string, actual: string): boolean {
    const text = pattern.replace(/^\*/, "").replace(/\*$/, "");
    if (pattern.startsWith("*") && pattern.endsWith("*")) return actual.includes(text);
    if (pattern.startsWith("*")) return actual.endsWith(text);
    if (pattern.endsWith("*")) return actual.startsWith(text);
    return actual === text;
  }

  /**
   * The first route of `proxy` that matches a request to `hostName` at `path`, as Caddy picks it, with the captures of its
   * regexps; with `refused`, the first of its error routes for that request when its upstream refused the connection.
   */
  function routeFor(proxy: CaddyConfig, hostName: string, path = "/", refused = false, request: RequestShape = { method: "GET", headers: {} }) {
    const server = proxy.apps.http.servers.preview;
    for (const route of refused ? server.errors.routes : server.routes) {
      const captures: Record<string, RegExpExecArray> = {};
      const matchesSet = (set: Record<string, unknown>) =>
        Object.entries(set).every(([kind, value]) => {
          if (kind === "host") return (value as string[]).includes(hostName);
          if (kind === "path") return (value as string[]).some((pattern) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path));
          if (kind === "method") return (value as string[]).includes(request.method);
          if (kind === "header") {
            return Object.entries(value as Record<string, string[]>).every(([name, patterns]) =>
              patterns.some((pattern) => headerMatches(pattern, request.headers[name] ?? "")),
            );
          }
          if (kind === "expression") return refused && value === "{http.error.status_code} == 502";
          if (kind !== "vars_regexp") throw new Error(`unknown matcher ${kind}`);
          return Object.entries(value as Record<string, HostPattern>).every(([placeholder, { name, pattern }]) => {
            expect(placeholder).toBe("{http.request.host}");
            const match = new RegExp(pattern).exec(hostName);
            if (match) {
              captures[name] = match;
            }
            return Boolean(match);
          });
        });
      if (!route.match || route.match.some(matchesSet)) return { route, captures };
    }
    throw new Error(`no route for ${hostName}${path}`);
  }

  /**
   * What `proxy` answers a request to `hostName` at `path` with: a status code, the upstream URL, or for the review server
   * `review` and, for a page load, the URL of the dev server it fetches the page from.
   */
  function answer(proxy: CaddyConfig, hostName: string, path = "/", request?: RequestShape): string {
    const { route, captures } = routeFor(proxy, hostName, path, false, request);
    const handler = route.handle.at(-1) as {
      handler: string;
      status_code?: number;
      upstreams?: { dial: string }[];
      transport?: unknown;
      headers?: { request: { set: Record<string, string[]> } };
    };
    if (handler.handler === "static_response") return String(handler.status_code);
    const placeholder = /\{http\.regexp\.(\w+)\.(\d)\}/g;
    const resolve = (value: string) => value.replace(placeholder, (_placeholder, name: string, group: string) => captures[name][Number(group)]);
    const dial = resolve(handler.upstreams![0].dial);
    if (dial !== "127.0.0.1:9232") return `${handler.transport ? "https" : "http"}://${dial}`;
    const upstreamPort = handler.headers?.request.set["X-Hunt-Upstream-Port"];
    if (!upstreamPort) return "review";
    const isTls = handler.headers!.request.set["X-Hunt-Upstream-Tls"][0] === "true";
    return `review ${isTls ? "https" : "http"}://localhost:${resolve(upstreamPort[0])}`;
  }

  function bodyFor(proxy: CaddyConfig, hostName: string): unknown {
    return routeFor(proxy, hostName).route.handle.at(-1)?.body;
  }

  it("listens on :8080 in plain HTTP behind the gateway, with the admin API on a socket", () => {
    expect(config.admin).toEqual({ listen: "unix//run/hunt-proxy/admin.sock", config: { persist: false } });
    expect(server.listen).toEqual([":8080"]);
    expect(server.protocols).toEqual(["h1"]);
    expect(server.automatic_https).toEqual({ disable: true });
    expect(server.trusted_proxies).toEqual({ source: "static", ranges: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] });
  });

  it("logs every request but the health check as JSON to the access log the idle check reads, the rest as plain lines", () => {
    expect(server.logs).toEqual({ default_logger_name: "preview" });
    expect(config.logging.logs.access).toEqual({
      writer: { output: "file", filename: "/var/log/hunt-proxy/access.log", roll_size_mb: 20, roll_keep: 2 },
      encoder: { format: "json" },
      include: ["http.log.access.preview"],
    });
    expect(config.logging.logs.default).toEqual({
      level: "WARN",
      encoder: { format: "console", level_format: "upper" },
      exclude: ["http.log.access.preview"],
    });
    expect(routeFor(config, "7c0c6f2e-3000.hunt.example.com", "/hunt-healthz").route.handle[0]).toEqual({ handler: "vars", log_skip: true });
  });

  it("passes the desktop client's origins on to the Waymote gateway as the gateway's own origin and refuses every other request", () => {
    const desktop = config.apps.http.servers.desktop;
    expect(desktop.listen).toEqual(["127.0.0.1:9231"]);
    expect(desktop.protocols).toEqual(["h1"]);
    expect(desktop.automatic_https).toEqual({ disable: true });
    expect(desktop.routes).toEqual([
      {
        match: [{ expression: "{http.request.header.Origin} in ['tauri://localhost', 'http://localhost:1420']" }],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: "127.0.0.1:9230" }],
            flush_interval: -1,
            headers: { request: { set: { Host: ["127.0.0.1:9230"], Origin: ["http://127.0.0.1:9230"] } } },
          },
        ],
        terminal: true,
      },
      { handle: [{ handler: "static_response", status_code: 403 }] },
    ]);
  });

  it("ends every route but the last, which answers every other host with 404", () => {
    expect(server.routes.slice(0, -1).every((route) => route.terminal && route.match)).toBe(true);
    expect(server.routes.at(-1)).toEqual({ handle: [{ handler: "static_response", status_code: 404 }] });
  });

  it("serves every port host, the open hosts of the services that are not guarded only, and HTTPS for the services with tls", () => {
    const cases: [string, string][] = [
      ["7c0c6f2e-3000.hunt.example.com", "https://localhost:3000"],
      ["7c0c6f2e-4200.hunt.example.com", "http://localhost:4200"],
      ["7c0c6f2e-4400.hunt.example.com", "https://localhost:4400"],
      ["7c0c6f2e-4800.hunt.example.com", "http://localhost:4800"],
      ["7c0c6f2e-5173.hunt.example.com", "http://localhost:5173"],
      ["7c0c6f2e-3000-open.hunt.example.com", "https://localhost:3000"],
      ["7c0c6f2e-4800-open.hunt.example.com", "http://localhost:4800"],
      ["7c0c6f2e-4200-open.hunt.example.com", "404"],
      ["7c0c6f2e-4400-open.hunt.example.com", "404"],
      ["7c0c6f2e-5173-open.hunt.example.com", "404"],
      ["7c0c6f2e-open.hunt.example.com", "404"],
      ["7c0c6f2e.hunt.example.com", "404"],
      ["8d1d7a3f-3000.hunt.example.com", "404"],
      ["8d1d7a3f-3000-open.hunt.example.com", "404"],
      ["7c0c6f2e-3000-open.hunt.example.com.evil.com", "404"],
      ["7c0c6f2e-2019.hunt.example.com", "403"],
      ["7c0c6f2e-2375.hunt.example.com", "403"],
      ["7c0c6f2e-2376.hunt.example.com", "403"],
      ["7c0c6f2e-5355.hunt.example.com", "403"],
      ["7c0c6f2e-8080.hunt.example.com", "403"],
      ["7c0c6f2e-9222.hunt.example.com", "403"],
      ["7c0c6f2e-9230.hunt.example.com", "403"],
      ["7c0c6f2e-9231.hunt.example.com", "403"],
      ["7c0c6f2e-9232.hunt.example.com", "403"],
      ["7c0c6f2e-20201.hunt.example.com", "403"],
      ["7c0c6f2e-20202.hunt.example.com", "403"],
    ];

    for (const [hostName, expected] of cases) {
      expect(answer(config, hostName), hostName).toBe(expected);
      expect(answer(config, hostName, "/hunt-healthz"), hostName).toBe("200");
    }
    expect(server.routes.filter((route) => JSON.stringify(route.match ?? []).includes("-open.hunt")).map((route) => route.match)).toEqual([
      [{ host: ["7c0c6f2e-3000-open.hunt.example.com"] }],
      [{ host: ["7c0c6f2e-4800-open.hunt.example.com"] }],
    ]);
  });

  it("sends the page loads and /__hunt/ of the port hosts to the review server, not those of open hosts or services with review false", () => {
    const post: Parameters<typeof answer>[3] = { method: "POST", headers: PAGE_LOAD.headers };
    const cases: [string, string, Parameters<typeof answer>[3], string][] = [
      ["7c0c6f2e-4200.hunt.example.com", "/orders", PAGE_LOAD, "review http://localhost:4200"],
      ["7c0c6f2e-4400.hunt.example.com", "/", PAGE_LOAD, "review https://localhost:4400"],
      ["7c0c6f2e-3000.hunt.example.com", "/", PAGE_LOAD, "review https://localhost:3000"],
      ["7c0c6f2e-5173.hunt.example.com", "/", PAGE_LOAD, "review http://localhost:5173"],
      ["7c0c6f2e-4800.hunt.example.com", "/", PAGE_LOAD, "http://localhost:4800"],
      ["7c0c6f2e-3000-open.hunt.example.com", "/", PAGE_LOAD, "https://localhost:3000"],
      ["7c0c6f2e-4800-open.hunt.example.com", "/", PAGE_LOAD, "http://localhost:4800"],
      ["7c0c6f2e-4200.hunt.example.com", "/api/orders", undefined, "http://localhost:4200"],
      ["7c0c6f2e-4400.hunt.example.com", "/main.js", { method: "GET", headers: { Accept: "*/*" } }, "https://localhost:4400"],
      ["7c0c6f2e-4200.hunt.example.com", "/form", post, "http://localhost:4200"],
      ["7c0c6f2e-9232.hunt.example.com", "/", PAGE_LOAD, "403"],
      ["7c0c6f2e-4200.hunt.example.com", "/__hunt/review.js", undefined, "review"],
      ["7c0c6f2e-5173.hunt.example.com", "/__hunt/review", post, "review"],
      ["7c0c6f2e-4800.hunt.example.com", "/__hunt/review.js", undefined, "http://localhost:4800"],
      ["7c0c6f2e-3000-open.hunt.example.com", "/__hunt/review", post, "https://localhost:3000"],
      ["7c0c6f2e-4200-open.hunt.example.com", "/__hunt/review.js", undefined, "404"],
    ];

    for (const [hostName, path, request, expected] of cases) {
      expect(answer(config, hostName, path, request), `${request?.method ?? "GET"} ${hostName}${path}`).toBe(expected);
    }
    expect(answer(proxyConfig([], HOST), "7c0c6f2e-4200.hunt.example.com", "/", PAGE_LOAD)).toBe("review http://localhost:4200");
  });

  it("turns the review server's mark of a port nothing listens on into an error, so that the 503 pages answer", () => {
    const reviewProxies = server.routes
      .flatMap((route) => route.handle)
      .filter((handler) => JSON.stringify(handler.headers ?? {}).includes("X-Hunt-Upstream-Port"));
    expect(reviewProxies).toHaveLength(3);
    for (const handler of reviewProxies) {
      expect(handler.handle_response).toEqual([
        { match: { status_code: [502], headers: { "X-Hunt-Upstream": ["unreachable"] } }, routes: [{ handle: [{ handler: "error", status_code: 502 }] }] },
      ]);
      expect(handler.transport).toBeUndefined();
    }
  });

  it("explains the 404 of the main host and of an open host without a public service", () => {
    expect(bodyFor(config, "7c0c6f2e.hunt.example.com")).toBe(
      "This session has no main page: each service of the repository's hunt.json answers at https://7c0c6f2e-<port>.hunt.example.com.\n",
    );
    expect(bodyFor(config, "7c0c6f2e-4200-open.hunt.example.com")).toBe(
      'This port has no public host: only a service with "guarded": false in the repository\'s hunt.json has one.\n',
    );
    expect(bodyFor(config, "7c0c6f2e-2019.hunt.example.com")).toBe("This port is not served.\n");
  });

  it("explains with a 503 that nothing answers on a port, naming its service on the port host only", () => {
    /** The status and body of the answer to a request to `hostName` whose upstream refused the connection. */
    const refusedAnswer = (proxy: CaddyConfig, hostName: string) => {
      const { route, captures } = routeFor(proxy, hostName, "/", true);
      const handler = route.handle[0] as { handler: string; status_code: number; body: string };
      expect(handler.handler).toBe("static_response");
      const body = handler.body.replace(/\{http\.regexp\.(\w+)\.(\d)\}/g, (_placeholder, name: string, group: string) => captures[name][Number(group)]);
      return `${handler.status_code} ${body}`;
    };
    const uiDown = "503 The service ui is not running, so nothing answers on port 4200. Ask the agent to start it, then reload this page.\n";

    expect(refusedAnswer(config, "7c0c6f2e-4200.hunt.example.com")).toBe(uiDown);
    expect(refusedAnswer(config, "7c0c6f2e-3000.hunt.example.com")).toMatch(/^503 The service backend is not running, so nothing answers on port 3000\./);
    expect(refusedAnswer(config, "7c0c6f2e-4400.hunt.example.com")).toMatch(/^503 The service docs is not running/);
    expect(refusedAnswer(config, "7c0c6f2e-5173.hunt.example.com")).toBe("503 Nothing answers on port 5173 of the session VM.\n");
    expect(refusedAnswer(proxyConfig([], HOST), "7c0c6f2e-4200.hunt.example.com")).toBe("503 Nothing answers on port 4200 of the session VM.\n");
    for (const hostName of ["7c0c6f2e-3000-open.hunt.example.com", "7c0c6f2e-4800-open.hunt.example.com"]) {
      expect(refusedAnswer(config, hostName), hostName).toBe("503 The preview is not running.\n");
    }
    for (const hostName of ["8d1d7a3f-4200.hunt.example.com", "7c0c6f2e.hunt.example.com", "7c0c6f2e-4200.hunt.example.com.evil.com"]) {
      expect(() => routeFor(config, hostName, "/", true), hostName).toThrow("no route");
    }
  });

  it("serves no open host without services that are not guarded", () => {
    const guardedOnly = proxyConfig(
      COMPLETE_SERVICES.map((service) => new ServiceConfig({ ...service.toJSON(), guarded: true })),
      HOST,
    );

    expect(answer(guardedOnly, "7c0c6f2e-3000-open.hunt.example.com")).toBe("404");
    expect(answer(guardedOnly, "7c0c6f2e-3000.hunt.example.com")).toBe("https://localhost:3000");
    expect(answer(proxyConfig([], HOST), "7c0c6f2e-3000.hunt.example.com")).toBe("http://localhost:3000");
  });

  it("keeps the Host header, removes IAP's headers and cookies and flushes every response at once, on the open hosts too", () => {
    const proxies = server.routes.flatMap((route) => route.handle).filter((handler) => handler.handler === "reverse_proxy");
    expect(proxies).toHaveLength(10);
    expect(proxies).toContain(routeFor(config, "7c0c6f2e-3000-open.hunt.example.com").route.handle[0]);
    for (const handler of proxies) {
      expect(handler).toMatchObject({
        handler: "reverse_proxy",
        flush_interval: -1,
        headers: {
          request: {
            set: { Host: ["{http.request.hostport}"] },
            delete: IAP_HEADERS,
            replace: { Cookie: [{ search_regexp: "(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*", replace: "" }] },
          },
        },
      });
    }
    const cookie = new RegExp("(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*", "g");
    expect("a=1; GCP_IAP_UID=u; __Host-GCP_IAP_AUTH_TOKEN_x=t; b=2".replace(cookie, "")).toBe("a=1; b=2");
  });

  it("reaches the services with tls over HTTPS without checking their certificates", () => {
    const { route } = routeFor(config, "7c0c6f2e-4400.hunt.example.com");
    expect(route.handle[0].transport).toEqual({ protocol: "http", tls: { insecure_skip_verify: true } });
  });

  it("takes the port of a port host from its name, from 1024 to 65535 only", () => {
    const portRoute = server.routes.find((route) => JSON.stringify(route.match ?? []).includes('"name":"port"')) as CaddyRoute;
    const portPattern = (portRoute.match![0].vars_regexp as Record<string, HostPattern>)["{http.request.host}"];
    const pattern = new RegExp(portPattern.pattern);
    const portOf = (host: string) => pattern.exec(host)?.[1] ?? null;

    for (const port of [1024, 1029, 1030, 1099, 1100, 1999, 2000, 9999, 10000, 59999, 60000, 64999, 65000, 65499, 65500, 65529, 65530, 65535]) {
      expect(portOf(`7c0c6f2e-${port}.hunt.example.com`)).toBe(String(port));
    }
    for (const port of ["80", "1023", "65536", "70000", "99999", "03000", "100000", "3000-open"]) {
      expect(portOf(`7c0c6f2e-${port}.hunt.example.com`), port).toBeNull();
    }
    expect(portOf("7c0c6f2e.hunt.example.com")).toBeNull();
    expect(portOf("8d1d7a3f-3000.hunt.example.com")).toBeNull();
    expect(portOf("7c0c6f2e-3000.huntxexample.com")).toBeNull();
    expect(portOf("7c0c6f2e-3000.hunt.example.com.evil.com")).toBeNull();
    expect(portOf("x7c0c6f2e-3000.hunt.example.com")).toBeNull();
  });
});

describe("configCli", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A worktree holding `files` by relative path, an empty output folder and the path of a services folder that does not exist yet. */
  function setup(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "hunt-config-"));
    dirs.push(dir);
    const worktree = join(dir, "worktree");
    mkdirSync(worktree);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(worktree, name)), { recursive: true });
      writeFileSync(join(worktree, name), text);
    }
    return { worktree, envOut: join(dir, "session.env"), caddyOut: join(dir, "caddy.json"), servicesDir: join(dir, "services") };
  }

  /** The skill file `.claude/skills/<name>/SKILL.md` of each skill in `names`, for `setup`. */
  function skillFiles(names: readonly string[]): Record<string, string> {
    return Object.fromEntries(names.map((name) => [`.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\n---\n`]));
  }

  /** The problem of the step `step` whose skill `name` has no file in the worktree. */
  function missingSkillFile(step: string, name: string): string {
    return `swf.steps.${step}.skill: no skill file .claude/skills/${name}/SKILL.md; Hunt offers to create it when a session of the repository opens`;
  }

  type Paths = ReturnType<typeof setup>;

  function runCli(paths: Paths, extra: string[] = []) {
    const args = [
      ...["--worktree", paths.worktree, "--short", HOST.short, "--domain", HOST.domain],
      ...["--env-out", paths.envOut, "--caddy-out", paths.caddyOut, "--services-dir", paths.servicesDir, ...extra],
    ];
    const result = spawnSync(process.execPath, [CONFIG_CLI, ...args], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, output: JSON.parse(result.stdout) as unknown, lines: result.stdout.split("\n").length };
  }

  /** The assignments of an environment file, without its header comment. */
  function assignments(text: string): string {
    expect(text).toMatch(/^# \S/);
    return text.slice(text.indexOf("\n") + 1);
  }

  it("writes the environments and the proxy configuration and prints the services, their prompt, hunt.agent.md and the swf settings", () => {
    const huntJson = { ...COMPLETE, swf: { model: "claude-opus-5-5", humanReviewPaths: ["**/migrations/**", "libs/auth/**"], skills: { ...SKILLS, review: "acme-review" } } };
    const paths = setup({
      "hunt.json": JSON.stringify(huntJson),
      "hunt.agent.md": "\n# Services\nStart backend with ui.\n\n",
      "HUNT.md": "Old notes.",
      ...skillFiles(["swf-plan", "swf-implement", "swf-verify", "acme-review", "swf-pr"]),
    });
    const result = runCli(paths);
    const expected = buildSessionConfig(COMPLETE, HOST, paths.worktree);

    expect(result).toEqual({
      status: 0,
      stderr: "",
      output: {
        ok: true,
        services: [
          { name: "backend", port: 3000, tls: true, guarded: false },
          { name: "ui", port: 4200, tls: false, guarded: true },
          { name: "docs", port: 4400, tls: true, guarded: true },
          { name: "admin", port: 4800, tls: false, guarded: false },
        ],
        services_prompt: expected.servicesPrompt,
        agent_md: "# Services\nStart backend with ui.",
        swf_steps: huntJsonOf(huntJson).stepSettings?.toJSON(),
      },
      lines: 2,
    });
    expect(assignments(readFileSync(paths.envOut, "utf8"))).toBe('HUNT_PREVIEW_URL_TEMPLATE="https://7c0c6f2e-{port}.hunt.example.com"\n');
    expect(JSON.parse(readFileSync(paths.caddyOut, "utf8"))).toEqual(expected.proxy);
    expect(readdirSync(paths.servicesDir).sort()).toEqual(["admin.env", "backend.env", "docs.env", "ui.env"]);
    for (const [name, env] of Object.entries(expected.serviceEnvs)) {
      const file = join(paths.servicesDir, `${name}.env`);
      expect(assignments(readFileSync(file, "utf8")), name).toBe(assignments(envFile(env, "x")));
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(paths.servicesDir, "ui.env"), "utf8")).toContain(`HUNT_SERVICE_DIR="${paths.worktree}/apps/ui"\n`);
    expect(statSync(paths.servicesDir).mode & 0o777).toBe(0o755);
    expect(statSync(paths.envOut).mode & 0o777).toBe(0o644);
    expect(statSync(paths.caddyOut).mode & 0o777).toBe(0o644);
  });

  it("reports each agent step whose skill file the worktree lacks when hunt.json has a swf section, and checks none without one", () => {
    const paths = setup({ "hunt.json": JSON.stringify({ ...web({}), swf: { skills: { ...SKILLS, verify: "acme-verify" } } }), ...skillFiles(["swf-plan", "swf-review"]) });
    mkdirSync(join(paths.worktree, ".claude/skills/swf-pr/SKILL.md"), { recursive: true });
    const result = runCli(paths);

    expect(result).toMatchObject({
      status: 1,
      output: {
        ok: false,
        problems: [missingSkillFile("implement", "swf-implement"), missingSkillFile("verify", "acme-verify"), missingSkillFile("pr", "swf-pr")],
      },
    });
    expect(() => statSync(paths.envOut)).toThrow();
    expect(() => statSync(paths.servicesDir)).toThrow();

    const blocked = setup({ "hunt.json": JSON.stringify({ ...web({}), swf: { skills: SKILLS } }), ".claude/skills": "not a folder" });
    expect(runCli(blocked).output).toEqual({ ok: false, problems: AGENT_STEPS.map((step) => missingSkillFile(step, SKILLS[step])) });

    const linked = setup({ "hunt.json": JSON.stringify({ ...web({}), swf: { skills: SKILLS } }), ...skillFiles(["swf-implement", "swf-verify", "swf-review", "swf-pr"]) });
    symlinkSync(join(linked.worktree, ".claude/skills/swf-verify"), join(linked.worktree, ".claude/skills/swf-plan"));
    expect(runCli(linked).output).toMatchObject({ ok: true, swf_steps: { steps: { plan: { skill: "swf-plan" }, pr: { skill: "swf-pr" } } } });

    const withoutSwf = runCli(setup({ "hunt.json": JSON.stringify(web({})) }));
    expect(withoutSwf.status).toBe(0);
    expect(withoutSwf.output).not.toHaveProperty("swf_steps");
  });

  it("reports the agent steps whose skill hunt.json names none for before any skill file is checked", () => {
    const withoutSkills = runCli(setup({ "hunt.json": JSON.stringify({ ...web({}), swf: { model: "claude-opus-5-5" } }), ...skillFiles(["swf-plan"]) }));
    expect(withoutSkills).toMatchObject({ status: 1, output: { ok: false, problems: [`swf.steps: ${SKILLS_RULE}`] } });
    const withoutReview = runCli(setup({ "hunt.json": JSON.stringify({ ...web({}), swf: { skills: { ...SKILLS, review: undefined } } }) }));
    expect(withoutReview.output).toEqual({ ok: false, problems: [`swf.steps.review.skill: ${STEP_SKILL_RULE}`] });
  });

  it("deletes the environment files of services hunt.json no longer declares and keeps every other file", () => {
    const paths = setup({ "hunt.json": JSON.stringify(COMPLETE) });
    mkdirSync(join(paths.servicesDir, "folder.env"), { recursive: true });
    for (const name of ["old.env", "backend.env", "notes.txt", "backend.env.bak"]) {
      writeFileSync(join(paths.servicesDir, name), "STALE=1\n");
    }

    expect(runCli(paths).status).toBe(0);
    expect(readdirSync(paths.servicesDir).sort()).toEqual(["admin.env", "backend.env", "backend.env.bak", "docs.env", "folder.env", "notes.txt", "ui.env"]);
    expect(readFileSync(join(paths.servicesDir, "backend.env"), "utf8")).not.toContain("STALE");
  });

  it("configures a repository without hunt.json and hunt.agent.md with the URL template only and ignores HUNT.md", () => {
    const paths = setup({ "HUNT.md": "Old notes." });
    mkdirSync(paths.servicesDir);
    writeFileSync(join(paths.servicesDir, "web.env"), "STALE=1\n");

    expect(runCli(paths).output).toEqual({ ok: true, services: [], services_prompt: servicesPrompt([], HOST) });
    expect(assignments(readFileSync(paths.envOut, "utf8"))).toBe('HUNT_PREVIEW_URL_TEMPLATE="https://7c0c6f2e-{port}.hunt.example.com"\n');
    expect(readdirSync(paths.servicesDir)).toEqual([]);
  });

  it("prints every problem, writes nothing and exits with 1", () => {
    const paths = setup({ "hunt.json": JSON.stringify(web({ port: 80, extra: 1 })), "hunt.agent.md": "x".repeat(20 * 1024 + 1) });
    const result = runCli(paths);

    expect(result).toMatchObject({
      status: 1,
      output: { ok: false, problems: ["hunt.agent.md: is larger than 20480 bytes", "services.web.extra: unknown field", `services.web.port: ${PORT_RULE}`] },
    });
    expect(() => statSync(paths.envOut)).toThrow();
    expect(() => statSync(paths.caddyOut)).toThrow();
    expect(() => statSync(paths.servicesDir)).toThrow();

    mkdirSync(paths.servicesDir);
    writeFileSync(join(paths.servicesDir, "web.env"), "STALE=1\n");
    expect(runCli(paths).status).toBe(1);
    expect(readdirSync(paths.servicesDir)).toEqual(["web.env"]);
  });

  it("gives the services the remote secrets of --secrets and reports a missing one or an invalid file", () => {
    const huntJson = JSON.stringify(web({ remoteSecrets: { OPENAI_API_KEY: "$MED_OPENAI_API_KEY" } }));
    const paths = setup({ "hunt.json": huntJson });
    const secretsFile = join(paths.worktree, "..", "remote-secrets.json");
    writeFileSync(secretsFile, JSON.stringify({ MED_OPENAI_API_KEY: 'sk-"1"', OTHER: "o" }));
    expect(runCli(paths, ["--secrets", secretsFile]).status).toBe(0);
    const env = readFileSync(join(paths.servicesDir, "web.env"), "utf8");
    expect(env).toContain('\nOPENAI_API_KEY="sk-\\"1\\""\n');
    expect(env).not.toContain("OTHER");

    const missing = setup({ "hunt.json": huntJson });
    expect(runCli(missing).output).toEqual({ ok: false, problems: [MISSING_SECRET] });
    expect(runCli(missing, ["--secrets", join(missing.worktree, "..", "absent.json")]).output).toEqual({ ok: false, problems: [MISSING_SECRET] });
    expect(() => statSync(missing.servicesDir)).toThrow();

    const invalid = setup({});
    const invalidFile = join(invalid.worktree, "..", "remote-secrets.json");
    writeFileSync(invalidFile, '{"lower": "sk-secret"}');
    const result = runCli(invalid, ["--secrets", invalidFile]);
    expect(result.output).toEqual({
      ok: false,
      problems: [`remote secrets: ${invalidFile}: the remote secret "lower" is invalid: the name must match ^[A-Z][A-Z0-9_]{0,63}$`],
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("reports hunt.json that is no JSON, a symlink or no file", () => {
    const invalid = setup({ "hunt.json": "{oops" });
    expect(runCli(invalid).output).toEqual({ ok: false, problems: [expect.stringMatching(/^hunt\.json: not valid JSON: /)] });

    const linked = setup({ "secret.json": JSON.stringify(COMPLETE) });
    symlinkSync(join(linked.worktree, "secret.json"), join(linked.worktree, "hunt.json"));
    symlinkSync("/etc/hosts", join(linked.worktree, "hunt.agent.md"));
    expect(runCli(linked).output).toEqual({
      ok: false,
      problems: ["hunt.json: must be a file, not a symlink", "hunt.agent.md: must be a file, not a symlink"],
    });

    const folder = setup({});
    mkdirSync(join(folder.worktree, "hunt.json"));
    expect(runCli(folder).output).toEqual({ ok: false, problems: ["hunt.json: must be a file"] });
  });

  it("reports invalid host names and missing or unknown arguments", () => {
    const paths = setup({});

    expect(runCli(paths, ["--short", "XYZ"]).output).toEqual({
      ok: false,
      problems: ["short: must be the first 8 hex digits of the session ID, in lowercase"],
    });
    const missing = spawnSync(process.execPath, [CONFIG_CLI, "--worktree", paths.worktree, "--short", HOST.short], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^missing --domain, --env-out, --caddy-out, --services-dir; usage: /)],
    });
    const unknown = spawnSync(process.execPath, [CONFIG_CLI, "--port", "3000"], { encoding: "utf8" });
    expect(JSON.parse(unknown.stdout)).toEqual({ ok: false, problems: [expect.stringMatching(/^unknown argument --port; usage: /)] });
    const valueless = spawnSync(process.execPath, [CONFIG_CLI, "--worktree"], { encoding: "utf8" });
    expect(JSON.parse(valueless.stdout)).toEqual({ ok: false, problems: ["--worktree needs a value"] });
  });

  describe("--check", () => {
    const HUNT_JSON = { version: 3, checks: { format: { command: "npm run format:check" }, test: { command: "npm test", cwd: "apps/web" } } };

    function runCheck(paths: Paths, name: string, extra: string[] = []) {
      const result = spawnSync(process.execPath, [CONFIG_CLI, "--worktree", paths.worktree, "--check", name, ...extra], { encoding: "utf8" });
      return { status: result.status, stderr: result.stderr, output: JSON.parse(result.stdout) as unknown };
    }

    it("prints the command line and folder of the check and writes nothing", () => {
      const paths = setup({ "hunt.json": JSON.stringify(HUNT_JSON), "hunt.agent.md": "x".repeat(20 * 1024 + 1) });

      expect(runCheck(paths, "test")).toEqual({ status: 0, stderr: "", output: { ok: true, command: "npm test", cwd: "apps/web" } });
      expect(runCheck(paths, "format")).toEqual({ status: 0, stderr: "", output: { ok: true, command: "npm run format:check", cwd: null } });
      expect(readdirSync(join(paths.worktree, ".."))).toEqual(["worktree"]);
    });

    it("reports a check hunt.json does not declare, also without hunt.json", () => {
      expect(runCheck(setup({ "hunt.json": JSON.stringify(HUNT_JSON) }), "lint")).toEqual({
        status: 1,
        stderr: "",
        output: { ok: false, problems: ["checks.lint: no such check"] },
      });
      expect(runCheck(setup({}), "test").output).toEqual({ ok: false, problems: ["checks.test: no such check"] });
    });

    it("reports an invalid hunt.json, its symlink and unknown arguments", () => {
      const invalid = setup({ "hunt.json": JSON.stringify({ ...HUNT_JSON, checks: { test: { command: "npm test", port: 3000 } } }) });
      expect(runCheck(invalid, "test")).toMatchObject({ status: 1, output: { ok: false, problems: ["checks.test.port: unknown field"] } });

      const broken = setup({ "hunt.json": "{oops" });
      expect(runCheck(broken, "test").output).toEqual({ ok: false, problems: [expect.stringMatching(/^hunt\.json: not valid JSON: /)] });

      const linked = setup({ "secret.json": JSON.stringify(HUNT_JSON) });
      symlinkSync(join(linked.worktree, "secret.json"), join(linked.worktree, "hunt.json"));
      expect(runCheck(linked, "test").output).toEqual({ ok: false, problems: ["hunt.json: must be a file, not a symlink"] });

      expect(runCheck(linked, "test", ["--short", HOST.short]).output).toEqual({
        ok: false,
        problems: [expect.stringMatching(/^unknown argument --short; usage: /)],
      });
    });
  });
});
