/**
 * Which issues get a session at a poll of the poller (`swf/poller.service.ts`), free of I/O: the VMs that count towards
 * its `maxSessions` and the open issues with the label that fit into the free slots.
 */
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { isOffStatus } from "../../../../libs/domain/src/session/vm-status.utils.ts";
import type { Issue } from "./github.client.ts";

/** The poller's VMs that count towards the limit (any status but off) plus the VMs it is creating right now. */
export function activeSessionVms(vms: { name: string; status: string }[], creating: Iterable<string>): Set<string> {
  const active = new Set(creating);
  for (const vm of vms) {
    if (!isOffStatus(vm.status)) {
      active.add(vm.name);
    }
  }
  return active;
}

export interface Candidate {
  repo: Repository;
  issue: Issue;
}

/**
 * Splits the open issues with the label, per repository in the configured order, into those that get a session now,
 * oldest first and at most `free` of them, and those that wait for a free slot.
 */
export function issuesToStart(issuesByRepo: { repo: Repository; issues: Issue[] }[], free: number): { start: Candidate[]; waiting: Candidate[] } {
  const candidates = issuesByRepo.flatMap(({ repo, issues }) =>
    [...issues].sort((first, second) => first.number - second.number).map((issue) => ({ repo, issue })),
  );
  const count = Math.max(0, free);
  return { start: candidates.slice(0, count), waiting: candidates.slice(count) };
}
