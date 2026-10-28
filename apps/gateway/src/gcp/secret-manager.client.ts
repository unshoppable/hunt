/**
 * Secret Manager in the gateway's project, with the access token of the gateway's service account from the metadata
 * server (`gcp/metadata-server.client.ts`): the poller's tokens, the private files of its repositories and the remote
 * secrets, read as the latest version of a secret, and the versions the remote secrets add, list and destroy. Plain
 * REST through `fetch`; no dependencies.
 */
import { failure } from "../shared/http-failure.utils.ts";
import { authorization, type Metadata } from "./metadata-server.client.ts";

const SECRET_MANAGER = "https://secretmanager.googleapis.com/v1";

/** The bytes of a Secret Manager `versions/<v>:access` response: its base64 payload. */
export function parseSecretBytes(text: string, name: string): Buffer {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`failed to read the secret ${name}: the response is no JSON`);
  }
  const data = (body as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (typeof data !== "string") throw new Error(`failed to read the secret ${name}: the response has no payload`);
  return Buffer.from(data, "base64");
}

/** How a secret's text is checked: one line without whitespace by default; `multiline` for a text such as a PEM key. */
export interface SecretOptions {
  multiline?: boolean;
}

/** The text of a Secret Manager `versions/<v>:access` response: its base64 payload, without surrounding whitespace. */
export function parseSecretPayload(text: string, name: string, options: SecretOptions = {}): string {
  const secret = parseSecretBytes(text, name).toString("utf8").trim();
  if (!secret || (!options.multiline && /\s/.test(secret))) throw new Error(`failed to read the secret ${name}: its latest version is empty or contains whitespace`);
  if (secret.includes("\0")) throw new Error(`failed to read the secret ${name}: its latest version is no text`);
  return secret;
}

/** Reads the latest version of the secret `name` in the gateway's project. */
export async function readSecret(metadata: Metadata, name: string, fetchImpl: typeof fetch = fetch, options: SecretOptions = {}): Promise<string> {
  const response = await accessSecret(metadata, name, fetchImpl);
  if (!response.ok) throw await failure(response, `read the secret ${name}`);
  return parseSecretPayload(await response.text(), name, options);
}

/** Why `readOptionalSecretBytes` finds no secret when the secret has no version (HTTP 404). */
export const NO_SECRET_VERSION = "has no version";

/** An optional secret's latest version as bytes, or why there is none: it has no version, or the gateway may not read it. */
export type OptionalSecret = { bytes: Buffer; absent?: undefined } | { bytes?: undefined; absent: string };

/**
 * Reads the latest version of the optional secret `name` in the gateway's project as bytes. A secret that does not
 * exist or has no version (HTTP 404) and one the gateway may not read (HTTP 403, which Secret Manager also answers for
 * a secret that does not exist) count as absent; any other failure throws.
 */
export async function readOptionalSecretBytes(metadata: Metadata, name: string, fetchImpl: typeof fetch = fetch): Promise<OptionalSecret> {
  const response = await accessSecret(metadata, name, fetchImpl);
  if (response.status === 404) return { absent: NO_SECRET_VERSION };
  if (response.status === 403) return { absent: `cannot be read by the gateway: ${(await failure(response, "read it")).message}` };
  if (!response.ok) throw await failure(response, `read the secret ${name}`);
  return { bytes: parseSecretBytes(await response.text(), name) };
}

async function accessSecret(metadata: Metadata, name: string, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(`${await secretUrl(metadata, name)}/versions/latest:access`, { headers: await authorization(metadata) });
}

/**
 * Adds `bytes` as the latest version of the secret `name` in the gateway's project and returns the version's resource
 * name, `projects/<number>/secrets/<name>/versions/<n>`.
 */
export async function addSecretVersion(metadata: Metadata, name: string, bytes: Buffer, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${await secretUrl(metadata, name)}:addVersion`, {
    method: "POST",
    headers: { ...(await authorization(metadata)), "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { data: bytes.toString("base64") } }),
  });
  if (!response.ok) throw await failure(response, `add a version to the secret ${name}`);
  const version = ((await response.json()) as { name?: unknown } | null)?.name;
  if (typeof version !== "string" || !version) throw new Error(`failed to add a version to the secret ${name}: the response names no version`);
  return version;
}

/** The resource names of the enabled versions of the secret `name` in the gateway's project. */
export async function listEnabledSecretVersions(metadata: Metadata, name: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const versions: string[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ filter: "state:ENABLED", pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const response = await fetchImpl(`${await secretUrl(metadata, name)}/versions?${query}`, { headers: await authorization(metadata) });
    if (!response.ok) throw await failure(response, `list the versions of the secret ${name}`);
    const body = (await response.json()) as { versions?: { name?: unknown }[]; nextPageToken?: unknown } | null;
    for (const version of body?.versions ?? []) {
      if (typeof version.name === "string") {
        versions.push(version.name);
      }
    }
    pageToken = typeof body?.nextPageToken === "string" ? body.nextPageToken : "";
  } while (pageToken);
  return versions;
}

/** Destroys the secret version `version`, a resource name as `addSecretVersion` returns it, for good. */
export async function destroySecretVersion(metadata: Metadata, version: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`${SECRET_MANAGER}/${version}:destroy`, {
    method: "POST",
    headers: { ...(await authorization(metadata)), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw await failure(response, `destroy the secret version ${version}`);
}

async function secretUrl(metadata: Metadata, name: string): Promise<string> {
  return `${SECRET_MANAGER}/projects/${encodeURIComponent(await metadata.project())}/secrets/${encodeURIComponent(name)}`;
}
