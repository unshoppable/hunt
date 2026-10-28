/** Test doubles the tests of the swf slice share. Imported by tests only. */
import type { AgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";

/** The skill of every agent step as a repository names them under `swf.skills` of its hunt.json, here `swf-<step>`. */
export const SKILLS: Record<AgentStep, string> = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", gate: "swf-gate", pr: "swf-pr" };
