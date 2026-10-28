import { createPrivateKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { appJwt, createGitHubApp, parseInstallationToken, RENEW_MARGIN_MS } from "./github-app.client.ts";

const API = "https://api.github.com";
const APP_ID = "4711";
const ACME_APP = Repository.fromSlug("acme/app");
const OTHER_LIB = Repository.fromSlug("other/lib");
const START = Date.UTC(2026, 9, 17, 12, 0, 0);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A fetch that answers from `answers` by `<METHOD> <path>` and records each request. */
function fakeFetch(answers: Record<string, () => Response>) {
  const requests: { key: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url.startsWith(API) ? url.slice(API.length) : url}`;
    requests.push({ key, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected request ${key}`);
    return answer();
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

/** The decoded header and payload of a JWT, and whether `publicKey` verifies its signature. */
function decodeJwt(jwt: string, key: KeyObject) {
  const [header, payload, signature] = jwt.split(".");
  const isValid = verify("sha256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"));
  return { header: JSON.parse(Buffer.from(header, "base64url").toString()), payload: JSON.parse(Buffer.from(payload, "base64url").toString()), isValid };
}

function tokenResponse(token: string, now: number) {
  return () => Response.json({ token, expires_at: new Date(now + 3_600_000).toISOString() }, { status: 201 });
}

describe("appJwt", () => {
  it("signs the app's claims with RS256, dated a minute back and valid for nine minutes", () => {
    const { header, payload, isValid } = decodeJwt(appJwt(APP_ID, privateKey, START + 500), publicKey);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({ iat: START / 1000 - 60, exp: START / 1000 + 540, iss: APP_ID });
    expect(isValid).toBe(true);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(decodeJwt(appJwt(APP_ID, privateKey, START), other).isValid).toBe(false);
  });

  it("signs with a key read from the PEM text GitHub issues (PKCS #1)", () => {
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    expect(pem.startsWith("-----BEGIN RSA PRIVATE KEY-----\n")).toBe(true);
    expect(decodeJwt(appJwt(APP_ID, createPrivateKey(pem), START), publicKey).isValid).toBe(true);
  });
});

describe("parseInstallationToken", () => {
  it("reads the token and its expiry", () => {
    expect(parseInstallationToken('{"token":"ghs_x","expires_at":"2026-10-17T13:00:00Z"}')).toEqual({ token: "ghs_x", expiresAt: Date.UTC(2026, 9, 17, 13) });
    expect(() => parseInstallationToken("<html>")).toThrow("no JSON");
    expect(() => parseInstallationToken('{"token":"ghs_x"}')).toThrow("has no token or expiry");
    expect(() => parseInstallationToken('{"expires_at":"2026-10-17T13:00:00Z"}')).toThrow("has no token or expiry");
  });
});

