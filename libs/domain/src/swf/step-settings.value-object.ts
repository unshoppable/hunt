import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { MAX_SEVERITY, MIN_SEVERITY } from "./step-result.utils.ts";
import { ZodCurrentStepKeys } from "./swf-step.rules.ts";
import { AGENT_STEPS, SWF_STEPS, type AgentStep, type SwfStep } from "./swf-step.types.ts";

/** The effort levels of Claude Code, the values of its `effort` config option. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The steps that send the pipeline back to implement, each with a limit of returns (`maxReturns`) after which the agent escalates. */
export const RETURNING_STEPS = ["verify", "review", "pr-gate", "merge"] as const;
export type ReturningStep = (typeof RETURNING_STEPS)[number];
/** Hunt's limit of returns per returning step, for a repository whose hunt.json sets none. */
export const DEFAULT_MAX_RETURNS: Record<ReturningStep, number> = { verify: 5, review: 3, "pr-gate": 3, merge: 2 };
/** Hunt's limit of gate runs of one step result (`swf.maxGateRuns`) after which the agent escalates. */
export const DEFAULT_MAX_GATE_RUNS = 5;
/** The steps whose gate is every check of hunt.json unless the repository sets one. */
export const GATED_BY_DEFAULT: readonly AgentStep[] = ["implement"];

export function isReturningStep(step: string): step is ReturningStep {
  return (RETURNING_STEPS as readonly string[]).includes(step);
}

/**
 * The steps whose findings carry a severity (`step-result.utils.ts`); only a finding at or above the step's
 * `minSeverity` sends the pipeline back to implement, the others stay in the step result as suggestions.
 */
export const SCORING_STEPS = ["verify", "review"] as const;
export type ScoringStep = (typeof SCORING_STEPS)[number];
/** Hunt's `minSeverity` of a scoring step, for a repository whose hunt.json sets none: a guardrail violation and worse return. */
export const DEFAULT_MIN_SEVERITY = 3;

export function isScoringStep(step: string): step is ScoringStep {
  return (SCORING_STEPS as readonly string[]).includes(step);
}

/** The ways GitHub merges a pull request, the values of `swf.mergeMethod`. */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
/** Hunt's merge method, for a repository whose hunt.json sets none. */
export const DEFAULT_MERGE_METHOD: MergeMethod = "squash";
/** Hunt's prefix of the title of an issue with an open question (`swf.questionPrefix`), for a repository whose hunt.json sets none. */
export const DEFAULT_QUESTION_PREFIX = "❓ RÜCKFRAGE";
/** Hunt's names of the Status options of the issue's GitHub Projects (`swf.projectStatus`), for a repository whose hunt.json sets none. */
export const DEFAULT_PROJECT_STATUS = { inProgress: "In Progress", inReview: "In Review", done: "Done" } as const;

const ZodProjectStatus = z.object({
  /** The status of an issue the poller claimed. */
  inProgress: z.string().check(z.minLength(1)),
  /** The status of an issue whose pull request is open, from the first poll after it opened. */
  inReview: z.string().check(z.minLength(1)),
  /** The status of an issue whose pull request is merged. */
  done: z.string().check(z.minLength(1)),
});
export type ProjectStatus = z.infer<typeof ZodProjectStatus>;

const ZodStepSetting = z.object({
  /** The skill the step's prompt invokes first; null for a poller step. */
  skill: z.nullable(z.string().check(z.minLength(1))),
  /** The `model` config option of the step's conversation; null for Claude Code's default. */
  model: z.nullable(z.string().check(z.minLength(1))),
  /** The `effort` config option of the step's conversation; null for Claude Code's default. */
  effort: z.nullable(z.enum(EFFORTS)),
  /** How often the step may send the pipeline back to implement before the agent escalates; null for a step that never does. */
  maxReturns: z.nullable(z.int().check(z.minimum(1))),
  /**
   * The severity from which a finding of the step sends the pipeline back to implement; null for a step whose findings
   * carry none. Defaults to null so that records and `swf_steps` of VMs written before the field parse.
   */
  minSeverity: z._default(z.nullable(z.int().check(z.minimum(MIN_SEVERITY), z.maximum(MAX_SEVERITY))), null),
  /** The checks of hunt.json that must pass before the step's result is accepted, in the order of hunt.json; empty for no gate. */
  gate: z.array(z.string().check(z.minLength(1))),
});
export type StepSetting = z.infer<typeof ZodStepSetting>;

