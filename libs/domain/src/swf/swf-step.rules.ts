import * as z from "zod/mini";
import { isRecord } from "../shared/json-rpc.utils.ts";
import { currentStepOf, RETIRED_STEPS, SWF_STEPS } from "./swf-step.types.ts";

/** A step of the pipeline; a retired step (RETIRED_STEPS) that a record of an earlier release names reads as its successor. */
export const ZodSwfStep = z.pipe(
  z.transform((value: unknown) => (typeof value === "string" ? currentStepOf(value) : value)),
  z.enum(SWF_STEPS),
);

/** `schema`, a map keyed by step, with the entries of retired steps (RETIRED_STEPS) that a map of an earlier release holds dropped first. */
export function ZodWithoutRetiredSteps<TSchema extends z.ZodMiniType>(schema: TSchema) {
  return z.pipe(
    z.transform((value: unknown) => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([step]) => !RETIRED_STEPS.has(step))) : value)),
    schema,
  );
}
