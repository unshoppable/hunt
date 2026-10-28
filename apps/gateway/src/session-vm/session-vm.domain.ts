/**
 * A session VM as Compute Engine lists it (`gcp/compute-engine.client.ts`): a VM labelled `hunt-role=session` and named
 * `vm-hunt-s-<short id>` after the session it holds. Its labels (`hunt-session=<short id>`, `hunt-origin=desktop|swf`
 * and, for a person's session, `hunt-owner=<OS Login user>`) and its metadata (`hunt-session-id`, `hunt-repo`,
 * `hunt-branch`, `hunt-title`, `hunt-issue` and, for a poller session, the agent state `hunt-agent`) are the directory
 * of remote sessions: the session VM service (`session-vm/session-vm.service.ts`) writes them when it creates and
 * provisions the VM, the poller (`swf/poller.service.ts`) keeps `hunt-agent` up to date.
 *
 * The model answers what the gateway reads of a VM: the session it holds and its entry in the session list, whether
 * it runs or is off and since when, and whether its metadata records given entries; it refuses a VM that holds another
 * session. It has no intents: every change of a VM is a Compute Engine call of the service, which reads the VM anew.
 */
import * as z from "zod/mini";
import type { SessionSummary } from "../../../../libs/domain/src/gateway-api/gateway-api.types.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import { DomainModel } from "../../../../libs/domain/src/model/domain.model.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { isOffStatus, isStoppedStatus } from "../../../../libs/domain/src/session/vm-status.utils.ts";
import type { Instance } from "../gcp/compute-engine.client.ts";

export const ROLE_LABEL = "hunt-role";
export const SESSION_LABEL = "hunt-session";
export const ORIGIN_LABEL = "hunt-origin";
export const OWNER_LABEL = "hunt-owner";
export const SESSION_ROLE = "session";
/** The Compute Engine filter that lists the session VMs: the VMs labelled `hunt-role=session`. */
export const SESSION_VM_FILTER = `labels.${ROLE_LABEL} = "${SESSION_ROLE}"`;
export const SESSION_ID_METADATA = "hunt-session-id";
export const REPO_METADATA = "hunt-repo";
export const BRANCH_METADATA = "hunt-branch";
export const TITLE_METADATA = "hunt-title";
/** The metadata key of the GitHub issue of a poller session. */
export const ISSUE_METADATA = "hunt-issue";
/** The metadata key of the agent state of a poller session (`AgentState` in `libs/domain/src/swf/swf-step.types.ts`). */
export const AGENT_METADATA = "hunt-agent";
/** An issue number as `hunt-issue` records it. */
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

const ZodSessionVmState = z.object({
  name: z.string(),
  /** The VM's zone; empty when neither Compute Engine nor the caller of `fromInstance` names one. */
  zone: z.string(),
  /** The Compute Engine status, e.g. `PROVISIONING`, `RUNNING`, `SUSPENDED`, `TERMINATED`. */
  status: z.string(),
  /** RFC 3339; empty when Compute Engine names none. */
  creationTimestamp: z.string(),
  /** When the VM was last stopped, RFC 3339; empty for one that never was. */
  lastStopTimestamp: z.string(),
  /** When the VM was last suspended, RFC 3339; empty for one that never was. */
  lastSuspendedTimestamp: z.string(),
  labels: z.record(z.string(), z.string()),
  /** The VM's metadata items by key. */
  metadata: z.record(z.string(), z.string()),
});

export interface SessionVm extends z.infer<typeof ZodSessionVmState> {}

export class SessionVm extends DomainModel<typeof ZodSessionVmState> {
  static readonly schema = ZodSessionVmState;

  constructor(value: z.input<typeof ZodSessionVmState>) {
    super(value);
  }

  /**
   * `instance` as a session VM, in `fallbackZone` when Compute Engine names no zone; null for a VM without the label
   * `hunt-role=session`. Of metadata items with the same key, the first counts.
   */
  static fromInstance(instance: Instance, fallbackZone = ""): SessionVm | null {
    if (instance.labels[ROLE_LABEL] !== SESSION_ROLE) return null;
    const metadata: Record<string, string> = {};
    for (const { key, value } of instance.metadata.items) {
      if (Object.hasOwn(metadata, key)) continue;
      metadata[key] = value;
    }
    return new SessionVm({
      name: instance.name,
      zone: instance.zone || fallbackZone,
      status: instance.status,
      creationTimestamp: instance.creationTimestamp,
      lastStopTimestamp: instance.lastStopTimestamp,
      lastSuspendedTimestamp: instance.lastSuspendedTimestamp,
      labels: instance.labels,
      metadata,
    });
  }

