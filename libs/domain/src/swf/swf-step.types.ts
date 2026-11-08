/**
 * The steps of the swf pipeline (`apps/gateway/src/swf/`, `apps/session/src/swf-runner/`) and the state of a poller
 * session's agent. The result an agent posts at the end of a step is `step-result.utils.ts`.
 */

/** The steps an agent turn carries out, in their order; each ends with a step result on the issue. */
export const AGENT_STEPS = ["plan", "implement", "verify", "review", "pr"] as const;
/** The steps the poller carries out itself by watching the pull request, in their order. */
export const POLLER_STEPS = ["human-review", "merge"] as const;
export type AgentStep = (typeof AGENT_STEPS)[number];
export type PollerStep = (typeof POLLER_STEPS)[number];
export type SwfStep = AgentStep | PollerStep;
export const SWF_STEPS = [...AGENT_STEPS, ...POLLER_STEPS] as const;

/**
 * The state of a poller session's agent, as the issue's labels report it and the VM metadata `hunt-agent` records it:
 * the current step, `question` while the agent waits for an answer on the issue, `done` or `failed`.
 */
export type AgentState = SwfStep | "question" | "done" | "failed";

/**
 * The steps of earlier releases that records, labels and hunt.json may still name, each with the step that took its
 * place: `checks` waited for the pull request's CI before human-review, which CI on GitHub and the gates make needless.
 */
export const RETIRED_STEPS: ReadonlyMap<string, SwfStep> = new Map([["checks", "human-review"]]);

/** The step `step` names today: the successor of a retired step, `step` itself otherwise. */
export function currentStepOf(step: string): string {
  return RETIRED_STEPS.get(step) ?? step;
}

export function isAgentStep(step: string): step is AgentStep {
  return (AGENT_STEPS as readonly string[]).includes(step);
}

export function isSwfStep(step: string): step is SwfStep {
  return (SWF_STEPS as readonly string[]).includes(step);
}