const ZodStepSettingsState = z.object({
  /** How often a step's result may fail its gate before the agent escalates. */
  maxGateRuns: z.int().check(z.minimum(1)),
  /**
   * The repository's workflow settings: the prefix of the title of an issue with an open question, the names of the
   * Status options of the issue's GitHub Projects and the way its pull request is merged. Each defaults so that records
   * and `swf_steps` of VMs written before the field parse.
   */
  questionPrefix: z._default(z.string().check(z.minLength(1)), DEFAULT_QUESTION_PREFIX),
  projectStatus: z._default(ZodProjectStatus, DEFAULT_PROJECT_STATUS),
  mergeMethod: z._default(z.enum(MERGE_METHODS), DEFAULT_MERGE_METHOD),
  /** Every step's settings, defaults applied; the settings of a retired step that an earlier release reported are dropped. */
  steps: ZodCurrentStepKeys(z.record(z.enum(SWF_STEPS), ZodStepSetting)),
});

export interface StepSettings extends z.infer<typeof ZodStepSettingsState> {}

/**
 * The settings of the swf pipeline, resolved from the `swf` section of the repository's hunt.json
 * (`apps/session/src/session-config/swf-settings.value-object.ts` resolves them; `hunt-ctl session-config` reports them
 * as `swf_steps`): per step the skill, model and effort of each agent step, the limit of returns of each returning
 * step, the severity from which a finding of verify or the review step returns and the gate checks of each agent step;
 * for the pipeline the limit of gate runs and the repository's workflow settings (`questionPrefix`, `projectStatus`,
 * `mergeMethod`). The pipeline record keeps them (`pipeline.domain.ts`), so that the runner and the poller read them
 * from the record, not from hunt.json again.
 */
export class StepSettings extends ValueObject<typeof ZodStepSettingsState> {
  static readonly schema = ZodStepSettingsState;

  constructor(value: z.input<typeof ZodStepSettingsState>) {
    super(value);
  }

  /** The settings of `step`. */
  of(step: SwfStep): StepSetting {
    return this.steps[step];
  }

  /** The skill of the agent step `step`; throws for a step without one, which cannot happen for a settings the VM reported. */
  skillOf(step: AgentStep): string {
    const skill = this.steps[step].skill;
    if (skill === null) throw new Error(`the step ${step} names no skill`);
    return skill;
  }

  /** The limit of returns of `step`; null for a step that never sends the pipeline back. */
  limitOf(step: SwfStep): number | null {
    return this.steps[step].maxReturns;
  }

  /** The severity from which a finding of the scoring step `step` sends the pipeline back; DEFAULT_MIN_SEVERITY for settings reported without one. */
  minSeverityOf(step: ScoringStep): number {
    return this.steps[step].minSeverity ?? DEFAULT_MIN_SEVERITY;
  }

  /** The config options of the agent step `step`'s conversation: `model` and `effort` where set. */
  configOptionsOf(step: AgentStep): Record<string, string> {
    const { model, effort } = this.steps[step];
    return { ...(model === null ? {} : { model }), ...(effort === null ? {} : { effort }) };
  }

  /** The steps whose skill is missing; empty for settings the VM reported. */
  get stepsWithoutSkill(): AgentStep[] {
    return AGENT_STEPS.filter((step) => this.steps[step].skill === null);
  }
}
