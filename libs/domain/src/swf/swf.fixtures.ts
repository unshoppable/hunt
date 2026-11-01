/** Test doubles the tests of the swf slice share. Imported by tests only. */
import { Pipeline, type SwfIssue } from "./pipeline.domain.ts";
import { DEFAULT_MAX_GATE_RUNS, DEFAULT_MAX_RETURNS, DEFAULT_MIN_SEVERITY, isReturningStep, isScoringStep, StepSettings, type StepSetting } from "./step-settings.value-object.ts";
import { isAgentStep, SWF_STEPS, type AgentStep, type SwfStep } from "./swf-step.types.ts";

/** The skill of every agent step as a repository names them under `swf.steps.<step>.skill` of its hunt.json, here `swf-<step>`. */
export const SKILLS: Record<AgentStep, string> = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", review: "swf-review", pr: "swf-pr" };
/** The gate of implement in SETTINGS: the checks `lint` and `test` of hunt.json. */
export const IMPLEMENT_GATE = ["lint", "test"];
/** The issue acme/app#12 with the branch its plan step reported (the poller starts a pipeline with an empty branch). */
export const ISSUE: SwfIssue = { repo: "acme/app", number: 12, branch: "feat/general/12-issue-12" };

/** The settings of `step` in SETTINGS: its skill of SKILLS, Claude Code's model and effort, Hunt's limit of returns and minSeverity, and IMPLEMENT_GATE for implement. */
function defaultSetting(step: SwfStep): StepSetting {
  return {
    skill: isAgentStep(step) ? SKILLS[step] : null,
    model: null,
    effort: null,
    maxReturns: isReturningStep(step) ? DEFAULT_MAX_RETURNS[step] : null,
    minSeverity: isScoringStep(step) ? DEFAULT_MIN_SEVERITY : null,
    gate: step === "implement" ? IMPLEMENT_GATE : [],
  };
}

/** SETTINGS with `steps` merged into the settings of their steps and `maxGateRuns` where given. */
export function settingsWith(steps: Partial<Record<SwfStep, Partial<StepSetting>>> = {}, maxGateRuns = DEFAULT_MAX_GATE_RUNS): StepSettings {
  const entries = SWF_STEPS.map((step) => [step, { ...defaultSetting(step), ...steps[step] }]);
  return new StepSettings({ maxGateRuns, steps: Object.fromEntries(entries) as Record<SwfStep, StepSetting> });
}

/** The step settings of a repository that names SKILLS and leaves everything else to Hunt's defaults, with implement gated by IMPLEMENT_GATE. */
export const SETTINGS: StepSettings = settingsWith();

/** The pipeline of ISSUE as the poller starts it at `now`, with `settings`. */
export function started(now: number, settings: StepSettings = SETTINGS): Pipeline {
  return Pipeline.start(ISSUE, settings, now);
}
