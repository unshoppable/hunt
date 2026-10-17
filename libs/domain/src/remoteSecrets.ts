/**
 * Remote secrets: values such as API keys that a person stores in Hunt (Settings → Remote VM) and the services of a
 * session VM receive. The gateway keeps all of them as one JSON object `{ "<NAME>": "<value>" }` in the latest version
 * of the Secret Manager secret `HUNT_REMOTE_SECRETS` and puts that object on every session VM it brings up; a service
 * of a repository's hunt.json names the ones it needs (`"remoteSecrets": { "OPENAI_API_KEY": "$MED_OPENAI_API_KEY" }`).
 */
import { isRecord } from "./jsonRpc.ts";

/** The Secret Manager secret whose latest version holds every remote secret. */
export const REMOTE_SECRETS_SECRET = "HUNT_REMOTE_SECRETS";
/** The name of a remote secret, which hunt.json references as `$<NAME>`. */
export const REMOTE_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The most characters (code points) a value may have. */
export const REMOTE_SECRET_MAX_VALUE_LENGTH = 8192;
export const MAX_REMOTE_SECRETS = 256;
/** Below this length a value shows no hint at all. */
const HINT_MIN_VALUE_LENGTH = 12;
const HINT_LENGTH = 4;
const LINE_BREAK = /[\n\r\0]/;

/** A remote secret as `secrets.list` reports it: its name and at most the last four characters of its value. */
export interface RemoteSecretSummary {
  name: string;
  hint: string;
}

/** Why `name` cannot name a remote secret, or null. */
export function remoteSecretNameProblem(name: unknown): string | null {
  if (typeof name === "string" && REMOTE_SECRET_NAME.test(name)) return null;
  return `the name must match ${REMOTE_SECRET_NAME.source}`;
}

/** Why `value` cannot be the value of a remote secret, or null; the problem never quotes the value. */
export function remoteSecretValueProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "the value must be a non-empty string";
  if ([...value].length > REMOTE_SECRET_MAX_VALUE_LENGTH) return `the value must have at most ${REMOTE_SECRET_MAX_VALUE_LENGTH} characters`;
  if (LINE_BREAK.test(value)) return "the value must be a single line";
  return null;
}

/** The last four characters of `value`, or nothing for a value shorter than 12 characters. */
export function remoteSecretHint(value: string): string {
  return value.length < HINT_MIN_VALUE_LENGTH ? "" : value.slice(-HINT_LENGTH);
}

/** The remote secrets in `text`, the JSON object the gateway stores; throws an Error that never quotes a value. */
export function parseRemoteSecrets(text: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the remote secrets are no valid JSON");
  }
  if (!isRecord(value)) throw new Error("the remote secrets are no JSON object");
  const entries = Object.entries(value);
  if (entries.length > MAX_REMOTE_SECRETS) throw new Error(`there are more than ${MAX_REMOTE_SECRETS} remote secrets`);
  const secrets: Record<string, string> = {};
  for (const [name, secret] of entries) {
    const problem = remoteSecretNameProblem(name) ?? remoteSecretValueProblem(secret);
    if (problem) throw new Error(`the remote secret ${JSON.stringify(name)} is invalid: ${problem}`);
    secrets[name] = secret as string;
  }
  return secrets;
}
