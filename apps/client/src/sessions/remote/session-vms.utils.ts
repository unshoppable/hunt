import type { SessionVm } from "./remote-session.types";
import { formatRelativeTime } from "../../common/time/relative-time.utils";
import { isBusyAgentState, type MarkState } from "../session-mark-state.utils";

/**
 * The session VMs of the start view's list: only the running ones and those whose agent waits for an answer (the
 * gateway suspends the VM of an idle agent) unless `showsStopped`, filtered by `query` (every word must occur in the
 * title, repository, branch, `#issue`, owner or VM name, case-insensitively), sessions whose agent waits for an answer
 * first, then running VMs, and within that the newest first.
 */
export function filterSessionVms(vms: SessionVm[], query: string, showsStopped: boolean): SessionVm[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return vms
    .filter((vm) => showsStopped || vm.isRunning || hasQuestion(vm))
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
 * The parts of a row's last line, below the branch: the repository, who handed the session off and when the VM was
 * created, each only when known.
 */
export function sessionVmMeta(vm: SessionVm, now = Date.now()): string[] {
  const parts = [vm.repo];
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

/**
 * The state the mark of a listed VM shows, like the sidebar's for a session this Mac knows: busy while the poller's
 * pipeline is at a step (`isBusyAgentState`) on its running VM, with a `?` badge while the agent waits for an answer on
 * the issue.
 */
export function sessionVmMarkState(vm: SessionVm): MarkState {
  return { isBusy: vm.isRunning && isBusyAgentState(vm.agent), hasQuestion: vm.agent === "question" };
}

/**
 * The chip and its colour for the state of a poller session's agent: the steps in which the pull request waits for
 * others, a question, the end or a failure; null while the agent works on a step itself or the state is unknown.
 */
export function sessionVmAgentLabel(vm: SessionVm): { label: string; tone: "question" | "done" | "failed" | "neutral"; title: string } | null {
  switch (vm.agent) {
    case "review":
      return { label: "Review", tone: "neutral", title: "The pull request waits for the Claude review and its checks" };
    case "human-review":
      return { label: "Human review", tone: "neutral", title: "A person has to review the pull request" };
    case "merge":
      return { label: "Merging", tone: "neutral", title: "Hunt merges the pull request" };
    case "question":
      return { label: "Question", tone: "question", title: "The agent asked a question on the issue and waits for the answer" };
    case "done":
      return { label: "Done", tone: "done", title: "The issue is done: its pull request is merged or the issue is closed" };
    case "failed":
      return { label: "Failed", tone: "failed", title: "The agent could not complete the issue" };
    default:
      return null;
  }
}
