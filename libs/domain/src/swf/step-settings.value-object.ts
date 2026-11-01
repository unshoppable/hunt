import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { AGENT_STEPS, SWF_STEPS, type AgentStep, type SwfStep } from "./swf-step.types.ts";

/** The effort levels of Claude Code, the values of its `effort` config option. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The steps that send the pipeline back to implement, each with a limit of returns (`maxReturns`) after which the agent escalates. */
export const RETURNING_STEPS = ["verify", "review", "checks", "human-review", "merge"] as const;
export type ReturningStep = (typeof RETURNING_STEPS)[number];
/** Hunt's limit of returns per returning step, for a repository whose hunt.json sets none. */
export const DEFAULT_MAX_RETURNS: Record<ReturningStep, number> = { verify: 5, review: 3, checks: 2, "human-review": 3, merge: 2 };
/** Hunt's limit of gate runs of one step result (`swf.maxGateRuns`) after which the agent escalates. */
export const DEFAULT_MAX_GATE_RUNS = 5;
/** The steps whose gate is every check of hunt.json unless the repository sets one. */
export const GATED_BY_DEFAULT: readonly AgentStep[] = ["implement"];

export function isReturningStep(step: string): step is ReturningStep {
  return (RETURNING_STEPS as readonly string[]).includes(step);
}

const ZodStepSetting = z.object({
  /** The skill the step's prompt invokes first; null for a poller step. */
  skill: z.nullable(z.string().check(z.minLength(1))),
  /** The `model` config option of the step's conversation; null for Claude Code's default. */
  model: z.nullable(z.string().check(z.minLength(1))),
  /** The `effort` config option of the step's conversation; null for Claude Code's default. */
  effort: z.nullable(z.enum(EFFORTS)),
  /** How often the step may send the pipeline back to implement before the agent escalates; null for a step that never does. */
  maxReturns: z.nullable(z.int().check(z.minimum(1))),
  /** The checks of hunt.json that must pass before the step's result is accepted, in the order of hunt.json; empty for no gate. */
  gate: z.array(z.string().check(z.minLength(1))),
});
export type StepSetting = z.infer<typeof ZodStepSetting>;

const ZodStepSettingsState = z.object({
  /** How often a step's result may fail its gate before the agent escalates. */
  maxGateRuns: z.int().check(z.minimum(1)),
  /** Every step's settings, defaults applied. */
  steps: z.record(z.enum(SWF_STEPS), ZodStepSetting),
});

export interface StepSettings extends z.infer<typeof ZodStepSettingsState> {}

/**
 * The settings of every step of the swf pipeline, resolved from the `swf` section of the repository's hunt.json
 * (`apps/session/src/session-config/swf-settings.value-object.ts` resolves them; `hunt-ctl session-config` reports them
 * as `swf_steps`): the skill, model and effort of each agent step, the limit of returns of each returning step, the
 * gate checks of each agent step and the limit of gate runs. The pipeline record keeps them (`pipeline.domain.ts`), so
 * that the runner and the poller read them from the record, not from hunt.json again.
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
