/** Test doubles the tests of the swf slice share. Imported by tests only. */
import { Pipeline, type SwfIssue } from "./pipeline.domain.ts";
import type { AgentStep } from "./swf-step.types.ts";

/** The skill of every agent step as a repository names them under `swf.skills` of its hunt.json, here `swf-<step>`. */
export const SKILLS: Record<AgentStep, string> = { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", review: "swf-review", pr: "swf-pr" };
/** The issue acme/app#12 on the branch the poller derives from its title "Issue 12". */
export const ISSUE: SwfIssue = { repo: "acme/app", number: 12, branch: "feat/general/12-issue-12" };

/** The pipeline of ISSUE as the poller starts it at `now`, with `skills`. */
export function started(now: number, skills: Record<AgentStep, string> = SKILLS): Pipeline {
  return Pipeline.start(ISSUE, skills, now);
}
