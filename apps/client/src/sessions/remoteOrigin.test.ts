import { describe, expect, it } from "vitest";
import type { RemoteTarget, SessionView } from "../ipc/types";
import {
  adoptedBringBackQuestion,
  adoptedDeleteQuestion,
  isAdopted,
  missingCheckoutBlocker,
  remoteOriginLabel,
  remoteOriginTitle,
  repositoryLabel,
} from "./remoteOrigin";

function session(remote: Partial<RemoteTarget> | null, patch: Partial<SessionView> = {}): SessionView {
  const target: RemoteTarget = {
    vm: { project: "medconomy-hunt", zone: "europe-west1-c", instance: "vm-hunt-s-ab12cd34" },
    worktreePath: "",
    repo: "unshoppable/app-framework",
    branch: "fix/general/123-fix-login",
    handoffHead: "",
    handedOffAt: "2026-10-13T10:00:00Z",
    localMode: null,
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: "hunt.example.com",
    origin: "handoff",
    issue: null,
  };
  return { id: "s1", title: "Fix login", repoPath: "/src/app-framework", remote: remote ? { ...target, ...remote } : null, ...patch } as SessionView;
}

describe("remoteOriginLabel", () => {
  it("labels adopted sessions by who started them", () => {
    expect(remoteOriginLabel(session({ origin: "swf", issue: 123 }))).toBe("swf #123");
    expect(remoteOriginLabel(session({ origin: "swf" }))).toBe("swf");
    expect(remoteOriginLabel(session({ origin: "desktop" }))).toBe("remote");
  });

  it("leaves sessions this Mac handed off or runs without a label", () => {
    expect(remoteOriginLabel(session({ origin: "handoff" }))).toBeNull();
    expect(remoteOriginLabel(session(null))).toBeNull();
    expect(isAdopted(session({ origin: "handoff" }))).toBe(false);
    expect(isAdopted(session({ origin: "desktop" }))).toBe(true);
  });

  it("names the issue and the VM in the tooltip", () => {
    expect(remoteOriginTitle(session({ origin: "swf", issue: 7 }))).toBe(
      "Started by the swf poller for issue #7 of unshoppable/app-framework. Runs on the VM vm-hunt-s-ab12cd34; other people may work on it too.",
    );
    expect(remoteOriginTitle(session({ origin: "handoff" }))).toBe("Runs on the VM vm-hunt-s-ab12cd34");
    expect(remoteOriginTitle(session(null))).toBeNull();
  });
});

describe("missingCheckoutBlocker", () => {
  it("blocks bringing back an adopted session without a local checkout", () => {
    expect(missingCheckoutBlocker(session({ origin: "swf" }, { repoPath: "" }))).toMatch(/local checkout of unshoppable\/app-framework/);
    expect(missingCheckoutBlocker(session({ origin: "swf" }))).toBeNull();
    expect(missingCheckoutBlocker(session({ origin: "handoff" }, { repoPath: "" }))).toBeNull();
  });

  it("shows the VM's repository while no checkout is known", () => {
    expect(repositoryLabel(session({ origin: "swf" }, { repoPath: "" }))).toBe("unshoppable/app-framework");
    expect(repositoryLabel(session({ origin: "swf" }))).toBe("app-framework");
  });
});

describe("adopted session questions", () => {
  it("name the VM and warn about other people", () => {
    const adopted = session({ origin: "desktop" });
    expect(adoptedDeleteQuestion(adopted)).toMatch(/^Delete session "Fix login" and its VM vm-hunt-s-ab12cd34\? Other people/);
    expect(adoptedBringBackQuestion(adopted)).toMatch(/new worktree of app-framework\? Its VM vm-hunt-s-ab12cd34 is deleted afterwards\. Other people/);
  });
});
