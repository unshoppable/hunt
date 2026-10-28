import * as z from "zod/mini";

/** A line break or NUL, none of which a single-line value holds. */
const LINE_BREAK = /[\n\r\0]/;

/** The check that a string is a single line: no line break and no NUL; `message` is the problem it reports otherwise. */
export function ZodSingleLine(message: string): z.core.$ZodCheck<string> {
  return z.refine((text: string) => !LINE_BREAK.test(text), message);
}
