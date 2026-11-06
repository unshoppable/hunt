import type { PreviewService, PreviewStatus } from "./preview.types";
import handoffStartPrompt from "../../prompts/chat/handoff-start.user-prompt.md?raw";

/** How a state reads in the Terminal tab: answering, on its way, needing a look, broken, or at rest. */
export type Tone = "ok" | "pending" | "warning" | "error" | "idle";

export type Description = { text: string; tone: Tone };

/** A service's state as the Terminal tab shows it; while the VM is off, enabled services start again with it. */
export function describeService(service: PreviewService, isVmRunning: boolean): Description {
  if (!isVmRunning) return { text: service.enabled ? "Starts with the VM" : "Stopped", tone: "idle" };
  switch (service.state) {
    case "running":
      return service.responds ? { text: "Running", tone: "ok" } : { text: "Running, not answering yet", tone: "warning" };
    case "starting":
      return { text: "Starting…", tone: "pending" };
    case "failed":
      return { text: "Failed", tone: "error" };
    case "stopped":
      return { text: "Stopped", tone: "idle" };
  }
}

/** Whether the unit of `service` runs or is about to, so that its tab offers Stop rather than Start. */
export function isServiceRunning(service: PreviewService): boolean {
  return service.state === "running" || service.state === "starting";
}

/**
 * What Hunt asks the agent right after it handed off a session whose chat holds a prompt, when hunt.json declares
 * services and none of them runs or starts.
 */
export const HANDOFF_START_PROMPT = handoffStartPrompt.trim();

/** Whether a service of hunt.json runs or is starting. */
export function hasRunningService(status: PreviewStatus): boolean {
  return status.services.some(isServiceRunning);
}

/** Whether a service of hunt.json runs or starts on the running VM, for the Terminal tab's green dot. */
export function isPreviewActive(status: PreviewStatus | null): boolean {
  return Boolean(status?.vmRunning && hasRunningService(status));
}

/** Whether the port of a service of hunt.json listens on the VM. */
export function hasRespondingService(status: PreviewStatus): boolean {
  return status.services.some((service) => service.responds);
}

/**
 * Whether the Terminal tab offers to have the agent start the app: no service runs or starts, and hunt.json declares
 * services or the VM is off, so its services are not known yet.
 */
export function offersStart(status: PreviewStatus): boolean {
  return !hasRunningService(status) && (status.services.length > 0 || !status.vmRunning);
}

/**
 * The status to show after `next` arrives: while the VM is off, the VM reports no services, so the ones `previous`
 * knew stay listed as stopped and not answering.
 */
export function withLastKnown(previous: PreviewStatus | null, next: PreviewStatus): PreviewStatus {
  if (next.vmRunning || next.services.length || !previous?.services.length) return next;
  return { ...next, services: previous.services.map((service) => ({ ...service, state: "stopped", responds: false, invocation: null })) };
}
