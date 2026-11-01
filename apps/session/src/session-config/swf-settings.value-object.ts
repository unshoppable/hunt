import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import {
  DEFAULT_MAX_GATE_RUNS,
  DEFAULT_MAX_RETURNS,
  DEFAULT_MERGE_METHOD,
  DEFAULT_MIN_SEVERITY,
  DEFAULT_PROJECT_STATUS,
  DEFAULT_QUESTION_PREFIX,
  GATED_BY_DEFAULT,
  isReturningStep,
  isScoringStep,
  StepSettings,
  type StepSetting,
} from "../../../../libs/domain/src/swf/step-settings.value-object.ts";
import { AGENT_STEPS, isAgentStep, POLLER_STEPS, SWF_STEPS, type SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import {
  ZodEffort,
  ZodGate,
  ZodMaxGateRuns,
  ZodMaxReturns,
  ZodMergeMethod,
  ZodMinSeverity,
  ZodModelId,
  ZodProjectStatusName,
  ZodQuestionPrefix,
  ZodSkillName,
} from "./hunt-json.rules.ts";

const ZodStepEntry = z.object({
  /** The skill the step's prompt invokes first; an agent step's only, and every agent step names one. */
  skill: z._default(z.nullable(ZodSkillName), null),
  /** An agent step's model; null for the section's. */
  model: z._default(z.nullable(ZodModelId), null),
  /** An agent step's effort; null for the section's. */
  effort: z._default(z.nullable(ZodEffort), null),
  /** A returning step's limit of returns; null for Hunt's (DEFAULT_MAX_RETURNS). */
  maxReturns: z._default(z.nullable(ZodMaxReturns), null),
  /** A scoring step's severity from which a finding sends the pipeline back; null for Hunt's (DEFAULT_MIN_SEVERITY). */
  minSeverity: z._default(z.nullable(ZodMinSeverity), null),
  /** An agent step's gate: `"*"` for every check, the names of checks, or null for Hunt's default (GATED_BY_DEFAULT). */
  gate: z._default(z.nullable(ZodGate), null),
});

const ZodSwfSettingsState = z
  .object({
    /** The model of every agent step that sets none; null for Claude Code's default model. */
    model: z._default(z.nullable(ZodModelId), null),
    /** The effort of every agent step that sets none; null for Claude Code's default effort. */
    effort: z._default(z.nullable(ZodEffort), null),
    /** How often a step's result may fail its gate before the agent escalates. */
    maxGateRuns: z._default(ZodMaxGateRuns, DEFAULT_MAX_GATE_RUNS),
    /** The prefix of the title of an issue with an open question; null for Hunt's (DEFAULT_QUESTION_PREFIX). */
    questionPrefix: z._default(z.nullable(ZodQuestionPrefix), null),
    /** The names of the Status options of the issue's GitHub Projects; null for Hunt's (DEFAULT_PROJECT_STATUS). */
    projectStatus: z._default(z.nullable(z.object({ inProgress: ZodProjectStatusName, inReview: ZodProjectStatusName, done: ZodProjectStatusName })), null),
    /** How the poller merges the pull request; null for Hunt's (DEFAULT_MERGE_METHOD). */
    mergeMethod: z._default(z.nullable(ZodMergeMethod), null),
    /** The steps hunt.json sets, `swf.skills` merged into the agent steps' `skill`. */
    steps: z.partialRecord(z.enum(SWF_STEPS), ZodStepEntry),
  })
  .check(
    z.refine((state) => AGENT_STEPS.every((step) => state.steps[step]?.skill), "every agent step names its skill"),
    z.refine((state) => POLLER_STEPS.every((step) => !hasAgentField(state.steps[step])), "only an agent step has a skill, model, effort or gate"),
    z.refine((state) => SWF_STEPS.every((step) => isReturningStep(step) || !state.steps[step]?.maxReturns), "only a returning step has maxReturns"),
    z.refine((state) => SWF_STEPS.every((step) => isScoringStep(step) || !state.steps[step]?.minSeverity), "only a scoring step has minSeverity"),
  );

type StepEntry = z.infer<typeof ZodStepEntry>;

export interface SwfSettings extends z.infer<typeof ZodSwfSettingsState> {}

/**
 * The `swf` section of hunt.json as far as Hunt reads it, as the file writes it: the settings of the sessions the
 * gateway's poller starts for the repository's issues. `resolve` applies the defaults and yields the StepSettings the
 * VM reports to the poller (`session-config.service.ts`, which also checks that the worktree holds the skill file of
 * every agent step):
 * - `skill`: every agent step's, from `steps.<step>.skill` or its alias `skills.<step>`; a poller step has none.
 * - `model`, `effort`: an agent step's own, else the section's, else null for Claude Code's default; a poller step has none.
 * - `maxReturns`: a returning step's own (RETURNING_STEPS), else DEFAULT_MAX_RETURNS; null for every other step.
 * - `minSeverity`: a scoring step's own (SCORING_STEPS), else DEFAULT_MIN_SEVERITY; null for every other step.
 * - `gate`: the checks an agent step's result must pass, in the order of hunt.json: `"*"` is every check, a list the
 *   checks it names; without one, every check for the steps of GATED_BY_DEFAULT and none for the others. A poller step
 *   has none.
 * - `maxGateRuns`: the section's, else DEFAULT_MAX_GATE_RUNS.
 * - `questionPrefix`, `projectStatus`, `mergeMethod`: the section's, else DEFAULT_QUESTION_PREFIX, DEFAULT_PROJECT_STATUS
 *   and DEFAULT_MERGE_METHOD.
 * The section's `humanReviewPaths` is validated by `hunt-json.value-object.ts` only: the repository's review workflow
 * reads it, not Hunt.
 */
export class SwfSettings extends ValueObject<typeof ZodSwfSettingsState> {
  static readonly schema = ZodSwfSettingsState;

  constructor(value: z.input<typeof ZodSwfSettingsState>) {
    super(value);
  }

  /** The names of checks the gates list; `"*"` lists none. */
  get gateChecks(): string[] {
    return SWF_STEPS.flatMap((step) => {
      const gate = this.steps[step]?.gate;
      return Array.isArray(gate) ? gate : [];
    });
  }

  /** Every step's settings with the defaults applied; `checkNames` are the checks of hunt.json in the order of the file. */
  resolve(checkNames: readonly string[]): StepSettings {
    const steps = Object.fromEntries(SWF_STEPS.map((step) => [step, this.resolveStep(step, checkNames)])) as Record<SwfStep, StepSetting>;
    return new StepSettings({
      maxGateRuns: this.maxGateRuns,
      questionPrefix: this.questionPrefix ?? DEFAULT_QUESTION_PREFIX,
      projectStatus: this.projectStatus ?? DEFAULT_PROJECT_STATUS,
      mergeMethod: this.mergeMethod ?? DEFAULT_MERGE_METHOD,
      steps,
    });
  }

  private resolveStep(step: SwfStep, checkNames: readonly string[]): StepSetting {
    const entry = this.steps[step];
    const maxReturns = isReturningStep(step) ? (entry?.maxReturns ?? DEFAULT_MAX_RETURNS[step]) : null;
    const minSeverity = isScoringStep(step) ? (entry?.minSeverity ?? DEFAULT_MIN_SEVERITY) : null;
    if (!isAgentStep(step)) return { skill: null, model: null, effort: null, maxReturns, minSeverity, gate: [] };
    const gate = entry?.gate ?? (GATED_BY_DEFAULT.includes(step) ? "*" : []);
    return {
      skill: entry?.skill ?? null,
      model: entry?.model ?? this.model,
      effort: entry?.effort ?? this.effort,
      maxReturns,
      minSeverity,
      gate: gate === "*" ? [...checkNames] : checkNames.filter((name) => gate.includes(name)),
    };
  }
}

function hasAgentField(entry: StepEntry | undefined): boolean {
  return entry !== undefined && [entry.skill, entry.model, entry.effort, entry.gate].some((value) => value !== null);
}
