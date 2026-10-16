import { describe, expect, it } from "vitest";
import {
  createCompute,
  createMetadata,
  describeComputeCall,
  isStockout,
  mergeMetadataItems,
  metadataValue,
  parseAccessToken,
  parseDisk,
  parseInstance,
  parseOperation,
  parseProject,
  parseSecretPayload,
  parseZone,
  readSecret,
  regionOf,
  type Metadata,
} from "./gcp.ts";

const METADATA = "http://metadata.google.internal/computeMetadata/v1/";
const PROJECT_URL = "https://compute.googleapis.com/compute/v1/projects/medconomy-hunt";
const ZONE_URL = `${PROJECT_URL}/zones/europe-west3-a`;
const AGGREGATED_URL = `${PROJECT_URL}/aggregated/instances?returnPartialSuccess=true`;

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
  it("lists the VMs of a label in every zone, page by page, and keeps only those that carry it", async () => {
    const filter = encodeURIComponent('labels.hunt-origin = "swf"');
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${AGGREGATED_URL}&filter=${filter}`]: () =>
        Response.json({
          items: { "zones/europe-west3-a": { instances: [{ name: "vm-hunt-s-00000001", status: "RUNNING", labels: { "hunt-origin": "swf" } }] } },
          nextPageToken: "p2",
        }),
      [`GET ${AGGREGATED_URL}&filter=${filter}&pageToken=p2`]: () =>
        Response.json({
          items: {
            "zones/europe-west3-b": {
              instances: [{ name: "vm-hunt-s-00000002", status: "TERMINATED", labels: { "hunt-origin": "swf" } }, { name: "vm-hunt-medc", status: "RUNNING" }],
            },
          },
        }),
    });

    const vms = await createCompute(fixedMetadata, fetchImpl).listByLabel("hunt-origin", "swf");
    expect(vms.map((vm) => `${vm.name} ${vm.status}`)).toEqual(["vm-hunt-s-00000001 RUNNING", "vm-hunt-s-00000002 TERMINATED"]);
    expect(requests.every((request) => request.authorization === "Bearer token-1")).toBe(true);
  });

  it("finds a VM by name in whichever zone holds it", async () => {
    const filter = encodeURIComponent('name = "vm-hunt-s-ab12cd34"');
    const { fetchImpl } = fakeFetch({
      [`GET ${AGGREGATED_URL}&filter=${filter}`]: () =>
        Response.json({ items: { "zones/europe-west3-c": { instances: [{ name: "vm-hunt-s-ab12cd34", zone: "projects/p/zones/europe-west3-c" }] } } }),
      [`GET ${AGGREGATED_URL}&filter=${encodeURIComponent('name = "vm-hunt-s-00000000"')}`]: () =>
        Response.json({ items: { "zones/europe-west3-a": { warning: { code: "NO_RESULTS_ON_PAGE" } } } }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);

    expect((await compute.locate("vm-hunt-s-ab12cd34"))?.zone).toBe("europe-west3-c");
    expect(await compute.locate("vm-hunt-s-00000000")).toBeNull();
  });

  it("creates a VM from the global instance template in the given zone and returns its operation", async () => {
    const template = encodeURIComponent("projects/medconomy-hunt/global/instanceTemplates/tpl-hunt-session");
    const { fetchImpl, requests } = fakeFetch({
      [`POST ${ZONE_URL}/instances?sourceInstanceTemplate=${template}`]: () => Response.json({ kind: "compute#operation", name: "operation-1" }),
      [`POST ${PROJECT_URL}/zones/europe-west3-b/instances?sourceInstanceTemplate=${template}`]: () =>
        Response.json({ kind: "compute#operation", name: "operation-2", zone: `${PROJECT_URL}/zones/europe-west3-b` }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);
    const labels = { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "swf" };

    expect(await compute.insert("europe-west3-a", { name: "vm-hunt-s-ab12cd34", template: "tpl-hunt-session", labels, machineType: null })).toEqual({
      name: "operation-1",
      zone: "europe-west3-a",
    });
    expect(await compute.insert("europe-west3-b", { name: "vm-hunt-s-ab12cd34", template: "tpl-hunt-session", labels, machineType: "c4d-standard-8" })).toEqual({
      name: "operation-2",
      zone: "europe-west3-b",
    });
    expect(requests.map((request) => request.body)).toEqual([
      { name: "vm-hunt-s-ab12cd34", labels },
      { name: "vm-hunt-s-ab12cd34", labels, machineType: "zones/europe-west3-b/machineTypes/c4d-standard-8" },
    ]);
  });

  it("reads an operation's state and the error of a failed one", async () => {
    const { fetchImpl } = fakeFetch({
      [`GET ${ZONE_URL}/operations/operation-1`]: () => Response.json({ name: "operation-1", status: "RUNNING" }),
      [`GET ${ZONE_URL}/operations/operation-2`]: () =>
        Response.json({ name: "operation-2", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "Quota exceeded." }] } }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);

    expect(await compute.operation({ name: "operation-1", zone: "europe-west3-a" })).toEqual({ isDone: false, error: null });
    expect(await compute.operation({ name: "operation-2", zone: "europe-west3-a" })).toEqual({
      isDone: true,
      error: { code: "QUOTA_EXCEEDED", message: "Quota exceeded.", machineType: null },
    });
  });

  it("lists the VMs of a filter in every zone of the project, page by page", async () => {
    const filter = encodeURIComponent('labels.hunt-role = "session"');
    const { fetchImpl } = fakeFetch({
      [`GET ${AGGREGATED_URL}&filter=${filter}`]: () =>
        Response.json({
          items: {
            "zones/europe-west3-a": { instances: [{ name: "vm-hunt-s-00000001", zone: "projects/p/zones/europe-west3-a" }] },
            "zones/us-central1-a": { warning: { code: "NO_RESULTS_ON_PAGE" } },
          },
          nextPageToken: "p2",
        }),
      [`GET ${AGGREGATED_URL}&filter=${filter}&pageToken=p2`]: () =>
        Response.json({ items: { "zones/europe-west1-c": { instances: [{ name: "vm-hunt-s-00000002", zone: "projects/p/zones/europe-west1-c" }] } } }),
    });

    const vms = await createCompute(fixedMetadata, fetchImpl).list('labels.hunt-role = "session"');
    expect(vms.map((vm) => `${vm.name} ${vm.zone}`)).toEqual(["vm-hunt-s-00000001 europe-west3-a", "vm-hunt-s-00000002 europe-west1-c"]);
  });

  it("starts, resumes, stops and deletes a VM in its zone and marks its disks for deletion", async () => {
    const instance = `${PROJECT_URL}/zones/europe-west3-b/instances/vm-hunt-s-ab12cd34`;
    const { fetchImpl, requests } = fakeFetch({
      [`POST ${instance}/start`]: () => Response.json({ kind: "compute#operation", name: "operation-3" }),
      [`POST ${instance}/resume`]: () => new Response("denied", { status: 403 }),
      [`POST ${instance}/stop`]: () => Response.json({ kind: "compute#operation" }),
      [`POST ${instance}/setDiskAutoDelete?autoDelete=true&deviceName=data%201`]: () => Response.json({ kind: "compute#operation" }),
      [`DELETE ${instance}`]: () => Response.json({ kind: "compute#operation" }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);
    const zone = "europe-west3-b";

    expect(await compute.start(zone, "vm-hunt-s-ab12cd34")).toEqual({ name: "operation-3", zone });
    await expect(compute.resume(zone, "vm-hunt-s-ab12cd34")).rejects.toThrow("failed to resume vm-hunt-s-ab12cd34: HTTP 403 denied");
    await compute.stop(zone, "vm-hunt-s-ab12cd34");
    await compute.setDiskAutoDelete(zone, "vm-hunt-s-ab12cd34", "data 1");
    await compute.delete(zone, "vm-hunt-s-ab12cd34");
    expect(requests.map((request) => `${request.method} ${request.url.slice(instance.length)} ${request.authorization}`)).toEqual([
      "POST /start Bearer token-1",
      "POST /resume Bearer token-1",
      "POST /stop Bearer token-1",
      "POST /setDiskAutoDelete?autoDelete=true&deviceName=data%201 Bearer token-1",
      "DELETE  Bearer token-1",
    ]);
  });

  it("creates a moved VM from the template with an existing boot disk and the metadata given", async () => {
    const template = encodeURIComponent("projects/medconomy-hunt/global/instanceTemplates/tpl-hunt-session");
    const { fetchImpl, requests } = fakeFetch({
      [`POST ${ZONE_URL}/instances?sourceInstanceTemplate=${template}`]: () => Response.json({ kind: "compute#operation", name: "operation-1" }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);
    const labels = { "hunt-role": "session", "hunt-session": "ab12cd34", "hunt-origin": "desktop" };
    const metadata = [{ key: "startup-script", value: "#!/bin/sh" }, { key: "hunt-session-id", value: "ab12cd34-0000-4000-8000-000000000001" }];

    await compute.insert("europe-west3-a", { name: "vm-hunt-s-ab12cd34", template: "tpl-hunt-session", labels, machineType: "c4d-standard-8", metadata, bootDisk: "vm-hunt-s-ab12cd34" });
    expect(requests[0].body).toEqual({
      name: "vm-hunt-s-ab12cd34",
      labels,
      machineType: "zones/europe-west3-a/machineTypes/c4d-standard-8",
      metadata: { items: metadata },
      disks: [{ boot: true, autoDelete: true, deviceName: "persistent-disk-0", source: "zones/europe-west3-a/disks/vm-hunt-s-ab12cd34" }],
    });
  });

  it("renames a VM, reads, snapshots, creates and deletes disks and deletes snapshots, with global operations for the latter", async () => {
    const instance = `${ZONE_URL}/instances/vm-hunt-s-ab12cd34`;
    const disk = `${ZONE_URL}/disks/vm-hunt-s-ab12cd34`;
    const { fetchImpl, requests } = fakeFetch({
      [`POST ${instance}/setName`]: () => Response.json({ kind: "compute#operation", name: "operation-1" }),
      [`GET ${disk}`]: () => Response.json({ name: "vm-hunt-s-ab12cd34", type: `${ZONE_URL}/diskTypes/hyperdisk-balanced`, sizeGb: "50" }),
      [`GET ${ZONE_URL}/disks/vm-hunt-s-00000000`]: () => new Response("not found", { status: 404 }),
      [`POST ${disk}/createSnapshot`]: () => Response.json({ kind: "compute#operation", name: "operation-2" }),
      [`POST ${ZONE_URL}/disks`]: () => Response.json({ kind: "compute#operation", name: "operation-3" }),
      [`DELETE ${disk}`]: () => Response.json({ kind: "compute#operation", name: "operation-4" }),
      [`DELETE ${PROJECT_URL}/global/snapshots/vm-hunt-s-ab12cd34-move`]: () => Response.json({ kind: "compute#operation", name: "operation-5" }),
      [`DELETE ${PROJECT_URL}/global/snapshots/vm-hunt-s-00000000-move`]: () => new Response("not found", { status: 404 }),
      [`GET ${PROJECT_URL}/global/operations/operation-5`]: () => Response.json({ name: "operation-5", status: "DONE" }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);
    const zone = "europe-west3-a";

    expect(await compute.setName(zone, "vm-hunt-s-ab12cd34", "vm-hunt-s-ab12cd34-moving")).toEqual({ name: "operation-1", zone });
    expect(await compute.getDisk(zone, "vm-hunt-s-ab12cd34")).toEqual({ type: "hyperdisk-balanced", sizeGb: 50 });
    await expect(compute.getDisk(zone, "vm-hunt-s-00000000")).rejects.toThrow("failed to look up the disk vm-hunt-s-00000000 in europe-west3-a: HTTP 404 not found");
    expect(await compute.createSnapshot(zone, "vm-hunt-s-ab12cd34", "vm-hunt-s-ab12cd34-move")).toEqual({ name: "operation-2", zone });
    expect(await compute.insertDisk(zone, { name: "vm-hunt-s-ab12cd34", sourceSnapshot: "vm-hunt-s-ab12cd34-move", type: "hyperdisk-balanced", sizeGb: 50 })).toEqual({ name: "operation-3", zone });
    expect(await compute.deleteDisk(zone, "vm-hunt-s-ab12cd34")).toEqual({ name: "operation-4", zone });
    const deletion = await compute.deleteSnapshot("vm-hunt-s-ab12cd34-move");
    expect(deletion).toEqual({ name: "operation-5", zone: null });
    expect(await compute.operation(deletion)).toEqual({ isDone: true, error: null });
    await expect(compute.deleteSnapshot("vm-hunt-s-00000000-move")).rejects.toThrow("failed to delete the snapshot vm-hunt-s-00000000-move: HTTP 404 not found");
    expect(requests.slice(0, 5).map((request) => request.body)).toEqual([
      { name: "vm-hunt-s-ab12cd34-moving", currentName: "vm-hunt-s-ab12cd34" },
      undefined,
      undefined,
      { name: "vm-hunt-s-ab12cd34-move", storageLocations: ["europe-west3"] },
      { name: "vm-hunt-s-ab12cd34", sourceSnapshot: "global/snapshots/vm-hunt-s-ab12cd34-move", type: "zones/europe-west3-a/diskTypes/hyperdisk-balanced", sizeGb: "50" },
    ]);
    expect(describeComputeCall(`${PROJECT_URL}/global/snapshots/vm-hunt-s-ab12cd34-move`)).toBe("global/snapshots/vm-hunt-s-ab12cd34-move");
  });

  it("reads an instance, answers null for a missing one and sets metadata with the fingerprint", async () => {
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${ZONE_URL}/instances/vm-hunt-s-ab12cd34`]: () =>
        Response.json({ name: "vm-hunt-s-ab12cd34", status: "PROVISIONING", metadata: { fingerprint: "fp1", items: [{ key: "startup-script", value: "#!/bin/sh" }] } }),
      [`GET ${ZONE_URL}/instances/vm-hunt-s-00000000`]: () => new Response("not found", { status: 404 }),
      [`POST ${ZONE_URL}/instances/vm-hunt-s-ab12cd34/setMetadata`]: () => new Response("Supplied fingerprint does not match", { status: 412 }),
    });
    const compute = createCompute(fixedMetadata, fetchImpl);

    const instance = await compute.get("europe-west3-a", "vm-hunt-s-ab12cd34");
    expect(instance?.metadata).toEqual({ fingerprint: "fp1", items: [{ key: "startup-script", value: "#!/bin/sh" }] });
    expect(await compute.get("europe-west3-a", "vm-hunt-s-00000000")).toBeNull();
    await expect(compute.setMetadata("europe-west3-a", "vm-hunt-s-ab12cd34", "fp1", [])).rejects.toThrow(
      "failed to set the metadata of vm-hunt-s-ab12cd34: HTTP 412",
    );
    expect(requests.at(-1)?.body).toEqual({ fingerprint: "fp1", items: [] });
  });
});

