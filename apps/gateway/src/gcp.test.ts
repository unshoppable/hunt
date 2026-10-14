import { describe, expect, it } from "vitest";
import {
  createCompute,
  createMetadata,
  mergeMetadataItems,
  metadataValue,
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
  attribute: async () => null,
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
    expect(parseSecretPayload(payload("ghp_abc\n"), "HUNT_SWF_GITHUB_TOKEN")).toBe("ghp_abc");
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

  it("lists the VMs of a filter in every zone of the project, page by page", async () => {
    const base = "https://compute.googleapis.com/compute/v1/projects/medconomy-hunt/aggregated/instances?returnPartialSuccess=true";
    const filter = encodeURIComponent('labels.hunt-role = "session"');
    const { fetchImpl } = fakeFetch({
      [`GET ${base}&filter=${filter}`]: () =>
        Response.json({
          items: {
            "zones/europe-west3-a": { instances: [{ name: "vm-hunt-s-00000001", zone: "projects/p/zones/europe-west3-a" }] },
            "zones/us-central1-a": { warning: { code: "NO_RESULTS_ON_PAGE" } },
          },
          nextPageToken: "p2",
        }),
      [`GET ${base}&filter=${filter}&pageToken=p2`]: () =>
        Response.json({ items: { "zones/europe-west1-c": { instances: [{ name: "vm-hunt-s-00000002", zone: "projects/p/zones/europe-west1-c" }] } } }),
    });

    const vms = await createCompute(fixedMetadata, fetchImpl).list('labels.hunt-role = "session"');
    expect(vms.map((vm) => `${vm.name} ${vm.zone}`)).toEqual(["vm-hunt-s-00000001 europe-west3-a", "vm-hunt-s-00000002 europe-west1-c"]);
  });

  it("starts, resumes, stops and deletes a VM and marks its disks for deletion", async () => {
    const instance = `${ZONE_URL}/instances/vm-hunt-s-ab12cd34`;
    const { fetchImpl, requests } = fakeFetch({
      [`POST ${instance}/start`]: () => Response.json({ kind: "compute#operation" }),
      [`POST ${instance}/resume`]: () => new Response("denied", { status: 403 }),
      [`POST ${instance}/stop`]: () => Response.json({ kind: "compute#operation" }),
      [`POST ${instance}/setDiskAutoDelete?autoDelete=true&deviceName=data%201`]: () => Response.json({ kind: "compute#operation" }),
      [`DELETE ${instance}`]: () => Response.json({ kind: "compute#operation" }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);

    await compute.start("vm-hunt-s-ab12cd34");
    await expect(compute.resume("vm-hunt-s-ab12cd34")).rejects.toThrow("failed to resume vm-hunt-s-ab12cd34: HTTP 403 denied");
    await compute.stop("vm-hunt-s-ab12cd34");
    await compute.setDiskAutoDelete("vm-hunt-s-ab12cd34", "data 1");
    await compute.delete("vm-hunt-s-ab12cd34");
    expect(requests.map((request) => `${request.method} ${request.url.slice(instance.length)} ${request.authorization}`)).toEqual([
      "POST /start Bearer token-1",
      "POST /resume Bearer token-1",
      "POST /stop Bearer token-1",
      "POST /setDiskAutoDelete?autoDelete=true&deviceName=data%201 Bearer token-1",
      "DELETE  Bearer token-1",
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
    expect(parseInstance({ name: "vm", labels: { a: "b", c: 1 } })).toEqual({
      name: "vm",
      zone: "",
      status: "",
      creationTimestamp: "",
      labels: { a: "b" },
      metadata: { fingerprint: "", items: [] },
      disks: [],
    });
  });

  it("parses the zone, creation time and disks of an instance and reads a metadata item", () => {
    const instance = parseInstance({
      name: "vm-hunt-s-ab12cd34",
      zone: "https://www.googleapis.com/compute/v1/projects/medconomy-hunt/zones/europe-west3-a",
      creationTimestamp: "2026-10-13T01:02:03.456-07:00",
      metadata: { items: [{ key: "hunt-session-id", value: "ab12cd34-0000-4000-8000-000000000001" }] },
      disks: [{ deviceName: "persistent-disk-0", autoDelete: true, boot: true }, { deviceName: "data", autoDelete: false }, { autoDelete: true }],
    });
    expect(instance).toMatchObject({
      zone: "europe-west3-a",
      creationTimestamp: "2026-10-13T01:02:03.456-07:00",
      disks: [
        { deviceName: "persistent-disk-0", autoDelete: true },
        { deviceName: "data", autoDelete: false },
      ],
    });
    expect(metadataValue(instance, "hunt-session-id")).toBe("ab12cd34-0000-4000-8000-000000000001");
    expect(metadataValue(instance, "hunt-repo")).toBeNull();
  });
});
