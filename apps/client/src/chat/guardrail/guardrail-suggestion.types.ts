/** Why the user declined a guardrail the agent suggested (`DeclineReason` in `agent/declined_guardrails.rs`). */
export type GuardrailDeclineReason = "tooSpecific" | "alreadyRecorded" | "notWanted";
