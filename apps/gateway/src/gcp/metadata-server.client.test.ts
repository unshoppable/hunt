import { describe, expect, it } from "vitest";
import { fakeFetch } from "./gcp.fixtures.ts";
import { createMetadata, parseAccessToken, parseProject, parseZone } from "./metadata-server.client.ts";

const METADATA = "http://metadata.google.internal/computeMetadata/v1/";

describe("metadata parsing", () => {
  it("reads the zone, project and access token the metadata server returns", () => {
    expect(parseZone("projects/123/zones/europe-west3-a")).toBe("europe-west3-a");
    expect(() => parseZone("projects/123/zones/")).toThrow("unexpected zone");
    expect(parseProject("medconomy-hunt\n")).toBe("medconomy-hunt");
    expect(() => parseProject("Bad Project")).toThrow("unexpected project");
    expect(parseAccessToken('{"access_token":"ya29.x","expires_in":3599,"token_type":"Bearer"}')).toEqual({ value: "ya29.x", expiresInSeconds: 3599 });
    expect(() => parseAccessToken("<html>")).toThrow("no JSON");
    expect(() => parseAccessToken('{"expires_in":1}')).toThrow("no access_token");
  });
});

describe("createMetadata", () => {
  it("caches project and zone and renews the token a minute before it expires", async () => {
    let tokens = 0;
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${METADATA}project/project-id`]: () => new Response("medconomy-hunt"),
      [`GET ${METADATA}instance/zone`]: () => new Response("projects/123/zones/europe-west3-a"),
      [`GET ${METADATA}instance/service-accounts/default/token`]: () => Response.json({ access_token: `token-${++tokens}`, expires_in: 3600 }),
    });
    let now = 0;
    const metadata = createMetadata(fetchImpl, () => now);

    expect([await metadata.project(), await metadata.project(), await metadata.zone(), await metadata.accessToken()]).toEqual([
      "medconomy-hunt",
      "medconomy-hunt",
      "europe-west3-a",
      "token-1",
    ]);
    now = 3600_000 - 60_001;
    expect(await metadata.accessToken()).toBe("token-1");
    now += 1;
    expect(await metadata.accessToken()).toBe("token-2");
    expect(requests.map((request) => request.url.slice(METADATA.length))).toEqual([
      "project/project-id",
      "instance/zone",
      "instance/service-accounts/default/token",
      "instance/service-accounts/default/token",
    ]);
  });

  it("reads instance attributes anew at every call, null for a missing one", async () => {
    let repos = "acme/app";
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${METADATA}instance/attributes/hunt-swf-repos`]: () => new Response(repos),
      [`GET ${METADATA}instance/attributes/hunt-swf-max-sessions`]: () => new Response("Not Found", { status: 404 }),
      [`GET ${METADATA}instance/attributes/broken`]: () => new Response("nope", { status: 503 }),
    });
    const metadata = createMetadata(fetchImpl);

    expect(await metadata.attribute("hunt-swf-repos")).toBe("acme/app");
    repos = "acme/app,acme/api";
    expect(await metadata.attribute("hunt-swf-repos")).toBe("acme/app,acme/api");
    expect(await metadata.attribute("hunt-swf-max-sessions")).toBeNull();
    await expect(metadata.attribute("broken")).rejects.toThrow("failed to read instance/attributes/broken from the metadata server: HTTP 503 nope");
    expect(requests.map((request) => request.url.slice(METADATA.length))).toEqual([
      "instance/attributes/hunt-swf-repos",
      "instance/attributes/hunt-swf-repos",
      "instance/attributes/hunt-swf-max-sessions",
      "instance/attributes/broken",
    ]);
  });

  it("reports a failing metadata server", async () => {
    const { fetchImpl } = fakeFetch({ [`GET ${METADATA}project/project-id`]: () => new Response("nope", { status: 500 }) });
    await expect(createMetadata(fetchImpl).project()).rejects.toThrow("failed to read project/project-id from the metadata server: HTTP 500 nope");
  });
});
