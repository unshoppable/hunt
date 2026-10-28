/**
 * The metadata server of the gateway's VM: its project, its zone, its instance attributes and the access token of its
 * service account, with which the gateway's services call Secret Manager (`gcp/secret-manager.client.ts`) and Compute
 * Engine (`gcp/compute-engine.client.ts`). Plain REST through `fetch`; no dependencies.
 */
import { failure } from "../shared/http-failure.utils.ts";

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
/** A cached access token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

export interface Metadata {
  project(): Promise<string>;
  zone(): Promise<string>;
  accessToken(): Promise<string>;
  /** The value of the gateway's own instance metadata attribute `key`, read anew at every call; null without one. */
  attribute(key: string): Promise<string | null>;
}

/** The zone's name from the metadata server's `instance/zone`, `projects/<number>/zones/<zone>`. */
export function parseZone(text: string): string {
  const zone = text.trim().split("/").pop() ?? "";
  if (!/^[a-z0-9-]+$/.test(zone)) throw new Error(`unexpected zone from the metadata server: ${text.slice(0, 100)}`);
  return zone;
}

export function parseProject(text: string): string {
  const project = text.trim();
  if (!/^[a-z][a-z0-9-]+$/.test(project)) throw new Error(`unexpected project from the metadata server: ${project.slice(0, 100)}`);
  return project;
}

/** The metadata server's token response: the token and how many seconds it stays valid. */
export function parseAccessToken(text: string): { value: string; expiresInSeconds: number } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("the metadata server's token response is no JSON");
  }
  const { access_token: value, expires_in: expiresInSeconds } = (body ?? {}) as { access_token?: unknown; expires_in?: unknown };
  if (typeof value !== "string" || !value || typeof expiresInSeconds !== "number") throw new Error("the metadata server's token response has no access_token");
  return { value, expiresInSeconds };
}

export function createMetadata(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Metadata {
  let token: { value: string; expiresAt: number } | null = null;
  let project: string | null = null;
  let zone: string | null = null;

  function get(path: string): Promise<Response> {
    return fetchImpl(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  }

  async function read(path: string): Promise<string> {
    const response = await get(path);
    if (!response.ok) throw await failure(response, `read ${path} from the metadata server`);
    return response.text();
  }

  return {
    async project() {
      project ??= parseProject(await read("project/project-id"));
      return project;
    },
    async zone() {
      zone ??= parseZone(await read("instance/zone"));
      return zone;
    },
    async accessToken() {
      if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
      const parsed = parseAccessToken(await read("instance/service-accounts/default/token"));
      token = { value: parsed.value, expiresAt: now() + parsed.expiresInSeconds * 1000 };
      return token.value;
    },
    async attribute(key) {
      const path = `instance/attributes/${encodeURIComponent(key)}`;
      const response = await get(path);
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, `read ${path} from the metadata server`);
      return response.text();
    },
  };
}

/** The `Authorization` header of a Google API call with the access token of the gateway's service account. */
export async function authorization(metadata: Metadata): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await metadata.accessToken()}` };
}
