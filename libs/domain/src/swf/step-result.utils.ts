/**
 * The result an agent reports at the end of one of its steps, as an issue comment that carries `<!-- hunt:step {…} -->`
 * on a line of its own (see `apps/gateway/software-factory/0-system-prompt.md`).
 */
import { isRecord } from "../shared/json-rpc.utils.ts";
import { AGENT_STEPS, RISKS, type Risk } from "./swf-step.types.ts";

/** What the agent reports at the end of a step; the comment that carries it holds the human-readable part. */
export type StepResult =
  | { step: "plan" }
  | { step: "implement"; summary: string }
  | { step: "verify"; findings: string[] }
  | { step: "gate"; humanReview: boolean; risk: Risk; reasons: string[] }
  | { step: "pr"; pullRequest: number };

/** `<!-- hunt:step {…} -->` anywhere in a comment; the JSON object is the first group. */
const STEP_MARKER = /<!--\s*hunt:step\s+(\{[\s\S]*?\})\s*-->/g;
/** The longest text of a finding, a summary or a reason that is kept; longer ones are cut. */
export const TEXT_LIMIT = 2000;
/** How many findings or reasons of one result are kept. */
export const LIST_LIMIT = 20;

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
      return { result: { step: "plan" } };
    case "implement":
      return { result: { step: "implement", summary: textOf(value.summary) } };
    case "verify": {
      if (value.findings !== undefined && !Array.isArray(value.findings)) return { problem: "findings of a verify result must be a list" };
      return { result: { step: "verify", findings: listOf(value.findings) } };
    }
    case "gate": {
      if (typeof value.humanReview !== "boolean") return { problem: "humanReview of a gate result must be true or false" };
      if (typeof value.risk !== "string" || !(RISKS as readonly string[]).includes(value.risk)) {
        return { problem: `risk of a gate result must be one of ${RISKS.join(", ")}` };
      }
      return { result: { step: "gate", humanReview: value.humanReview, risk: value.risk as Risk, reasons: listOf(value.reasons) } };
    }
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

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, TEXT_LIMIT) : "";
}

/** The strings of `value` cut to TEXT_LIMIT, at most LIST_LIMIT of them; anything that is no list gives none. */
function listOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(0, LIST_LIMIT)
    .map((entry) => entry.trim().slice(0, TEXT_LIMIT));
}
