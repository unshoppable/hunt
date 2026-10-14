/**
 * The Google Cloud APIs the gateway's services use, with the access token of the gateway's service account from the
 * metadata server: the metadata server itself (project, zone, token, instance attributes), Secret Manager (the poller's
 * tokens) and Compute Engine (the session VMs in the gateway's project and zone). Plain REST through `fetch`; no
 * dependencies.
 */
import { messageOf } from "../../../libs/domain/src/errors.ts";

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const COMPUTE = "https://compute.googleapis.com/compute/v1";
const SECRET_MANAGER = "https://secretmanager.googleapis.com/v1";
/** A cached access token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;
const ERROR_TEXT_LIMIT = 300;

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

/** The text of a Secret Manager `versions/<v>:access` response: its base64 payload, without surrounding whitespace. */
export function parseSecretPayload(text: string, name: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`failed to read the secret ${name}: the response is no JSON`);
  }
  const data = (body as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (typeof data !== "string") throw new Error(`failed to read the secret ${name}: the response has no payload`);
  const secret = Buffer.from(data, "base64").toString("utf8").trim();
  if (!secret || /\s/.test(secret)) throw new Error(`failed to read the secret ${name}: its latest version is empty or contains whitespace`);
  return secret;
}

/** The error of a failed API call; the response body is cut short and holds no secret of the request. */
async function failure(response: Response, what: string): Promise<Error> {
  const text = (await response.text()).replace(/\s+/g, " ").slice(0, ERROR_TEXT_LIMIT);
  return new Error(`failed to ${what}: HTTP ${response.status} ${text}`);
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

/** Reads the latest version of the secret `name` in the gateway's project. */
export async function readSecret(metadata: Metadata, name: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `${SECRET_MANAGER}/projects/${encodeURIComponent(await metadata.project())}/secrets/${encodeURIComponent(name)}/versions/latest:access`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${await metadata.accessToken()}` } });
  if (!response.ok) throw await failure(response, `read the secret ${name}`);
  return parseSecretPayload(await response.text(), name);
}

/** A VM as Compute Engine lists it. */
export interface Instance {
  name: string;
  /** The zone's name, e.g. `europe-west3-a`; empty when the resource names none. */
  zone: string;
  /** E.g. `PROVISIONING`, `RUNNING`, `STOPPING`, `TERMINATED`. */
  status: string;
  /** RFC 3339, as Compute Engine writes it; empty when the resource names none. */
  creationTimestamp: string;
  labels: Record<string, string>;
  metadata: { fingerprint: string; items: MetadataItem[] };
  disks: AttachedDisk[];
}

export interface AttachedDisk {
  deviceName: string;
  /** Whether Compute Engine deletes the disk with the VM. */
  autoDelete: boolean;
}

export interface MetadataItem {
  key: string;
  value: string;
}

/** What `instances.insert` gets besides the instance template. */
export interface InstanceRequest {
  name: string;
  template: string;
  /** Replace the template's labels, so they repeat its `hunt-role`. */
  labels: Record<string, string>;
  machineType: string | null;
}

/**
 * The Compute Engine calls of the gateway's services, on VMs in the gateway's project and zone. Calls that change a VM
 * return once Compute Engine accepted the request; the VM's status shows when it is done.
 */
export interface Compute {
  /** The VMs of every zone of the gateway's project that match the list filter `filter`. */
  list(filter: string): Promise<Instance[]>;
  /** The VMs in the gateway's zone whose label `key` is `value`. */
  listByLabel(key: string, value: string): Promise<Instance[]>;
  /** The VM `name`; null when it does not exist. */
  get(name: string): Promise<Instance | null>;
  /** Requests the VM from the instance template. */
  insert(request: InstanceRequest): Promise<void>;
  /** Replaces the VM's metadata items; `fingerprint` is the one of the metadata read before. */
  setMetadata(name: string, fingerprint: string, items: MetadataItem[]): Promise<void>;
  /** Starts a `TERMINATED` (or `STOPPED`) VM. */
  start(name: string): Promise<void>;
  /** Resumes a `SUSPENDED` VM. */
  resume(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  /** Makes Compute Engine delete the disk `deviceName` with the VM. */
  setDiskAutoDelete(name: string, deviceName: string): Promise<void>;
  /** Deletes the VM and the disks whose `autoDelete` is set. */
  delete(name: string): Promise<void>;
}

/** `entries` set in `items`: existing keys get the new value, the other items stay as they are. */
export function mergeMetadataItems(items: MetadataItem[], entries: Record<string, string>): MetadataItem[] {
  const merged = items.filter((item) => !Object.hasOwn(entries, item.key));
  for (const [key, value] of Object.entries(entries)) {
    merged.push({ key, value });
  }
  return merged;
}

/** The last segment of a resource URL such as `https://…/projects/p/zones/europe-west3-a`. */
function lastSegment(value: unknown): string {
  return typeof value === "string" ? (value.split("/").pop() ?? "") : "";
}

/** An instance resource of the Compute Engine API in the shape the gateway reads. */
export function parseInstance(value: unknown): Instance {
  const raw = (value ?? {}) as {
    name?: unknown;
    zone?: unknown;
    status?: unknown;
    creationTimestamp?: unknown;
    labels?: unknown;
    metadata?: { fingerprint?: unknown; items?: unknown };
    disks?: unknown;
  };
  const labels: Record<string, string> = {};
  if (raw.labels && typeof raw.labels === "object") {
    for (const [key, label] of Object.entries(raw.labels)) {
      if (typeof label === "string") {
        labels[key] = label;
      }
    }
  }
  const items = Array.isArray(raw.metadata?.items) ? (raw.metadata.items as { key?: unknown; value?: unknown }[]) : [];
  const disks = Array.isArray(raw.disks) ? (raw.disks as { deviceName?: unknown; autoDelete?: unknown }[]) : [];
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    zone: lastSegment(raw.zone),
    status: typeof raw.status === "string" ? raw.status : "",
    creationTimestamp: typeof raw.creationTimestamp === "string" ? raw.creationTimestamp : "",
    labels,
    metadata: {
      fingerprint: typeof raw.metadata?.fingerprint === "string" ? raw.metadata.fingerprint : "",
      items: items
        .filter((item) => typeof item.key === "string")
        .map((item) => ({ key: item.key as string, value: typeof item.value === "string" ? item.value : "" })),
    },
    disks: disks
      .filter((disk) => typeof disk.deviceName === "string")
      .map((disk) => ({ deviceName: disk.deviceName as string, autoDelete: disk.autoDelete === true })),
  };
}

/** The value of the metadata item `key`; null without one. */
export function metadataValue(instance: Instance, key: string): string | null {
  return instance.metadata.items.find((item) => item.key === key)?.value ?? null;
}

/**
 * The resource and filter of the Compute Engine call `url` for the log, without the API's base, the project and the zone:
 * e.g. `instances/vm-hunt-s-ab12cd34/start` or `aggregated/instances, filter labels.hunt-role = "session"`.
 */
export function describeComputeCall(url: string): string {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname.replace(/^\/compute\/v1\/projects\/[^/]+\/(zones\/[^/]+\/)?/, ""));
  const filter = parsed.searchParams.get("filter");
  return filter ? `${path}, filter ${filter}` : path;
}

