/**
 * The remote secrets as the gateway stores them: one JSON object `{ "<NAME>": "<value>" }` in the latest version of
 * the Secret Manager secret `HUNT_REMOTE_SECRETS`, which the gateway puts on every session VM it brings up; a service
 * of a repository's hunt.json names the ones it needs (`"remoteSecrets": { "OPENAI_API_KEY": "$MED_OPENAI_API_KEY" }`).
 */
import { isRecord } from "../shared/json-rpc.utils.ts";
import { RemoteSecret } from "./remote-secret.value-object.ts";

/** The Secret Manager secret whose latest version holds every remote secret. */
export const REMOTE_SECRETS_SECRET = "HUNT_REMOTE_SECRETS";
export const MAX_REMOTE_SECRETS = 256;

/** The remote secrets in `text`, the JSON object the gateway stores, by name; throws an Error that never quotes a value. */
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
    const problem = RemoteSecret.nameProblem(name) ?? RemoteSecret.valueProblem(secret);
    if (problem) throw new Error(`the remote secret ${JSON.stringify(name)} is invalid: ${problem}`);
    secrets[name] = secret as string;
  }
  return secrets;
}
