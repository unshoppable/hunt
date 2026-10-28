/**
 * The secrets hunt-swf runs with (`Secrets` of `swf/poller.service.ts`), read from Secret Manager with the gateway's
 * service account: the GitHub App's id and private key and the Claude Code OAuth token of the poller's sessions.
 */
import { createPrivateKey } from "node:crypto";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Metadata } from "../gcp/metadata-server.client.ts";
import { readSecret } from "../gcp/secret-manager.client.ts";
import type { Secrets } from "./poller.service.ts";

const GITHUB_APP_ID_SECRET = "HUNT_SWF_GITHUB_APP_ID";
const GITHUB_APP_KEY_SECRET = "HUNT_SWF_GITHUB_APP_KEY";
const CLAUDE_SECRET = "HUNT_SWF_CLAUDE_TOKEN";
/** Secrets are read again after this long, so a new version takes effect without a restart. */
const SECRETS_TTL_MS = 10 * 60_000;

/** The secrets from Secret Manager, read again after SECRETS_TTL_MS; an id that is no number or a key that is no PEM throws. */
export function secretsReader(metadata: Metadata, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): () => Promise<Secrets> {
  let cached: { secrets: Secrets; readAt: number } | null = null;
  return async () => {
    if (cached && now() - cached.readAt < SECRETS_TTL_MS) return cached.secrets;
    const [appId, pem, claude] = await Promise.all([
      readSecret(metadata, GITHUB_APP_ID_SECRET, fetchImpl),
      readSecret(metadata, GITHUB_APP_KEY_SECRET, fetchImpl, { multiline: true }),
      readSecret(metadata, CLAUDE_SECRET, fetchImpl),
    ]);
    if (!/^[0-9]+$/.test(appId)) throw new Error(`failed to read the secret ${GITHUB_APP_ID_SECRET}: its latest version is no GitHub App id`);
    let privateKey;
    try {
      privateKey = createPrivateKey(pem);
    } catch (error) {
      throw new Error(`failed to read the secret ${GITHUB_APP_KEY_SECRET}: its latest version is no private key: ${messageOf(error)}`);
    }
    cached = { secrets: { claude, app: { appId, privateKey } }, readAt: now() };
    return cached.secrets;
  };
}