describe("createGitHubApp", () => {
  const credentials = async () => ({ appId: APP_ID, privateKey });

  it("mints an installation token limited to the repository with the app's JWT and keeps it until it nears its expiry", async () => {
    let now = START;
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/installation": () => Response.json({ id: 77 }),
      "POST /app/installations/77/access_tokens": () => tokenResponse(requests.length < 3 ? "ghs_first0123456789" : "ghs_second123456789", now)(),
    });
    const app = createGitHubApp({ credentials, fetchImpl, now: () => now });

    expect(await app.tokenFor(ACME_APP)).toBe("ghs_first0123456789");
    expect(requests.map((request) => request.key)).toEqual(["GET /repos/acme/app/installation", "POST /app/installations/77/access_tokens"]);
    expect(requests[1].body).toEqual({ repositories: ["app"] });
    for (const request of requests) {
      const jwt = request.headers.get("Authorization")!.replace("Bearer ", "");
      expect(decodeJwt(jwt, publicKey)).toMatchObject({ payload: { iss: APP_ID }, isValid: true });
    }

    now = START + 3_600_000 - RENEW_MARGIN_MS - 1_000;
    expect(await app.tokenFor(ACME_APP)).toBe("ghs_first0123456789");
    expect(requests).toHaveLength(2);

    now = START + 3_600_000 - RENEW_MARGIN_MS + 1_000;
    expect(await app.tokenFor(ACME_APP)).toBe("ghs_second123456789");
    expect(requests.map((request) => request.key)).toEqual([
      "GET /repos/acme/app/installation",
      "POST /app/installations/77/access_tokens",
      "POST /app/installations/77/access_tokens",
    ]);
    expect(app.secrets()).toEqual(["ghs_first0123456789", "ghs_second123456789"]);
  });

  it("keeps one token per repository", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/installation": () => Response.json({ id: 77 }),
      "GET /repos/other/lib/installation": () => Response.json({ id: 78 }),
      "POST /app/installations/77/access_tokens": tokenResponse("ghs_app", START),
      "POST /app/installations/78/access_tokens": tokenResponse("ghs_lib", START),
    });
    const app = createGitHubApp({ credentials, fetchImpl, now: () => START });
    expect(await app.tokenFor(ACME_APP)).toBe("ghs_app");
    expect(await app.tokenFor(OTHER_LIB)).toBe("ghs_lib");
    expect(await app.tokenFor(ACME_APP)).toBe("ghs_app");
    expect(requests.filter((request) => request.key.startsWith("POST")).map((request) => request.body)).toEqual([{ repositories: ["app"] }, { repositories: ["lib"] }]);
  });

  it("names the repository when the app is not installed on it", async () => {
    let installed = false;
    const { fetchImpl } = fakeFetch({
      "GET /repos/acme/app/installation": () => (installed ? Response.json({ id: 77 }) : Response.json({ message: "Not Found" }, { status: 404 })),
      "POST /app/installations/77/access_tokens": tokenResponse("ghs_app", START),
    });
    const app = createGitHubApp({ credentials, fetchImpl, now: () => START });
    await expect(app.tokenFor(ACME_APP)).rejects.toThrow("failed to find the GitHub App's installation on acme/app: the app is not installed on this repository");
    installed = true;
    expect(await app.tokenFor(ACME_APP)).toBe("ghs_app");
  });

  it("drops a cached installation whose token GitHub refuses with 404 and reports the failure without the JWT", async () => {
    let tokenStatus = 201;
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/installation": () => Response.json({ id: 77 }),
      "POST /app/installations/77/access_tokens": () => (tokenStatus === 201 ? tokenResponse("ghs_app", START)() : new Response("Not Found", { status: tokenStatus })),
    });
    let now = START;
    const app = createGitHubApp({ credentials, fetchImpl, now: () => now });
    await app.tokenFor(ACME_APP);
    tokenStatus = 404;
    now = START + 3_600_000;
    await expect(app.tokenFor(ACME_APP)).rejects.toThrow("failed to create an installation token for acme/app: HTTP 404 Not Found");
    tokenStatus = 201;
    await app.tokenFor(ACME_APP);
    expect(requests.filter((request) => request.key.startsWith("GET"))).toHaveLength(2);
  });

  it("derives the bot's Git identity from the app's slug and the bot user's id, once", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "GET /app": () => Response.json({ id: 4711, slug: "hunt-claude", name: "Hunt" }),
      "GET /users/hunt-claude%5Bbot%5D": () => Response.json({ login: "hunt-claude[bot]", id: 4242, type: "Bot" }),
    });
    const app = createGitHubApp({ credentials, fetchImpl, now: () => START });
    expect(await app.identity()).toEqual({ name: "hunt-claude[bot]", email: "4242+hunt-claude[bot]@users.noreply.github.com" });
    expect(await app.identity()).toEqual({ name: "hunt-claude[bot]", email: "4242+hunt-claude[bot]@users.noreply.github.com" });
    expect(requests.map((request) => request.key)).toEqual(["GET /app", "GET /users/hunt-claude%5Bbot%5D"]);
    expect(requests[0].headers.get("Authorization")).toMatch(/^Bearer eyJ/);
    expect(requests[1].headers.has("Authorization")).toBe(false);
  });

  it("reports a failing app or bot user lookup with the response body only", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /app": () => new Response('{"message":"A JSON web token could not be decoded"}', { status: 401 }),
    });
    const app = createGitHubApp({ credentials, fetchImpl, now: () => START });
    await expect(app.identity()).rejects.toThrow('failed to read the GitHub App: HTTP 401 {"message":"A JSON web token could not be decoded"}');
    const missing = createGitHubApp({ credentials, fetchImpl: fakeFetch({ "GET /app": () => Response.json({ slug: "" }) }).fetchImpl, now: () => START });
    await expect(missing.identity()).rejects.toThrow("failed to read the GitHub App: the response has no valid slug");
  });
});
