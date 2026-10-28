import * as z from "zod/mini";

const SESSION_SHORT_ID = /^[0-9a-f]{8}$/;
const SESSION_SHORT_ID_RULE = "must be the first 8 hex digits of the session ID, in lowercase";

/** The short ID of a session: the first 8 hex digits of its ID, in lowercase, which name its VM and its preview hosts. */
export const ZodSessionShortId = z.string({ error: SESSION_SHORT_ID_RULE }).check(z.regex(SESSION_SHORT_ID, SESSION_SHORT_ID_RULE));
