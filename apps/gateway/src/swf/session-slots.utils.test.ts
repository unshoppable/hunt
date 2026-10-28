import { describe, expect, it } from "vitest";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { Issue } from "./github.client.ts";
import { activeSessionVms, issuesToStart } from "./session-slots.utils.ts";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  return { number, title, body: "", author: "alice", createdAt: "2026-10-13T08:04:05Z", url: `https://github.com/acme/app/issues/${number}`, labels, state: "open", assignees: [] };
}

describe("issue selection", () => {
  it("counts every VM that is not off, stopped or suspended, and the VMs being created", () => {
    const vms = [
      { name: "vm-hunt-s-00000001", status: "RUNNING" },
      { name: "vm-hunt-s-00000002", status: "TERMINATED" },
      { name: "vm-hunt-s-00000003", status: "STOPPED" },
      { name: "vm-hunt-s-00000004", status: "STAGING" },
      { name: "vm-hunt-s-00000005", status: "SUSPENDED" },
    ];
    const active = activeSessionVms(vms, ["vm-hunt-s-00000001", "vm-hunt-s-00000009"]);
    expect([...active].sort()).toEqual(["vm-hunt-s-00000001", "vm-hunt-s-00000004", "vm-hunt-s-00000009"]);
  });

  it("starts the oldest issues of the repositories in their configured order and lets the rest wait", () => {
    const issuesByRepo = [
      { repo: Repository.fromSlug("acme/app"), issues: [issue(9), issue(3)] },
      { repo: Repository.fromSlug("acme/api"), issues: [issue(1)] },
    ];
    const { start, waiting } = issuesToStart(issuesByRepo, 2);
    expect(start.map(({ repo, issue }) => `${repo.slug}#${issue.number}`)).toEqual(["acme/app#3", "acme/app#9"]);
    expect(waiting.map(({ repo, issue }) => `${repo.slug}#${issue.number}`)).toEqual(["acme/api#1"]);
    expect(issuesToStart(issuesByRepo, 0).start).toEqual([]);
    expect(issuesToStart(issuesByRepo, -2).waiting).toHaveLength(3);
    expect(issuesToStart(issuesByRepo, 5).start).toHaveLength(3);
  });
});
