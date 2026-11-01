/**
 * The result an agent reports at the end of one of its steps: `.hunt/swf/result.md` of the worktree, which the runner on
 * the session VM reads; it carries `<!-- hunt:step {…} -->` on a line of its own (see
 * `libs/domain/prompts/swf/0-system-prompt.md`).
 */
import { BranchName } from "../session/branch-name.value-object.ts";
import { isRecord } from "../shared/json-rpc.utils.ts";
import { AGENT_STEPS } from "./swf-step.types.ts";

/**
 * A finding of verify or the review step: what is wrong and where, with its severity on the scale of the step's prompt
 * (MIN_SEVERITY to MAX_SEVERITY: 5 security, 4 bug or unmet requirement, 3 guardrail violation or missing test, 2
 * duplication, leftovers or scope, 1 style); null for a finding written as a plain string, which Hunt treats as
 * returning whatever the step's `minSeverity` (`step-settings.value-object.ts`).
 */
export type Finding = { text: string; severity: number | null };

/** What the agent reports at the end of a step; the file that carries it holds the human-readable part. */
export type StepResult =
  /** `branch` is the session's branch, which the plan step created from the default branch and pushed. */
  | { step: "plan"; branch: string }
  | { step: "implement"; summary: string }
  | { step: "verify"; findings: Finding[] }
  | { step: "review"; findings: Finding[] }
  | { step: "pr"; pullRequest: number };

/** `<!-- hunt:step {…} -->` anywhere in a text; the JSON object is the first group. */
const STEP_MARKER = /<!--\s*hunt:step\s+(\{[\s\S]*?\})\s*-->/g;
/** The longest text of a finding or a summary that is kept; longer ones are cut. */
export const TEXT_LIMIT = 2000;
/** How many findings of one result are kept. */
export const LIST_LIMIT = 20;
/** The severity scale of a finding: 1 (a suggestion) to 5 (a security issue). */
export const MIN_SEVERITY = 1;
export const MAX_SEVERITY = 5;

export type ParsedStepResult = { result: StepResult; problem?: undefined } | { result?: undefined; problem: string };

/** Whether `text` carries a step marker at all, valid or not. */
export function hasStepMarker(text: string): boolean {
  return new RegExp(STEP_MARKER.source).test(text);
}

/**
 * The step result of the last `<!-- hunt:step {…} -->` marker in `text`, or why it is unusable; null without a marker.
 * Texts are cut to TEXT_LIMIT characters, lists to LIST_LIMIT entries.
 */
export function parseStepResult(text: string): ParsedStepResult | null {
  const matches = [...text.matchAll(new RegExp(STEP_MARKER.source, "g"))];
  if (matches.length === 0) return null;
  const json = matches[matches.length - 1][1];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { problem: `the step marker holds no JSON object: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(value) || typeof value.step !== "string") return { problem: "the step marker holds no object with a step" };
  switch (value.step) {
    case "plan":
      if (typeof value.branch !== "string" || !BranchName.isValid(value.branch)) {
        return { problem: "branch of a plan result must be the name of the branch you created and pushed, as git check-ref-format --branch accepts it" };
      }
      return { result: { step: "plan", branch: value.branch } };
    case "implement":
      return { result: { step: "implement", summary: textOf(value.summary) } };
    case "verify":
    case "review":
      return findingsResult(value.step, value.findings);
    case "pr": {
      if (typeof value.pullRequest !== "number" || !Number.isInteger(value.pullRequest) || value.pullRequest <= 0) {
        return { problem: "pullRequest of a pr result must be the number of the pull request" };
      }
      return { result: { step: "pr", pullRequest: value.pullRequest } };
    }
    default:
      return { problem: `unknown step ${JSON.stringify(value.step)}; the agent steps are ${AGENT_STEPS.join(", ")}` };
  }
}

/** The result of a step that reports `findings` (verify, review): a missing list means none, anything else but a list is unusable. */
function findingsResult(step: "verify" | "review", findings: unknown): ParsedStepResult {
  if (findings !== undefined && !Array.isArray(findings)) return { problem: `findings of a ${step} result must be a list` };
  return { result: { step, findings: findingsOf(findings) } };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, TEXT_LIMIT) : "";
}

/**
 * The findings of `value`, each `{"text", "severity"}` or a plain string (severity null), texts cut to TEXT_LIMIT, at
 * most LIST_LIMIT of them; an entry without a text and anything that is no list give none. A severity that is no
 * integer of the scale is null.
 */
function findingsOf(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): Finding | null => {
      if (typeof entry === "string") return entry.trim() === "" ? null : { text: entry.trim().slice(0, TEXT_LIMIT), severity: null };
      if (!isRecord(entry) || typeof entry.text !== "string" || entry.text.trim() === "") return null;
      return { text: entry.text.trim().slice(0, TEXT_LIMIT), severity: severityOf(entry.severity) };
    })
    .filter((finding): finding is Finding => finding !== null)
    .slice(0, LIST_LIMIT);
}

function severityOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_SEVERITY && value <= MAX_SEVERITY ? value : null;
}
