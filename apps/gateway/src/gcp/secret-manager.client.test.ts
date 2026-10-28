import { describe, expect, it } from "vitest";
import { fakeFetch, fixedMetadata } from "./gcp.fixtures.ts";
import {
  addSecretVersion,
  destroySecretVersion,
  listEnabledSecretVersions,
  parseSecretPayload,
  readOptionalSecretBytes,
  readSecret,
} from "./secret-manager.client.ts";

describe("secret payload parsing", () => {
  it("decodes a secret's payload and rejects empty values and values with whitespace inside", () => {
    const payload = (text: string) => JSON.stringify({ name: "projects/1/secrets/s/versions/3", payload: { data: Buffer.from(text).toString("base64") } });
    expect(parseSecretPayload(payload("ghp_abc\n"), "HUNT_SWF_GITHUB_TOKEN")).toBe("ghp_abc");
    expect(() => parseSecretPayload(payload("  \n"), "s")).toThrow("failed to read the secret s: its latest version is empty or contains whitespace");
    expect(() => parseSecretPayload(payload("two words"), "s")).toThrow("contains whitespace");
    expect(() => parseSecretPayload("{}", "s")).toThrow("has no payload");
  });

  it("accepts a text of several lines, such as a PEM key, only with the multiline option", () => {
    const payload = (text: string) => JSON.stringify({ payload: { data: Buffer.from(text).toString("base64") } });
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\nAB==\n-----END RSA PRIVATE KEY-----";
    expect(parseSecretPayload(payload(`${pem}\n`), "k", { multiline: true })).toBe(pem);
    expect(() => parseSecretPayload(payload(pem), "k")).toThrow("contains whitespace");
    expect(() => parseSecretPayload(payload("  \n"), "k", { multiline: true })).toThrow("empty");
    expect(() => parseSecretPayload(payload("a\0b"), "k", { multiline: true })).toThrow("failed to read the secret k: its latest version is no text");
  });
});

describe("readSecret", () => {
  it("reads the latest version of the secret in the gateway's project with the access token", async () => {
    const url = "https://secretmanager.googleapis.com/v1/projects/medconomy-hunt/secrets/HUNT_SWF_CLAUDE_TOKEN/versions/latest:access";
    const { fetchImpl, requests } = fakeFetch({ [`GET ${url}`]: () => Response.json({ payload: { data: Buffer.from("sk-ant-oat01-x").toString("base64") } }) });

    expect(await readSecret(fixedMetadata, "HUNT_SWF_CLAUDE_TOKEN", fetchImpl)).toBe("sk-ant-oat01-x");
    expect(requests[0].authorization).toBe("Bearer token-1");
  });

  it("names the secret but not its value when access is denied", async () => {
    const url = "https://secretmanager.googleapis.com/v1/projects/medconomy-hunt/secrets/HUNT_SWF_GITHUB_TOKEN/versions/latest:access";
    const { fetchImpl } = fakeFetch({ [`GET ${url}`]: () => new Response('{"error": {"code": 403,\n "message": "Permission denied"}}', { status: 403 }) });

    await expect(readSecret(fixedMetadata, "HUNT_SWF_GITHUB_TOKEN", fetchImpl)).rejects.toThrow(
      'failed to read the secret HUNT_SWF_GITHUB_TOKEN: HTTP 403 {"error": {"code": 403, "message": "Permission denied"}}',
    );
  });
});

