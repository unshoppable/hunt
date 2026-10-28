import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { ZodSingleLine } from "../shared/text.rules.ts";

/** The name of a remote secret, which hunt.json references as `$<NAME>`. */
export const REMOTE_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The most characters (code points) a value may have. */
export const REMOTE_SECRET_MAX_VALUE_LENGTH = 8192;
/** Below this length a value shows no hint at all. */
const HINT_MIN_VALUE_LENGTH = 12;
const HINT_LENGTH = 4;
const NAME_RULE = `the name must match ${REMOTE_SECRET_NAME.source}`;
const VALUE_RULE = "the value must be a non-empty string";

const ZodRemoteSecretName = z.string({ error: NAME_RULE }).check(z.regex(REMOTE_SECRET_NAME, NAME_RULE));
const ZodRemoteSecretValue = z.string({ error: VALUE_RULE }).check(
  z.minLength(1, VALUE_RULE),
  z.refine((value) => [...value].length <= REMOTE_SECRET_MAX_VALUE_LENGTH, `the value must have at most ${REMOTE_SECRET_MAX_VALUE_LENGTH} characters`),
  ZodSingleLine("the value must be a single line"),
);
const ZodRemoteSecretState = z.object({ name: ZodRemoteSecretName, value: ZodRemoteSecretValue });

/** A remote secret as `secrets.list` reports it: its name and at most the last four characters of its value. */
export interface RemoteSecretSummary {
  name: string;
  hint: string;
}

export interface RemoteSecret extends z.infer<typeof ZodRemoteSecretState> {}

/**
 * A remote secret: a value such as an API key that a person stores in Hunt (Settings → Remote VM) and the services of a
 * session VM receive. A problem with a name or value never quotes the value.
 */
export class RemoteSecret extends ValueObject<typeof ZodRemoteSecretState> {
  static readonly schema = ZodRemoteSecretState;

  constructor(value: z.input<typeof ZodRemoteSecretState>) {
    super(value);
  }

  /** Why `name` cannot name a remote secret, or null. */
  static nameProblem(name: unknown): string | null {
    return firstProblem(ZodRemoteSecretName, name);
  }

  /** Why `value` cannot be the value of a remote secret, or null. */
  static valueProblem(value: unknown): string | null {
    return firstProblem(ZodRemoteSecretValue, value);
  }

  /** The last four characters of the value, or nothing for a value shorter than 12 characters. */
  get hint(): string {
    return this.value.length < HINT_MIN_VALUE_LENGTH ? "" : this.value.slice(-HINT_LENGTH);
  }

  summary(): RemoteSecretSummary {
    return { name: this.name, hint: this.hint };
  }
}

function firstProblem(schema: z.ZodMiniType, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? "invalid");
}