describe("operations", () => {
  it("parses a stockout with the machine type it names, and falls back to the zone of the call", () => {
    const operation = parseOperation(
      {
        name: "operation-1792005009343",
        status: "DONE",
        error: {
          errors: [
            {
              code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
              message: "The zone 'projects/medconomy-hunt/zones/europe-west1-c' does not have enough resources available to fulfill the request.",
              errorDetails: [
                { help: { links: [] } },
                { errorInfo: { domain: "compute.googleapis.com", metadatas: { vmType: "c4d-standard-8", zone: "europe-west1-c" }, reason: "stockout" } },
              ],
            },
          ],
        },
      },
      "europe-west1-c",
    );
    expect(operation).toEqual({
      name: "operation-1792005009343",
      zone: "europe-west1-c",
      isDone: true,
      error: {
        code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
        message: "The zone 'projects/medconomy-hunt/zones/europe-west1-c' does not have enough resources available to fulfill the request.",
        machineType: "c4d-standard-8",
      },
    });
    expect(isStockout(operation.error!.code)).toBe(true);
    expect(isStockout("failed to create vm: HTTP 503 ZONE_RESOURCE_POOL_EXHAUSTED")).toBe(true);
    expect(isStockout("QUOTA_EXCEEDED")).toBe(false);
    expect(parseOperation({ status: "PENDING" }, "europe-west1-b")).toEqual({ name: "", zone: "europe-west1-b", isDone: false, error: null });
  });
});

