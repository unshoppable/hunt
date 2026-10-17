/**
 * The gateway API: the control plane of remote sessions, served by `hunt-api.service` on the gateway. The desktop app
 * calls it over its SSH connection to the gateway as `hunt-api <method>` with the request as one JSON object on stdin;
 * stdout carries NDJSON events, `progress` and `log` lines and then exactly one `result` (exit 0) or `error` (exit 1).
 * The app passes only session IDs: the server derives the VM name (`vm-hunt-s-<first 8 hex digits>`) and owns project,
 * zone, instance template and preview domain. `api` in `libs/domain/protocol.json` numbers this contract.
 */
import type { RemoteSecretSummary } from "./remoteSecrets.ts";

/**
 * The progress steps the server reports; the desktop's `RemoteStep` serde names, unknown ones are ignored. `movingVm`
 * follows `startingVm` when the VM's zone has no capacity for it and the gateway moves it to another zone.
 */
export type ProgressStep = "creatingVm" | "startingVm" | "movingVm" | "waitingForVm" | "installingRuntime";

export type ErrorCode = "invalidParams" | "notFound" | "conflict" | "forbidden" | "unavailable" | "internal";

export type ApiEvent =
  | { type: "progress"; step: ProgressStep }
  | { type: "log"; message: string }
  | { type: "result"; data: unknown }
  | { type: "error"; code: ErrorCode; message: string };

export interface VmRef {
  project: string;
  zone: string;
  instance: string;
}

export interface ReleaseInfo {
  /** `.version` of the VM's release, null without one. */
  version: string | null;
  protocol: number | null;
}

export interface HelloResult {
  api: number;
  protocol: number;
  /** The gateway's own release version. */
  release: string;
  project: string;
  zone: string;
  previewDomain: string;
  /** The OS Login user that called. */
  caller: string;
}

export interface SessionSummary {
  id: string;
  vm: string;
  zone: string;
  /** Compute Engine status: PROVISIONING, STAGING, RUNNING, STOPPING, SUSPENDED, TERMINATED, … */
  status: string;
  /** `desktop` or `swf`. */
  origin: string;
  /** The OS Login user who created it; empty for VMs the poller created. */
  owner: string;
  repo: string;
  branch: string;
  title: string;
  /** The GitHub issue of a poller session. */
  issue: number | null;
  /**
   * The state of a poller session's agent as its VM records it: `running`, `question` (it waits for an answer on the
   * issue), `done` or `failed`; empty for a person's session.
   */
  agent: string;
  createdAt: string;
}

/** Request and result of every method. */
export interface Methods {
  hello: { request: Record<string, never>; result: HelloResult };
  "sessions.list": { request: Record<string, never>; result: { sessions: SessionSummary[] } };
  "vms.get": { request: { id: string }; result: { exists: boolean; name: string; status: string | null } };
  /** Creates the session's VM unless it exists, records the session in its metadata, starts it, waits for its startup
   *  script and updates its release; streams progress. `conflict` when the VM holds another session. */
  "sessions.provision": {
    /** `machineType`, one of `SESSION_MACHINE_TYPES`, replaces the template's for a VM it creates; null or absent keeps
     *  the template's. An existing VM keeps its machine type. */
    request: { id: string; title: string; repo: string; branch: string; machineType?: string | null };
    result: { vm: VmRef; created: boolean; release: ReleaseInfo };
  };
  /** Starts or resumes the session's VM unless it runs, waits until it answers and updates its release; streams. */
  "vms.start": { request: { id: string }; result: { vm: VmRef; wasRunning: boolean; release: ReleaseInfo } };
  "vms.stop": { request: { id: string }; result: Record<string, never> };
  "vms.delete": { request: { id: string }; result: { alreadyGone: boolean } };
  /** The remote secrets (`remoteSecrets.ts`) by name, each with the hint of its value; never a value. */
  "secrets.list": { request: Record<string, never>; result: { secrets: RemoteSecretSummary[] } };
  /** Creates or replaces a remote secret; session VMs the gateway brings up afterwards get it. */
  "secrets.set": { request: { name: string; value: string }; result: Record<string, never> };
  "secrets.delete": { request: { name: string }; result: { existed: boolean } };
}

export type Method = keyof Methods;

export const METHODS: readonly Method[] = [
  "hello",
  "sessions.list",
  "vms.get",
  "sessions.provision",
  "vms.start",
  "vms.stop",
  "vms.delete",
  "secrets.list",
  "secrets.set",
  "secrets.delete",
];