  /**
   * The session the VM holds: the ID its metadata records, when the VM carries that session's name; null for a VM that
   * records no valid session ID or one of another VM, such as a VM under its moving name.
   */
  get sessionId(): SessionId | null {
    const id = this.metadataValue(SESSION_ID_METADATA);
    if (!SessionId.isValid(id)) return null;
    const sessionId = SessionId.of(id);
    return sessionId.vm.name === this.name ? sessionId : null;
  }

  /** `desktop` or `swf`; empty without the label. */
  get origin(): string {
    return this.labels[ORIGIN_LABEL] ?? "";
  }

  /** The OS Login user who asked for the session, as a label value; empty for a poller session. */
  get owner(): string {
    return this.labels[OWNER_LABEL] ?? "";
  }

  get repo(): string {
    return this.metadataValue(REPO_METADATA);
  }

  get branch(): string {
    return this.metadataValue(BRANCH_METADATA);
  }

  get title(): string {
    return this.metadataValue(TITLE_METADATA);
  }

  /** The GitHub issue of a poller session; null for a person's session and for a value that is no issue number. */
  get issue(): number | null {
    const issue = this.metadataValue(ISSUE_METADATA);
    return ISSUE_NUMBER.test(issue) ? Number(issue) : null;
  }

  /** The agent state of a poller session; empty for a person's session. */
  get agent(): string {
    return this.metadataValue(AGENT_METADATA);
  }

  get isRunning(): boolean {
    return this.status === "RUNNING";
  }

  /** Whether the VM is stopped (`isStoppedStatus`) or on its way there, so that a stop has nothing left to do. */
  get isStoppedOrStopping(): boolean {
    return isStoppedStatus(this.status) || this.status === "STOPPING";
  }

  /** Whether the VM is stopped or suspended (`isOffStatus`). */
  get isOff(): boolean {
    return isOffStatus(this.status);
  }

  /** When the VM went off: its last stop or suspension; null while it is not off or when Compute Engine records no time. */
  get offSince(): number | null {
    let time = "";
    if (isStoppedStatus(this.status)) {
      time = this.lastStopTimestamp;
    } else if (this.status === "SUSPENDED") {
      time = this.lastSuspendedTimestamp;
    }
    const parsed = Date.parse(time);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /** The VM's entry in the session list of the gateway API; null for a VM that holds no session (`sessionId`). */
  get summary(): SessionSummary | null {
    const sessionId = this.sessionId;
    if (!sessionId) return null;
    return {
      id: sessionId.id,
      vm: this.name,
      zone: this.zone,
      status: this.status,
      origin: this.origin,
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      title: this.title,
      issue: this.issue,
      agent: this.agent,
      createdAt: this.creationTimestamp,
    };
  }

  /** Whether the metadata records every entry of `entries` with its value. */
  hasMetadataEntries(entries: Record<string, string>): boolean {
    return Object.entries(entries).every(([key, value]) => Object.hasOwn(this.metadata, key) && this.metadata[key] === value);
  }

  /**
   * Refuses, as a conflict, a VM whose metadata records another session than `sessionId`; a VM that records none, such
   * as one created a moment ago, holds any.
   */
  assertHoldsSession(sessionId: SessionId): void {
    const holder = this.metadataValue(SESSION_ID_METADATA);
    if (holder && holder !== sessionId.id) throw new ApiError("conflict", `${this.name} holds the session ${holder}, not ${sessionId.id}`);
  }

  /** The value of the metadata item `key`; empty without one. */
  private metadataValue(key: string): string {
    return Object.hasOwn(this.metadata, key) ? this.metadata[key] : "";
  }
}

/** `text` as a label value: lowercase letters, digits, `_` and `-`, at most 63 characters. */
export function labelValue(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
}