describe("readOptionalSecretBytes", () => {
  const url = "https://secretmanager.googleapis.com/v1/projects/medconomy-hunt/secrets/HUNT_SWF_FILES_acme_app/versions/latest:access";

  it("returns the payload's bytes as they are", async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x0a, 0x20]);
    const { fetchImpl, requests } = fakeFetch({ [`GET ${url}`]: () => Response.json({ payload: { data: bytes.toString("base64") } }) });

    expect(await readOptionalSecretBytes(fixedMetadata, "HUNT_SWF_FILES_acme_app", fetchImpl)).toEqual({ bytes });
    expect(requests[0].authorization).toBe("Bearer token-1");
  });

  it("reports a missing version or denied access as absent and throws for any other failure", async () => {
    const missing = fakeFetch({ [`GET ${url}`]: () => new Response('{"error": {"code": 404, "message": "Secret Version [latest] not found."}}', { status: 404 }) });
    expect(await readOptionalSecretBytes(fixedMetadata, "HUNT_SWF_FILES_acme_app", missing.fetchImpl)).toEqual({ absent: "has no version" });

    const denied = fakeFetch({ [`GET ${url}`]: () => new Response('{"error": {"code": 403, "message": "Permission denied"}}', { status: 403 }) });
    expect(await readOptionalSecretBytes(fixedMetadata, "HUNT_SWF_FILES_acme_app", denied.fetchImpl)).toEqual({
      absent: 'cannot be read by the gateway: failed to read it: HTTP 403 {"error": {"code": 403, "message": "Permission denied"}}',
    });

    const broken = fakeFetch({ [`GET ${url}`]: () => new Response("boom", { status: 500 }) });
    await expect(readOptionalSecretBytes(fixedMetadata, "HUNT_SWF_FILES_acme_app", broken.fetchImpl)).rejects.toThrow(
      "failed to read the secret HUNT_SWF_FILES_acme_app: HTTP 500 boom",
    );
  });
});

describe("secret versions", () => {
  const secret = "https://secretmanager.googleapis.com/v1/projects/medconomy-hunt/secrets/HUNT_REMOTE_SECRETS";
  const version = (n: number) => `projects/123/secrets/HUNT_REMOTE_SECRETS/versions/${n}`;

  it("adds a version with the payload in base64 and returns its name", async () => {
    const { fetchImpl, requests } = fakeFetch({ [`POST ${secret}:addVersion`]: () => Response.json({ name: version(3), state: "ENABLED" }) });

    expect(await addSecretVersion(fixedMetadata, "HUNT_REMOTE_SECRETS", Buffer.from('{"A":"b"}'), fetchImpl)).toBe(version(3));
    expect(requests).toEqual([
      { method: "POST", url: `${secret}:addVersion`, authorization: "Bearer token-1", body: { payload: { data: Buffer.from('{"A":"b"}').toString("base64") } } },
    ]);
  });

  it("lists the enabled versions page by page and destroys one", async () => {
    const list = `${secret}/versions?filter=state%3AENABLED&pageSize=100`;
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${list}`]: () => Response.json({ versions: [{ name: version(3) }, { name: version(2) }], nextPageToken: "p2" }),
      [`GET ${list}&pageToken=p2`]: () => Response.json({ versions: [{ name: version(1) }] }),
      [`POST https://secretmanager.googleapis.com/v1/${version(2)}:destroy`]: () => Response.json({ name: version(2), state: "DESTROYED" }),
    });

    expect(await listEnabledSecretVersions(fixedMetadata, "HUNT_REMOTE_SECRETS", fetchImpl)).toEqual([version(3), version(2), version(1)]);
    await destroySecretVersion(fixedMetadata, version(2), fetchImpl);
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-1"]);
    expect(requests[2].body).toEqual({});
  });

  it("names the secret but never the payload when a call fails", async () => {
    const { fetchImpl } = fakeFetch({
      [`POST ${secret}:addVersion`]: () => new Response('{"error": {"code": 403, "message": "Permission denied"}}', { status: 403 }),
      [`GET ${secret}/versions?filter=state%3AENABLED&pageSize=100`]: () => new Response("boom", { status: 500 }),
    });

    const adding = addSecretVersion(fixedMetadata, "HUNT_REMOTE_SECRETS", Buffer.from("sk-secret"), fetchImpl);
    await expect(adding).rejects.toThrow('failed to add a version to the secret HUNT_REMOTE_SECRETS: HTTP 403 {"error": {"code": 403, "message": "Permission denied"}}');
    await expect(listEnabledSecretVersions(fixedMetadata, "HUNT_REMOTE_SECRETS", fetchImpl)).rejects.toThrow(
      "failed to list the versions of the secret HUNT_REMOTE_SECRETS: HTTP 500 boom",
    );
  });
});
