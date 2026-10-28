/**
 * The steps of the poller's issue workflow (`apps/gateway/src/swf/`), the state of a poller session's agent and the risk
 * a gate step reports. The result an agent posts at the end of a step is `step-result.utils.ts`.
 */

/** The steps an agent turn carries out, in their order; each ends with a step result on the issue. */
export const AGENT_STEPS = ["plan", "implement", "verify", "gate", "pr"] as const;
/** The steps the poller carries out itself by watching the pull request, in their order. */
export const POLLER_STEPS = ["review", "human-review", "merge"] as const;
export type AgentStep = (typeof AGENT_STEPS)[number];
export type PollerStep = (typeof POLLER_STEPS)[number];
export type SwfStep = AgentStep | PollerStep;
export const SWF_STEPS = [...AGENT_STEPS, ...POLLER_STEPS] as const;

/**
 * The state of a poller session's agent, as the issue's labels report it and the VM metadata `hunt-agent` records it:
 * the current step, `question` while the agent waits for an answer on the issue, `done` or `failed`.
 */
export type AgentState = SwfStep | "question" | "done" | "failed";

export function isAgentStep(step: string): step is AgentStep {
  return (AGENT_STEPS as readonly string[]).includes(step);
}

export function isSwfStep(step: string): step is SwfStep {
  return (SWF_STEPS as readonly string[]).includes(step);
}

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];
