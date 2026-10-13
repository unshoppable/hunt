import { describe, expect, it } from "vitest";
import type { RemoteTarget, SessionView } from "../ipc/types";
import { idleDays, isStaleRemote } from "./staleRemote";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00Z");

function session(remote: Partial<RemoteTarget> | null): SessionView {
  const target: RemoteTarget = {
    vm: { project: "medconomy-hunt", zone: "europe-west1-c", instance: "vm-hunt-medc" },
    worktreePath: "/srv/worktrees/x",
    repo: "unshoppable/app-framework",
    branch: "feat/x/y",
    handoffHead: "abc",
    handedOffAt: new Date(NOW - 10 * DAY).toISOString(),
    localMode: null,
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: null,
  };
  return { id: "s1", remote: remote ? { ...target, ...remote } : null } as SessionView;
}

const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("isStaleRemote", () => {
  it("asks after seven idle days and not before", () => {
    expect(isStaleRemote(session({ lastActiveAt: daysAgo(6.9) }), NOW)).toBe(false);
    expect(isStaleRemote(session({ lastActiveAt: daysAgo(7) }), NOW)).toBe(true);
  });

  it("counts from the handoff without any activity", () => {
    expect(isStaleRemote(session({ handedOffAt: daysAgo(8) }), NOW)).toBe(true);
    expect(isStaleRemote(session({ handedOffAt: daysAgo(2) }), NOW)).toBe(false);
  });

  it("asks again three days after the user chose to wait", () => {
    expect(isStaleRemote(session({ lastActiveAt: daysAgo(9), cleanupAskedAt: daysAgo(2) }), NOW)).toBe(false);
    expect(isStaleRemote(session({ lastActiveAt: daysAgo(10), cleanupAskedAt: daysAgo(3) }), NOW)).toBe(true);
  });

  it("starts the idle time anew after activity that followed the question", () => {
    expect(isStaleRemote(session({ lastActiveAt: daysAgo(4), cleanupAskedAt: daysAgo(5) }), NOW)).toBe(false);
  });

  it("never asks about a local session", () => {
    expect(isStaleRemote(session(null), NOW)).toBe(false);
  });
});

describe("idleDays", () => {
  it("counts whole days since the last activity", () => {
    expect(idleDays(session({ lastActiveAt: daysAgo(8.5) }), NOW)).toBe(8);
    expect(idleDays(session(null), NOW)).toBe(0);
  });
});
