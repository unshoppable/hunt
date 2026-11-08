import * as z from "zod/mini";
import { isRecord } from "../shared/json-rpc.utils.ts";
import { currentStepOf, RENAMED_STEPS, RETIRED_STEPS, SWF_STEPS } from "./swf-step.types.ts";

/** A step of the pipeline; a retired step that a record of an earlier release names reads as its successor. */
export const ZodSwfStep = z.pipe(
  z.transform((value: unknown) => (typeof value === "string" ? currentStepOf(value) : value)),
  z.enum(SWF_STEPS),
);

/**
 * `schema`, a map keyed by step, with the keys of an earlier release brought up to date first: the entry of a renamed
 * step (RENAMED_STEPS) moves to its successor unless that has one of its own, the entry of any other retired step
 * (RETIRED_STEPS) is dropped.
 */
export function ZodCurrentStepKeys<TSchema extends z.ZodMiniType>(schema: TSchema) {
  return z.pipe(z.transform((value: unknown) => (isRecord(value) ? withCurrentStepKeys(value) : value)), schema);
}

function withCurrentStepKeys(map: Record<string, unknown>): Record<string, unknown> {
  const current: Record<string, unknown> = {};
  for (const [step, entry] of Object.entries(map)) {
    const successor = RENAMED_STEPS.get(step);
    if (successor !== undefined) {
      if (!(successor in map)) current[successor] = entry;
    } else if (!RETIRED_STEPS.has(step)) {
      current[step] = entry;
    }
  }
  return current;
}