describe("Compute Engine log", () => {
  it("names the zone, resource and filter of a call without base and project", () => {
    expect(describeComputeCall(`${ZONE_URL}/instances/vm-hunt-s-ab12cd34/start`)).toBe("zones/europe-west3-a/instances/vm-hunt-s-ab12cd34/start");
    expect(describeComputeCall(`${ZONE_URL}/instances?filter=${encodeURIComponent('labels.hunt-origin = "swf"')}&pageToken=p2`)).toBe(
      'zones/europe-west3-a/instances, filter labels.hunt-origin = "swf"',
    );
    expect(
      describeComputeCall(
        `https://compute.googleapis.com/compute/v1/projects/medconomy-hunt/aggregated/instances?returnPartialSuccess=true&filter=${encodeURIComponent("labels.a = b")}`,
      ),
    ).toBe("aggregated/instances, filter labels.a = b");
  });

  it("logs every call with its HTTP status or why it failed, and the duration", async () => {
    const instance = `${ZONE_URL}/instances/vm-hunt-s-ab12cd34`;
    const { fetchImpl } = fakeFetch({
      [`GET ${instance}`]: () => new Response("not found", { status: 404 }),
      [`POST ${instance}/start`]: () => Response.json({ kind: "compute#operation" }),
    });
    const lines: string[] = [];
    const compute = createCompute(fixedMetadata, fetchImpl, (message) => lines.push(message));

    expect(await compute.get("europe-west3-a", "vm-hunt-s-ab12cd34")).toBeNull();
    await compute.start("europe-west3-a", "vm-hunt-s-ab12cd34");
    await expect(compute.stop("europe-west3-a", "vm-hunt-s-ab12cd34")).rejects.toThrow("unexpected request");
    expect(lines.map((line) => line.replace(/\d+ ms/, "N ms"))).toEqual([
      "Compute Engine GET zones/europe-west3-a/instances/vm-hunt-s-ab12cd34: HTTP 404 in N ms",
      "Compute Engine POST zones/europe-west3-a/instances/vm-hunt-s-ab12cd34/start: HTTP 200 in N ms",
      `Compute Engine POST zones/europe-west3-a/instances/vm-hunt-s-ab12cd34/stop: failed after N ms: unexpected request POST ${instance}/stop`,
    ]);
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
      lastStopTimestamp: "",
      lastSuspendedTimestamp: "",
      labels: { a: "b" },
      metadata: { fingerprint: "", items: [] },
      disks: [],
      machineType: "",
    });
  });

  it("parses the zone, creation and stop times and disks of an instance and reads a metadata item", () => {
    const instance = parseInstance({
      name: "vm-hunt-s-ab12cd34",
      zone: "https://www.googleapis.com/compute/v1/projects/medconomy-hunt/zones/europe-west3-a",
      creationTimestamp: "2026-10-13T01:02:03.456-07:00",
      lastStopTimestamp: "2026-10-14T01:02:03.456-07:00",
      metadata: { items: [{ key: "hunt-session-id", value: "ab12cd34-0000-4000-8000-000000000001" }] },
      machineType: "https://www.googleapis.com/compute/v1/projects/medconomy-hunt/zones/europe-west3-a/machineTypes/c4d-standard-8",
      disks: [
        { deviceName: "persistent-disk-0", autoDelete: true, boot: true, source: "https://www.googleapis.com/compute/v1/projects/medconomy-hunt/zones/europe-west3-a/disks/vm-hunt-s-ab12cd34" },
        { deviceName: "data", autoDelete: false },
        { autoDelete: true },
      ],
    });
    expect(instance).toMatchObject({
      zone: "europe-west3-a",
      creationTimestamp: "2026-10-13T01:02:03.456-07:00",
      lastStopTimestamp: "2026-10-14T01:02:03.456-07:00",
      lastSuspendedTimestamp: "",
      machineType: "c4d-standard-8",
      disks: [
        { deviceName: "persistent-disk-0", autoDelete: true, boot: true, source: "vm-hunt-s-ab12cd34" },
        { deviceName: "data", autoDelete: false, boot: false, source: "" },
      ],
    });
    expect(metadataValue(instance, "hunt-session-id")).toBe("ab12cd34-0000-4000-8000-000000000001");
    expect(metadataValue(instance, "hunt-repo")).toBeNull();
  });

  it("parses a disk's type and size, and a zone's region", () => {
    expect(parseDisk({ type: `${ZONE_URL}/diskTypes/hyperdisk-balanced`, sizeGb: "50" })).toEqual({ type: "hyperdisk-balanced", sizeGb: 50 });
    expect(parseDisk({})).toEqual({ type: "", sizeGb: 0 });
    expect(regionOf("europe-west1-c")).toBe("europe-west1");
  });
});
