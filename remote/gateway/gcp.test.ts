import { describe, expect, it } from "vitest";
import {
  createCompute,
  createMetadata,
  mergeMetadataItems,
  parseAccessToken,
  parseInstance,
  parseProject,
  parseSecretPayload,
  parseZone,
  readSecret,
  type Metadata,
} from "./gcp.ts";

const METADATA = "http://metadata.google.internal/computeMetadata/v1/";
const ZONE_URL = "https://compute.googleapis.com/compute/v1/projects/medconomy-hunt/zones/europe-west3-a";

const fixedMetadata: Metadata = {
  project: async () => "medconomy-hunt",
  zone: async () => "europe-west3-a",
  accessToken: async () => "token-1",
};

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A fetch that answers from `answers` by `<METHOD> <url>` and records each request. */
function fakeFetch(answers: Record<string, () => Response>) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, authorization: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new Error(`unexpected request ${method} ${url}`);
    return answer();
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

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

  it("decodes a secret's payload and rejects empty values and values with whitespace inside", () => {
    const payload = (text: string) => JSON.stringify({ name: "projects/1/secrets/s/versions/3", payload: { data: Buffer.from(text).toString("base64") } });
    expect(parseSecretPayload(payload("ghp_abc\n"), "hunt-swf-github-token")).toBe("ghp_abc");
    expect(() => parseSecretPayload(payload("  \n"), "s")).toThrow("failed to read the secret s: its latest version is empty or contains whitespace");
    expect(() => parseSecretPayload(payload("two words"), "s")).toThrow("contains whitespace");
    expect(() => parseSecretPayload("{}", "s")).toThrow("has no payload");
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

  it("reports a failing metadata server", async () => {
    const { fetchImpl } = fakeFetch({ [`GET ${METADATA}project/project-id`]: () => new Response("nope", { status: 500 }) });
    await expect(createMetadata(fetchImpl).project()).rejects.toThrow("failed to read project/project-id from the metadata server: HTTP 500 nope");
  });
});

describe("readSecret", () => {
  it("reads the latest version of the secret in the gateway's project with the access token", async () => {
    const url = "https://secretmanager.googleapis.com/v1/projects/medconomy-hunt/secrets/hunt-swf-claude-token/versions/latest:access";
    const { fetchImpl, requests } = fakeFetch({ [`GET ${url}`]: () => Response.json({ payload: { data: Buffer.from("sk-ant-oat01-x").toString("base64") } }) });

    expect(await readSecret(fixedMetadata, "hunt-swf-claude-token", fetchImpl)).toBe("sk-ant-oat01-x");
    expect(requests[0].authorization).toBe("Bearer token-1");
  });

  it("names the secret but not its value when access is denied", async () => {
    const url = "https://secretmanager.googleapis.com/v1/projects/medconomy-hunt/secrets/hunt-swf-github-token/versions/latest:access";
    const { fetchImpl } = fakeFetch({ [`GET ${url}`]: () => new Response('{"error": {"code": 403,\n "message": "Permission denied"}}', { status: 403 }) });

    await expect(readSecret(fixedMetadata, "hunt-swf-github-token", fetchImpl)).rejects.toThrow(
      'failed to read the secret hunt-swf-github-token: HTTP 403 {"error": {"code": 403, "message": "Permission denied"}}',
    );
  });
});

