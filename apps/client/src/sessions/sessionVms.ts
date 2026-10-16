import type { SessionVm } from "../ipc/types";
import { formatRelativeTime } from "../chat/ScreenshotPicker";

/**
 * The session VMs of the start view's list: only the running ones unless `showsStopped`, filtered by `query` (every
 * word must occur in the title, repository, branch, `#issue`, owner or VM name, case-insensitively), sessions whose
 * agent waits for an answer first, then running VMs, and within that the newest first.
 */
export function filterSessionVms(vms: SessionVm[], query: string, showsStopped: boolean): SessionVm[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return vms
    .filter((vm) => showsStopped || vm.isRunning)
    .filter((vm) => {
      if (words.length === 0) return true;
      const haystack = `${vm.title} ${vm.repo} ${vm.branch} ${vm.issue ? `#${vm.issue}` : ""} ${vm.owner} ${vm.vm.instance}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => Number(hasQuestion(b)) - Number(hasQuestion(a)) || Number(b.isRunning) - Number(a.isRunning) || createdTime(b) - createdTime(a));
}

function hasQuestion(vm: SessionVm): boolean {
  return vm.agent === "question";
}

function createdTime(vm: SessionVm): number {
  return vm.createdAt ? Date.parse(vm.createdAt) || 0 : 0;
}

/** The badge of a listed VM's origin, like the sidebar's: `swf #123` (or `swf`) for the poller's, `remote` for a handoff. */
export function sessionVmOriginLabel(vm: SessionVm): string {
  if (vm.origin === "swf") return vm.issue ? `swf #${vm.issue}` : "swf";
  return "remote";
}

/**
 * The parts of a row's second line: the repository, the branch, who handed the session off and when the VM was created,
 * each only when known.
 */
export function sessionVmMeta(vm: SessionVm, now = Date.now()): string[] {
  const parts = [vm.repo];
  if (vm.branch) {
    parts.push(vm.branch);
  }
  if (vm.owner) {
    parts.push(`by ${vm.owner}`);
  }
  if (vm.createdAt && Date.parse(vm.createdAt)) {
    parts.push(`started ${formatRelativeTime(Date.parse(vm.createdAt), now)}`);
  }
  return parts;
}

/** The page on GitHub a row's arrow opens: the issue of a `swf` session, else the repository. */
export function sessionVmUrl(vm: SessionVm): string {
  const repo = `https://github.com/${vm.repo}`;
  return vm.origin === "swf" && vm.issue ? `${repo}/issues/${vm.issue}` : repo;
}

/** The status word of a VM that is not running, as the list shows it: `stopped` for Compute Engine's TERMINATED. */
export function sessionVmStatusLabel(vm: SessionVm): string {
  if (vm.isRunning) return "Running";
  if (vm.status === "TERMINATED" || vm.status === "STOPPED") return "Stopped";
  const word = vm.status.toLowerCase();
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "Unknown";
}

/** The chip and its colour for the state of a poller session's agent; null while it runs or is unknown. */
export function sessionVmAgentLabel(vm: SessionVm): { label: string; tone: "question" | "done" | "failed"; title: string } | null {
  switch (vm.agent) {
    case "question":
      return { label: "Question", tone: "question", title: "The agent asked a question on the issue and waits for the answer" };
    case "done":
      return { label: "Done", tone: "done", title: "The agent opened a pull request for the issue" };
    case "failed":
      return { label: "Failed", tone: "failed", title: "The agent could not complete the issue" };
    default:
      return null;
  }
}
