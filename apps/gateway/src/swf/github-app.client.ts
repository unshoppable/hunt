/**
 * The GitHub App hunt-swf acts as: a JWT signed with the app's private key (`HUNT_SWF_GITHUB_APP_KEY`, issuer
 * `HUNT_SWF_GITHUB_APP_ID`) is exchanged for an installation token per repository, valid for one hour and limited to
 * that repository, which the poller's REST calls (`swf/github.client.ts`) and the session VMs (`hunt-ctl clone`, `start` and
 * `github-token`) use. Tokens are cached per repository and renewed RENEW_MARGIN_MS before they expire; the app's bot
 * identity (`<slug>[bot]` and its noreply address) is the Git identity of the sessions' commits. Plain `fetch` and
 * `node:crypto`; no dependencies.
 */
import { sign, type KeyObject } from "node:crypto";
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { failure } from "../shared/http-failure.utils.ts";

const API = "https://api.github.com";
/** A cached installation token is renewed this long before it expires, so a VM gets a new one well ahead of time. */
export const RENEW_MARGIN_MS = 20 * 60_000;
/** The JWT is dated this long into the past, as GitHub recommends for clock drift. */
const JWT_BACKDATE_MS = 60_000;
/** The JWT's lifetime; GitHub allows ten minutes at most. */
const JWT_LIFETIME_MS = 9 * 60_000;
/** How many of the newest installation tokens `secrets()` lists; an hour-old token has expired anyway. */
const MINTED_KEPT = 50;

export interface AppCredentials {
  /** The app's id, digits only. */
  appId: string;
  privateKey: KeyObject;
}

export interface BotIdentity {
  /** `<slug>[bot]`. */
  name: string;
  /** `<id>+<slug>[bot]@users.noreply.github.com`, which GitHub attributes to the app. */
  email: string;
}

export interface GitHubApp {
  /** The installation token for `repo`, valid for at least RENEW_MARGIN_MS more. */
  tokenFor(repo: Repository): Promise<string>;
  /** The Git identity of the app's bot user. */
  identity(): Promise<BotIdentity>;
  /** Every installation token minted so far, for redaction. */
  secrets(): string[];
}

export interface GitHubAppDeps {
  /** The app's id and key as Secret Manager holds them now; read at every call, so a new key takes effect. */
  credentials(): Promise<AppCredentials>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * The app's JWT (RS256) at `nowMs`: issued JWT_BACKDATE_MS ago, valid for JWT_LIFETIME_MS, issuer `appId`. `appId` is
 * the numeric App ID; GitHub refuses the Client ID (`Iv23…`) as issuer.
 */
export function appJwt(appId: string, privateKey: KeyObject, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: seconds - JWT_BACKDATE_MS / 1000, exp: seconds + JWT_LIFETIME_MS / 1000, iss: appId }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** An installation token response: the token and when it expires, in ms since the epoch. */
export function parseInstallationToken(text: string): { token: string; expiresAt: number } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("GitHub's installation token response is no JSON");
  }
  const { token, expires_at: expiresAt } = (body ?? {}) as { token?: unknown; expires_at?: unknown };
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (typeof token !== "string" || !token || Number.isNaN(expiresAtMs)) throw new Error("GitHub's installation token response has no token or expiry");
  return { token, expiresAt: expiresAtMs };
}

export function createGitHubApp({ credentials, fetchImpl = fetch, now = Date.now }: GitHubAppDeps): GitHubApp {
  /** Installation ids by repository slug. */
  const installations = new Map<string, number>();
  /** The current token of each repository, by its slug. */
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  /** The newest tokens, for redaction; older ones have expired long ago. */
  const minted: string[] = [];
  let identity: BotIdentity | null = null;

  /** A call with the JWT or a token as `authorization`, or an anonymous one with none (public data only). */
  async function call(method: string, path: string, authorization: string | null, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "hunt-swf",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (authorization) {
      headers.Authorization = `Bearer ${authorization}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // The JWT and the tokens go to GitHub's API only.
    if (!path.startsWith("/")) throw new Error(`refused to call ${path.slice(0, 100)} with the GitHub App's credentials`);
    return fetchImpl(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async function jwt(): Promise<string> {
    const { appId, privateKey } = await credentials();
    return appJwt(appId, privateKey, now());
  }

  async function installationOf(repo: Repository, jwtValue: string): Promise<number> {
    const cached = installations.get(repo.slug);
    if (cached !== undefined) return cached;
    const response = await call("GET", `/repos/${repo.path}/installation`, jwtValue);
    if (response.status === 404) throw new Error(`failed to find the GitHub App's installation on ${repo.slug}: the app is not installed on this repository`);
    if (!response.ok) throw await failure(response, `find the GitHub App's installation on ${repo.slug}`);
    const id = ((await response.json()) as { id?: unknown }).id;
    if (typeof id !== "number") throw new Error(`failed to find the GitHub App's installation on ${repo.slug}: the response has no id`);
    installations.set(repo.slug, id);
    return id;
  }

  return {
    async tokenFor(repo) {
      const current = tokens.get(repo.slug);
      if (current && current.expiresAt - RENEW_MARGIN_MS > now()) return current.token;
      const jwtValue = await jwt();
      const installation = await installationOf(repo, jwtValue);
      const response = await call("POST", `/app/installations/${installation}/access_tokens`, jwtValue, { repositories: [repo.name] });
      if (response.status === 404) {
        // The app was uninstalled meanwhile; the next call looks the installation up again.
        installations.delete(repo.slug);
      }
      if (!response.ok) throw await failure(response, `create an installation token for ${repo.slug}`);
      const parsed = parseInstallationToken(await response.text());
      tokens.set(repo.slug, parsed);
      minted.push(parsed.token);
      if (minted.length > MINTED_KEPT) {
        minted.splice(0, minted.length - MINTED_KEPT);
      }
      return parsed.token;
    },
    async identity() {
      if (identity) return identity;
      const jwtValue = await jwt();
      const app = await call("GET", "/app", jwtValue);
      if (!app.ok) throw await failure(app, "read the GitHub App");
      const slug = ((await app.json()) as { slug?: unknown }).slug;
      if (typeof slug !== "string" || !/^[A-Za-z0-9-]+$/.test(slug)) throw new Error("failed to read the GitHub App: the response has no valid slug");
      const login = `${slug}[bot]`;
      // The bot user is public; the JWT serves only the app's own endpoints.
      const user = await call("GET", `/users/${encodeURIComponent(login)}`, null);
      if (!user.ok) throw await failure(user, `read the bot user ${login}`);
      const id = ((await user.json()) as { id?: unknown }).id;
      if (typeof id !== "number") throw new Error(`failed to read the bot user ${login}: the response has no id`);
      identity = { name: login, email: `${id}+${login}@users.noreply.github.com` };
      return identity;
    },
    secrets() {
      return [...minted];
    },
  };
}