describe("createCompute", () => {
  it("lists the VMs of a label page by page and keeps only those that carry it", async () => {
    const filter = encodeURIComponent('labels.hunt-origin = "swf"');
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${ZONE_URL}/instances?filter=${filter}`]: () =>
        Response.json({ items: [{ name: "vm-hunt-s-00000001", status: "RUNNING", labels: { "hunt-origin": "swf" } }], nextPageToken: "p2" }),
      [`GET ${ZONE_URL}/instances?filter=${filter}&pageToken=p2`]: () =>
        Response.json({ items: [{ name: "vm-hunt-s-00000002", status: "TERMINATED", labels: { "hunt-origin": "swf" } }, { name: "vm-hunt-medc", status: "RUNNING" }] }),
    });

    const vms = await createCompute(fixedMetadata, fetchImpl).listByLabel("hunt-origin", "swf");
    expect(vms.map((vm) => `${vm.name} ${vm.status}`)).toEqual(["vm-hunt-s-00000001 RUNNING", "vm-hunt-s-00000002 TERMINATED"]);
    expect(requests.every((request) => request.authorization === "Bearer token-1")).toBe(true);
  });

  it("creates a VM from the global instance template with its labels and an optional machine type", async () => {
    const template = encodeURIComponent("projects/medconomy-hunt/global/instanceTemplates/tpl-hunt-session");
    const { fetchImpl, requests } = fakeFetch({ [`POST ${ZONE_URL}/instances?sourceInstanceTemplate=${template}`]: () => Response.json({ kind: "compute#operation" }) });
    const compute = createCompute(fixedMetadata, fetchImpl);
    const labels = { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" };

    await compute.insert({ name: "vm-hunt-s-ab12cd34", template: "tpl-hunt-session", labels, machineType: null });
    await compute.insert({ name: "vm-hunt-s-ab12cd34", template: "tpl-hunt-session", labels, machineType: "e2-standard-8" });
    expect(requests.map((request) => request.body)).toEqual([
      { name: "vm-hunt-s-ab12cd34", labels },
      { name: "vm-hunt-s-ab12cd34", labels, machineType: "zones/europe-west3-a/machineTypes/e2-standard-8" },
    ]);
  });

  it("reads an instance, answers null for a missing one and sets metadata with the fingerprint", async () => {
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${ZONE_URL}/instances/vm-hunt-s-ab12cd34`]: () =>
        Response.json({ name: "vm-hunt-s-ab12cd34", status: "PROVISIONING", metadata: { fingerprint: "fp1", items: [{ key: "startup-script", value: "#!/bin/sh" }] } }),
      [`GET ${ZONE_URL}/instances/vm-hunt-s-00000000`]: () => new Response("not found", { status: 404 }),
      [`POST ${ZONE_URL}/instances/vm-hunt-s-ab12cd34/setMetadata`]: () => new Response("Supplied fingerprint does not match", { status: 412 }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);

    const instance = await compute.get("vm-hunt-s-ab12cd34");
    expect(instance?.metadata).toEqual({ fingerprint: "fp1", items: [{ key: "startup-script", value: "#!/bin/sh" }] });
    expect(await compute.get("vm-hunt-s-00000000")).toBeNull();
    await expect(compute.setMetadata("vm-hunt-s-ab12cd34", "fp1", [])).rejects.toThrow("failed to set the metadata of vm-hunt-s-ab12cd34: HTTP 412");
    expect(requests.at(-1)?.body).toEqual({ fingerprint: "fp1", items: [] });
  });
});

describe("metadata items", () => {
  it("replaces and adds the session keys and keeps the template's", () => {
    const items = [
      { key: "startup-script", value: "#!/bin/sh" },
      { key: "hunt-title", value: "old" },
      { key: "enable-oslogin", value: "TRUE" },
    ];
    expect(mergeMetadataItems(items, { "hunt-title": "Fix login", "hunt-issue": "12" })).toEqual([
      { key: "startup-script", value: "#!/bin/sh" },
      { key: "enable-oslogin", value: "TRUE" },
      { key: "hunt-title", value: "Fix login" },
      { key: "hunt-issue", value: "12" },
    ]);
  });

  it("parses an instance with missing parts", () => {
    expect(parseInstance({ name: "vm", labels: { a: "b", c: 1 } })).toEqual({ name: "vm", status: "", labels: { a: "b" }, metadata: { fingerprint: "", items: [] } });
  });
});
