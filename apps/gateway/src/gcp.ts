/**
 * The Google Cloud APIs the gateway's services use, with the access token of the gateway's service account from the
 * metadata server: the metadata server itself (project, zone, token, instance attributes), Secret Manager (the poller's
 * tokens, the private files of its repositories and the remote secrets) and Compute Engine (the session VMs in the
 * gateway's project, in any of its zones). Plain REST through `fetch`; no dependencies.
 */
import { messageOf } from "../../../libs/domain/src/errors.ts";
import type { Log } from "../../../libs/domain/src/journal.ts";

const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const COMPUTE = "https://compute.googleapis.com/compute/v1";
const SECRET_MANAGER = "https://secretmanager.googleapis.com/v1";
/** A cached access token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;
const ERROR_TEXT_LIMIT = 300;
/** The device name of the boot disk the session template attaches. */
export const BOOT_DEVICE_NAME = "persistent-disk-0";

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

async function authorization(metadata: Metadata): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await metadata.accessToken()}` };
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
  /** When the VM was last stopped, RFC 3339; empty for one that never was. */
  lastStopTimestamp: string;
  /** When the VM was last suspended, RFC 3339; empty for one that never was. */
  lastSuspendedTimestamp: string;
  labels: Record<string, string>;
  metadata: { fingerprint: string; items: MetadataItem[] };
  disks: AttachedDisk[];
  /** The machine type's name, e.g. `c4d-standard-8`; empty when the resource names none. */
  machineType: string;
}

export interface AttachedDisk {
  deviceName: string;
  /** Whether Compute Engine deletes the disk with the VM. */
  autoDelete: boolean;
  boot: boolean;
  /** The disk's name, in the VM's zone; empty when the resource names none. */
  source: string;
}

/** A disk resource in the shape the gateway reads: its type's name, e.g. `hyperdisk-balanced`, and its size. */
export interface Disk {
  type: string;
  sizeGb: number;
}

export interface MetadataItem {
  key: string;
  value: string;
}

/** An operation of Compute Engine, as the calls that change a resource return it; `zone` is null for a global one. */
export interface Operation {
  name: string;
  zone: string | null;
}

export interface OperationError {
  /** E.g. `ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS` or `QUOTA_EXCEEDED`. */
  code: string;
  message: string;
  /** The machine type a capacity error names (`errorInfo.metadatas.vmType`); null without one. */
  machineType: string | null;
}

export interface OperationState {
  isDone: boolean;
  /** The first error of a finished operation; null while it runs and when it succeeded. */
  error: OperationError | null;
}

/** Whether `text`, an error code or message, says the zone has no capacity for the VM (a stockout). */
export function isStockout(text: string): boolean {
  return text.includes("ZONE_RESOURCE_POOL_EXHAUSTED");
}

/** What `instances.insert` gets besides the instance template. */
export interface InstanceRequest {
  name: string;
  template: string;
  /** Replace the template's labels, so they repeat its `hunt-role`. */
  labels: Record<string, string>;
  machineType: string | null;
  /** Replace the template's metadata items; absent keeps the template's. */
  metadata?: MetadataItem[];
  /**
   * A boot disk Compute Engine creates with the VM from a snapshot of the project, of this type and size, named like
   * the VM and deleted with it, in place of the template's; absent keeps the template's.
   */
  bootDisk?: BootDiskFromSnapshot | null;
}

export interface BootDiskFromSnapshot {
  snapshot: string;
  type: string;
  sizeGb: number;
}

/**
 * The Compute Engine calls of the gateway's services, on VMs in the gateway's project; per-VM calls name the VM's zone.
 * Calls that change a VM return once Compute Engine accepted the request; their operation or the VM's status shows when
 * it is done.
 */
export interface Compute {
  /** The VMs of every zone of the gateway's project that match the list filter `filter`. */
  list(filter: string): Promise<Instance[]>;
  /** The VMs of every zone of the gateway's project whose label `key` is `value`. */
  listByLabel(key: string, value: string): Promise<Instance[]>;
  /** The VM `name` in whichever zone of the gateway's project holds it; null when none does. */
  locate(name: string): Promise<Instance | null>;
  /** The VM `name` in `zone`; null when it does not exist there. */
  get(zone: string, name: string): Promise<Instance | null>;
  /** Requests the VM from the instance template in `zone`. */
  insert(zone: string, request: InstanceRequest): Promise<Operation>;
  operation(operation: Operation): Promise<OperationState>;
  /** Renames the VM, which must be `TERMINATED`; `newName` must be free in the project. */
  setName(zone: string, name: string, newName: string): Promise<Operation>;
  /** The disk `name` in `zone`; fails when it does not exist. */
  getDisk(zone: string, name: string): Promise<Disk>;
  /** Requests a snapshot `snapshot` of the disk, stored in the zone's region. */
  createSnapshot(zone: string, disk: string, snapshot: string): Promise<Operation>;
  /** Requests the deletion of the snapshot; a global operation. Fails with `HTTP 404` for one that does not exist. */
  deleteSnapshot(snapshot: string): Promise<Operation>;
  /** Replaces the VM's metadata items; `fingerprint` is the one of the metadata read before. */
  setMetadata(zone: string, name: string, fingerprint: string, items: MetadataItem[]): Promise<void>;
  /** Starts a `TERMINATED` (or `STOPPED`) VM. */
  start(zone: string, name: string): Promise<Operation>;
  /** Resumes a `SUSPENDED` VM. */
  resume(zone: string, name: string): Promise<Operation>;
  stop(zone: string, name: string): Promise<void>;
  /** Makes Compute Engine delete the disk `deviceName` with the VM. */
  setDiskAutoDelete(zone: string, name: string, deviceName: string): Promise<void>;
  /** Deletes the VM and the disks whose `autoDelete` is set. */
  delete(zone: string, name: string): Promise<void>;
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

/** The region of a zone: `europe-west1` for `europe-west1-c`. */
export function regionOf(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

/** An instance resource of the Compute Engine API in the shape the gateway reads. */
export function parseInstance(value: unknown): Instance {
  const raw = (value ?? {}) as {
    name?: unknown;
    zone?: unknown;
    status?: unknown;
    creationTimestamp?: unknown;
    lastStopTimestamp?: unknown;
    lastSuspendedTimestamp?: unknown;
    labels?: unknown;
    metadata?: { fingerprint?: unknown; items?: unknown };
    disks?: unknown;
    machineType?: unknown;
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
  const disks = Array.isArray(raw.disks) ? (raw.disks as { deviceName?: unknown; autoDelete?: unknown; boot?: unknown; source?: unknown }[]) : [];
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    zone: lastSegment(raw.zone),
    status: typeof raw.status === "string" ? raw.status : "",
    creationTimestamp: typeof raw.creationTimestamp === "string" ? raw.creationTimestamp : "",
    lastStopTimestamp: typeof raw.lastStopTimestamp === "string" ? raw.lastStopTimestamp : "",
    lastSuspendedTimestamp: typeof raw.lastSuspendedTimestamp === "string" ? raw.lastSuspendedTimestamp : "",
    labels,
    metadata: {
      fingerprint: typeof raw.metadata?.fingerprint === "string" ? raw.metadata.fingerprint : "",
      items: items
        .filter((item) => typeof item.key === "string")
        .map((item) => ({ key: item.key as string, value: typeof item.value === "string" ? item.value : "" })),
    },
    disks: disks
      .filter((disk) => typeof disk.deviceName === "string")
      .map((disk) => ({ deviceName: disk.deviceName as string, autoDelete: disk.autoDelete === true, boot: disk.boot === true, source: lastSegment(disk.source) })),
    machineType: lastSegment(raw.machineType),
  };
}

/** A disk resource of the Compute Engine API in the shape the gateway reads. */
export function parseDisk(value: unknown): Disk {
  const raw = (value ?? {}) as { type?: unknown; sizeGb?: unknown };
  const sizeGb = Number(raw.sizeGb);
  return { type: lastSegment(raw.type), sizeGb: Number.isFinite(sizeGb) && sizeGb > 0 ? sizeGb : 0 };
}

/** An operation resource of the Compute Engine API; `zone` stands in when the resource names none, null for a global one. */
export function parseOperation(value: unknown, zone: string | null): Operation & OperationState {
  const raw = (value ?? {}) as { name?: unknown; zone?: unknown; status?: unknown; error?: { errors?: unknown } };
  const errors = Array.isArray(raw.error?.errors) ? (raw.error.errors as { code?: unknown; message?: unknown; errorDetails?: unknown }[]) : [];
  const first = errors[0];
  let error: OperationError | null = null;
  if (first) {
    const details = Array.isArray(first.errorDetails) ? (first.errorDetails as { errorInfo?: { metadatas?: { vmType?: unknown } } }[]) : [];
    const machineType = details.map((detail) => detail.errorInfo?.metadatas?.vmType).find((type) => typeof type === "string" && type);
    error = {
      code: typeof first.code === "string" ? first.code : "",
      message: typeof first.message === "string" ? first.message : "",
      machineType: typeof machineType === "string" ? machineType : null,
    };
  }
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    zone: lastSegment(raw.zone) || zone,
    isDone: raw.status === "DONE",
    error,
  };
}

/** The value of the metadata item `key`; null without one. */
export function metadataValue(instance: Instance, key: string): string | null {
  return instance.metadata.items.find((item) => item.key === key)?.value ?? null;
}

/**
 * The resource and filter of the Compute Engine call `url` for the log, without the API's base and the project: e.g.
 * `zones/europe-west1-c/instances/vm-hunt-s-ab12cd34/start` or `aggregated/instances, filter labels.hunt-role = "session"`.
 */
export function describeComputeCall(url: string): string {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname.replace(/^\/compute\/v1\/projects\/[^/]+\//, ""));
  const filter = parsed.searchParams.get("filter");
  return filter ? `${path}, filter ${filter}` : path;
}

/** `log` hears one line per API call: method, resource, HTTP status (or why the call failed) and duration. */
export function createCompute(metadata: Metadata, fetchImpl: typeof fetch = fetch, log: Log = () => {}): Compute {
  async function projectUrl(): Promise<string> {
    return `${COMPUTE}/projects/${encodeURIComponent(await metadata.project())}`;
  }

  async function zoneUrl(zone: string): Promise<string> {
    return `${await projectUrl()}/zones/${encodeURIComponent(zone)}`;
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
      log(`${what}: failed after ${Date.now() - startedAt} ms: ${messageOf(error)}`, "error");
      throw error;
    }
  }

  async function instanceUrl(zone: string, name: string): Promise<string> {
    return `${await zoneUrl(zone)}/instances/${encodeURIComponent(name)}`;
  }

  async function diskUrl(zone: string, name: string): Promise<string> {
    return `${await zoneUrl(zone)}/disks/${encodeURIComponent(name)}`;
  }

  async function post(zone: string, name: string, verb: string, what: string, query = ""): Promise<Response> {
    const response = await call("POST", `${await instanceUrl(zone, name)}/${verb}${query}`);
    if (!response.ok) throw await failure(response, what);
    return response;
  }

  /** The operation a successful call answered with. */
  async function operationOf(response: Response, zone: string | null): Promise<Operation> {
    const { name } = parseOperation(await response.json(), zone);
    return { name, zone };
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

  async function list(filter: string, what: string): Promise<Instance[]> {
    const base = `${await projectUrl()}/aggregated/instances?returnPartialSuccess=true`;
    // `items` maps each zone (`zones/<zone>`) to its instances, or to a warning for a zone without any.
    return pages(base, filter, what, (page) => Object.values((page.items ?? {}) as Record<string, { instances?: unknown[] }>).flatMap((scope) => scope.instances ?? []));
  }

  return {
    list: (filter) => list(filter, `list the VMs matching ${filter}`),
    async listByLabel(key, value) {
      const instances = await list(`labels.${key} = "${value}"`, `list the VMs labelled ${key}=${value}`);
      return instances.filter((instance) => instance.labels[key] === value);
    },
    async locate(name) {
      const instances = await list(`name = "${name}"`, `look up ${name}`);
      return instances.find((instance) => instance.name === name) ?? null;
    },
    async get(zone, name) {
      const response = await call("GET", await instanceUrl(zone, name));
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, `look up ${name}`);
      return parseInstance(await response.json());
    },
    async insert(zone, request) {
      const template = `projects/${await metadata.project()}/global/instanceTemplates/${request.template}`;
      const body: Record<string, unknown> = { name: request.name, labels: request.labels };
      if (request.machineType) {
        body.machineType = `zones/${zone}/machineTypes/${request.machineType}`;
      }
      if (request.metadata) {
        body.metadata = { items: request.metadata };
      }
      if (request.bootDisk) {
        const { snapshot, type, sizeGb } = request.bootDisk;
        const initializeParams = { diskName: request.name, sourceSnapshot: `global/snapshots/${snapshot}`, diskType: `zones/${zone}/diskTypes/${type}`, diskSizeGb: String(sizeGb) };
        body.disks = [{ boot: true, autoDelete: true, deviceName: BOOT_DEVICE_NAME, initializeParams }];
      }
      const response = await call("POST", `${await zoneUrl(zone)}/instances?sourceInstanceTemplate=${encodeURIComponent(template)}`, body);
      if (!response.ok) throw await failure(response, `create ${request.name} from ${request.template} in ${zone}`);
      return operationOf(response, zone);
    },
    async operation({ name, zone }) {
      const base = zone ? `${await zoneUrl(zone)}/operations` : `${await projectUrl()}/global/operations`;
      const response = await call("GET", `${base}/${encodeURIComponent(name)}`);
      if (!response.ok) throw await failure(response, `read the operation ${name}`);
      const { isDone, error } = parseOperation(await response.json(), zone);
      return { isDone, error };
    },
    async setName(zone, name, newName) {
      const response = await call("POST", `${await instanceUrl(zone, name)}/setName`, { name: newName, currentName: name });
      if (!response.ok) throw await failure(response, `rename ${name} to ${newName}`);
      return operationOf(response, zone);
    },
    async getDisk(zone, name) {
      const response = await call("GET", await diskUrl(zone, name));
      if (!response.ok) throw await failure(response, `look up the disk ${name} in ${zone}`);
      return parseDisk(await response.json());
    },
    async createSnapshot(zone, disk, snapshot) {
      const response = await call("POST", `${await diskUrl(zone, disk)}/createSnapshot`, { name: snapshot, storageLocations: [regionOf(zone)] });
      if (!response.ok) throw await failure(response, `snapshot the disk ${disk} in ${zone} as ${snapshot}`);
      return operationOf(response, zone);
    },
    async deleteSnapshot(snapshot) {
      const response = await call("DELETE", `${await projectUrl()}/global/snapshots/${encodeURIComponent(snapshot)}`);
      if (!response.ok) throw await failure(response, `delete the snapshot ${snapshot}`);
      return operationOf(response, null);
    },
    async setMetadata(zone, name, fingerprint, items) {
      const response = await call("POST", `${await instanceUrl(zone, name)}/setMetadata`, { fingerprint, items });
      if (!response.ok) throw await failure(response, `set the metadata of ${name}`);
    },
    start: async (zone, name) => operationOf(await post(zone, name, "start", `start ${name}`), zone),
    resume: async (zone, name) => operationOf(await post(zone, name, "resume", `resume ${name}`), zone),
    async stop(zone, name) {
      await post(zone, name, "stop", `stop ${name}`);
    },
    async setDiskAutoDelete(zone, name, deviceName) {
      await post(zone, name, "setDiskAutoDelete", `make ${name} delete its disk ${deviceName}`, `?autoDelete=true&deviceName=${encodeURIComponent(deviceName)}`);
    },
    async delete(zone, name) {
      const response = await call("DELETE", await instanceUrl(zone, name));
      if (!response.ok) throw await failure(response, `delete ${name}`);
    },
  };
}
