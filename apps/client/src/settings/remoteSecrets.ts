import { REMOTE_SECRET_MAX_VALUE_LENGTH, REMOTE_SECRET_NAME } from "../../../../libs/domain/src/remoteSecrets.ts";

/** What a name the user typed becomes: uppercase, without surrounding whitespace. */
export function normalizeRemoteSecretName(input: string): string {
  return input.trim().toUpperCase();
}

/** Why the gateway would refuse `name`, or null when it accepts it; an empty name asks for nothing yet. */
export function remoteSecretNameProblem(name: string, existing: readonly string[]): string | null {
  if (!name) return null;
  if (!REMOTE_SECRET_NAME.test(name)) {
    return "Start with a letter; use only A–Z, 0–9 and _, at most 64 characters.";
  }
  if (existing.includes(name)) return `${name} exists already; replace its value in the list.`;
  return null;
}

/** Why the gateway would refuse `value`, or null when it accepts it; an empty value asks for nothing yet. The text never repeats the value. */
export function remoteSecretValueProblem(value: string): string | null {
  if (!value) return null;
  if ([...value].length > REMOTE_SECRET_MAX_VALUE_LENGTH) return `The value is longer than ${REMOTE_SECRET_MAX_VALUE_LENGTH} characters.`;
  if (["\n", "\r", "\0"].some((char) => value.includes(char))) return "The value must hold no line break and no NUL character.";
  return null;
}

/** The masked value a list row shows: dots, then the hint (the value's last four characters) when the gateway gave one. */
export function maskedRemoteSecret(hint: string): string {
  return `••••••••${hint}`;
}