/** `log` hears one line per API call: method, resource, HTTP status (or why the call failed) and duration. */
export function createCompute(metadata: Metadata, fetchImpl: typeof fetch = fetch, log: (message: string) => void = () => {}): Compute {
  async function zoneUrl(): Promise<string> {
    return `${COMPUTE}/projects/${encodeURIComponent(await metadata.project())}/zones/${encodeURIComponent(await metadata.zone())}`;
  }

  async function call(method: "GET" | "POST" | "DELETE", url: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await metadata.accessToken()}` };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const what = `Compute Engine ${method} ${describeComputeCall(url)}`;
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      log(`${what}: HTTP ${response.status} in ${Date.now() - startedAt} ms`);
      return response;
    } catch (error) {
      log(`${what}: failed after ${Date.now() - startedAt} ms: ${messageOf(error)}`);
      throw error;
    }
  }

  async function instanceUrl(name: string): Promise<string> {
    return `${await zoneUrl()}/instances/${encodeURIComponent(name)}`;
  }

  async function post(name: string, verb: string, what: string, query = ""): Promise<void> {
    const response = await call("POST", `${await instanceUrl(name)}/${verb}${query}`);
    if (!response.ok) throw await failure(response, what);
  }

  /** Every page of the list at `base` with `filter`; `itemsOf` takes the instances out of one page. */
  async function pages(base: string, filter: string, what: string, itemsOf: (page: Record<string, unknown>) => unknown[]): Promise<Instance[]> {
    const instances: Instance[] = [];
    let pageToken = "";
    do {
      const url = `${base}${base.includes("?") ? "&" : "?"}filter=${encodeURIComponent(filter)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const response = await call("GET", url);
      if (!response.ok) throw await failure(response, what);
      const page = (await response.json()) as Record<string, unknown>;
      instances.push(...itemsOf(page).map(parseInstance));
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
    } while (pageToken);
    return instances;
  }

  return {
    async list(filter) {
      const base = `${COMPUTE}/projects/${encodeURIComponent(await metadata.project())}/aggregated/instances?returnPartialSuccess=true`;
      // `items` maps each zone (`zones/<zone>`) to its instances, or to a warning for a zone without any.
      return pages(base, filter, `list the VMs matching ${filter}`, (page) =>
        Object.values((page.items ?? {}) as Record<string, { instances?: unknown[] }>).flatMap((scope) => scope.instances ?? []),
      );
    },
    async listByLabel(key, value) {
      const what = `list the VMs labelled ${key}=${value}`;
      const instances = await pages(`${await zoneUrl()}/instances`, `labels.${key} = "${value}"`, what, (page) => (Array.isArray(page.items) ? page.items : []));
      return instances.filter((instance) => instance.labels[key] === value);
    },
    async get(name) {
      const response = await call("GET", await instanceUrl(name));
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, `look up ${name}`);
      return parseInstance(await response.json());
    },
    async insert(request) {
      const project = await metadata.project();
      const zone = await metadata.zone();
      const template = `projects/${project}/global/instanceTemplates/${request.template}`;
      const body: Record<string, unknown> = { name: request.name, labels: request.labels };
      if (request.machineType) {
        body.machineType = `zones/${zone}/machineTypes/${request.machineType}`;
      }
      const response = await call("POST", `${await zoneUrl()}/instances?sourceInstanceTemplate=${encodeURIComponent(template)}`, body);
      if (!response.ok) throw await failure(response, `create ${request.name} from ${request.template}`);
    },
    async setMetadata(name, fingerprint, items) {
      const response = await call("POST", `${await instanceUrl(name)}/setMetadata`, { fingerprint, items });
      if (!response.ok) throw await failure(response, `set the metadata of ${name}`);
    },
    start: (name) => post(name, "start", `start ${name}`),
    resume: (name) => post(name, "resume", `resume ${name}`),
    stop: (name) => post(name, "stop", `stop ${name}`),
    setDiskAutoDelete: (name, deviceName) =>
      post(name, "setDiskAutoDelete", `make ${name} delete its disk ${deviceName}`, `?autoDelete=true&deviceName=${encodeURIComponent(deviceName)}`),
    async delete(name) {
      const response = await call("DELETE", await instanceUrl(name));
      if (!response.ok) throw await failure(response, `delete ${name}`);
    },
  };
}
