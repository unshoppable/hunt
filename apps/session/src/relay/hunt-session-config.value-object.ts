/**
 * `hunt-session.json`, written by Hunt before the relay starts: the conversation the relay loads (`null` starts a new
 * one), its working directory, the system prompt addition and the mode and config options to restore. The relay reads
 * it and writes back the ID of a new conversation and every mode or config option a client changes
 * (`hunt-session-config.utils.ts`).
 */
import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";

export const DEFAULT_MODE_ID = "bypassPermissions";

const ZodHuntSessionConfigState = z.object(
  {
    cwd: z.string({ error: "must be a non-empty string" }).check(z.minLength(1, "must be a non-empty string")),
    /** The conversation to load; null starts a new one. */
    acpSessionId: z._default(z.nullable(z.string({ error: "must be a string or null" })), null),
    systemPromptAppend: z._default(z.string({ error: "must be a string" }), ""),
    modeId: z._default(z.string({ error: "must be a string" }), DEFAULT_MODE_ID),
    /** Config option values by option ID (`model`, `effort`, …), applied in this order. */
    configOptions: z._default(z.record(z.string(), z.string({ error: "must be a string" }), { error: "must be an object" }), () => ({})),
  },
  { error: "expected a JSON object" },
);

export interface HuntSessionConfig extends z.infer<typeof ZodHuntSessionConfigState> {}

/** The session the relay starts with, as `hunt-session.json` describes it; fields the relay does not know are ignored. */
export class HuntSessionConfig extends ValueObject<typeof ZodHuntSessionConfigState> {
  static readonly schema = ZodHuntSessionConfigState;

  constructor(value: z.input<typeof ZodHuntSessionConfigState>) {
    super(value);
  }

  /** The config in the file's text; throws the first rule it breaks, as `<field> <rule>`. */
  static fromJson(text: string): HuntSessionConfig {
    const parsed = ZodHuntSessionConfigState.safeParse(withoutFalsyFields(JSON.parse(text)));
    if (!parsed.success) throw new Error(problemOf(parsed.error.issues[0]));
    return new HuntSessionConfig(parsed.data);
  }
}

/** The file's object without the fields whose value is falsy: the file may hold an optional field as null or "" alike. */
function withoutFalsyFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field));
}

/** `<path> <message>` of a zod issue, its path joined with dots; the message alone for the file as a whole. */
function problemOf(issue: z.core.$ZodIssue): string {
  return issue.path.length ? `${issue.path.join(".")} ${issue.message}` : issue.message;
}
