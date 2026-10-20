import type { PreviewService, PreviewServiceState, PreviewStatus, TmuxWindow } from "../ipc/types";
import handoffStartPrompt from "../../prompts/handoff-start.user-prompt.md?raw";

/** How a state reads in the Preview tab: answering, on its way, needing a look, broken, or at rest. */
export type Tone = "ok" | "pending" | "warning" | "error" | "idle";

export type Description = { text: string; tone: Tone };

/** A service's state as the Preview tab shows it; while the VM is off, enabled services start again with it. */
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

/**
 * Whether the Preview and Terminal tabs list a service: it runs, starts or failed; while the VM is off, it starts with
 * the VM. Stopped services stay hidden.
 */
export function isServiceInUse(service: PreviewService, isVmRunning: boolean): boolean {
  return isVmRunning ? service.state !== "stopped" : service.enabled;
}

/** The preview as the Preview tab's header sums it up: whether the VM runs and how many services run, start or failed. */
export function describePreview(status: PreviewStatus | null): Description {
  if (!status) return { text: "…", tone: "idle" };
  if (!status.vmRunning) return { text: "VM off", tone: "idle" };
  const { services } = status;
  if (!services.length) return { text: "No services in hunt.json", tone: "idle" };
  const running = countInState(services, "running");
  const starting = countInState(services, "starting");
  const failed = countInState(services, "failed");
  const parts: string[] = [];
  if (running) {
    parts.push(`${running} of ${services.length} running`);
  }
  if (starting) {
    parts.push(`${starting} starting`);
  }
  if (failed) {
    parts.push(`${failed} failed`);
  }
  if (!parts.length) return { text: "No service running", tone: "idle" };
  return { text: parts.join(", "), tone: failed ? "error" : running ? "ok" : "pending" };
}

/**
 * What Hunt asks the agent right after it handed off a session whose chat holds a prompt, when hunt.json declares
 * services and none of them runs or starts.
 */
export const HANDOFF_START_PROMPT = handoffStartPrompt.trim();

/** Whether a service of hunt.json runs or is starting. */
export function hasRunningService(status: PreviewStatus): boolean {
  return status.services.some((service) => service.state === "running" || service.state === "starting");
}

/** Whether the Preview tab carries a green dot: a service of hunt.json runs or starts on the running VM. */
export function isPreviewActive(status: PreviewStatus | null): boolean {
  return Boolean(status?.vmRunning && hasRunningService(status));
}

/** Whether the Terminal tab carries a green dot: a service of hunt.json runs or starts, or a tmux window exists. */
export function isTerminalActive(status: PreviewStatus | null, windows: readonly TmuxWindow[] | null): boolean {
  return isPreviewActive(status) || Boolean(windows?.length);
}

/** Whether the port of a service of hunt.json listens on the VM. */
export function hasRespondingService(status: PreviewStatus): boolean {
  return status.services.some((service) => service.responds);
}

/**
 * Whether the Preview tab offers to have the agent start the app: no service runs or starts, and hunt.json declares
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
  return { ...next, services: previous.services.map((service) => ({ ...service, state: "stopped", responds: false })) };
}

/** Whether the Preview tab polls often: while it waits for the agent to start the app or while a service starts. */
export function shouldPollFast(status: PreviewStatus | null, isAwaitingStart: boolean): boolean {
  return isAwaitingStart || Boolean(status?.services.some((service) => service.state === "starting"));
}

function countInState(services: PreviewService[], state: PreviewServiceState): number {
  return services.filter((service) => service.state === state).length;
}
