import { describe, expect, it } from "vitest";
import { storedSession } from "../sessions/hunt.store.fixtures";
import type { RemoteTarget } from "../sessions/remote/remote-session.types";
import type { SessionView } from "../sessions/session.types";
import { ensureRunnable, parseControlCommand, worktreeFilePath } from "./control-command.utils";

const WORKTREE = "/worktrees/s1";

function localSession(): SessionView {
  return storedSession("s1", "Local");
}

function remoteSession(): SessionView {
  const remote: RemoteTarget = {
    vm: { project: "hunt", zone: "europe-west3-a", instance: "vm-hunt-s-s1" },
    worktreePath: "/home/hunt/worktree",
    repo: "unshoppable/hunt",
    branch: "feat/general/remote",
    handoffHead: "",
    handedOffAt: "2026-10-11T10:00:00Z",
    localMode: null,
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: null,
    origin: "swf",
    issue: 7,
    agent: "",
    pushTargetPending: false,
    relayActivity: null,
  };
  return { ...storedSession("s1", "Remote"), remote, hasLocalWorktree: false };
}

describe("parseControlCommand", () => {
  it("reads every command of the contract", () => {
    const commands = [
      { name: "show" },
      { name: "tab", tab: "checks" },
      { name: "openFile", path: `${WORKTREE}/src/a.ts` },
      { name: "openFile", path: `${WORKTREE}/src/a.ts`, line: 12, column: 3, window: true },
      { name: "openDiff", path: `${WORKTREE}/src/a.ts` },
      { name: "openSettings" },
      { name: "openSettings", page: "updates" },
      { name: "openGuardrails" },
      { name: "openBrowser" },
    ];
    for (const command of commands) {
      expect(parseControlCommand(command)).toEqual(command);
    }
  });

  it("names the field and what it must be", () => {
    expect(() => parseControlCommand("show")).toThrow("invalid command: the command must be a JSON object with a name");
    const names = "show, tab, openFile, openDiff, openSettings, openGuardrails, openBrowser";
    expect(() => parseControlCommand({})).toThrow(`invalid command: name must be one of ${names}`);
    expect(() => parseControlCommand({ name: "close" })).toThrow(`invalid command: name must be one of ${names}`);
    const tabs = "diff, git, editor, graph, pullRequest, preview, desktop, checks, terminal";
    expect(() => parseControlCommand({ name: "tab", tab: "chat" })).toThrow(`invalid command: tab must be one of ${tabs}`);
    expect(() => parseControlCommand({ name: "openFile" })).toThrow("invalid command: path must be an absolute path");
    expect(() => parseControlCommand({ name: "openFile", path: "/a.ts", line: 0 })).toThrow("invalid command: line must be a positive integer");
    expect(() => parseControlCommand({ name: "openFile", path: "/a.ts", column: 1.5 })).toThrow("invalid command: column must be a positive integer");
    expect(() => parseControlCommand({ name: "openFile", path: "/a.ts", window: "yes" })).toThrow("invalid command: window must be true or false");
    expect(() => parseControlCommand({ name: "openSettings", page: "accounts" })).toThrow('invalid command: page must be "updates"');
    expect(() => parseControlCommand({ name: "show", tab: "diff" })).toThrow("invalid command: the command has unknown fields: tab");
  });

  it("takes only absolute paths without empty, . or .. segments", () => {
    for (const path of ["src/a.ts", "./src/a.ts", `${WORKTREE}/../s2/a.ts`, `${WORKTREE}/./a.ts`, `${WORKTREE}//a.ts`, `${WORKTREE}/src/`, "/", ""]) {
      expect(() => parseControlCommand({ name: "openDiff", path })).toThrow("path must be an absolute path");
    }
    for (const path of [`${WORKTREE}/.claude/rules/ui.md`, `${WORKTREE}/..hidden`, `${WORKTREE}/a..b.ts`]) {
      expect(parseControlCommand({ name: "openDiff", path })).toEqual({ name: "openDiff", path });
    }
  });
});

describe("ensureRunnable", () => {
  it("rejects the tabs the session's inspector lacks", () => {
    expect(() => ensureRunnable({ name: "tab", tab: "preview" }, localSession())).toThrow("the session has no preview tab");
    expect(() => ensureRunnable({ name: "tab", tab: "desktop" }, localSession())).toThrow("the session has no desktop tab");
    expect(() => ensureRunnable({ name: "tab", tab: "pullRequest" }, localSession())).toThrow("the session has no pullRequest tab");
    expect(() => ensureRunnable({ name: "tab", tab: "terminal" }, localSession())).not.toThrow();
    expect(() => ensureRunnable({ name: "tab", tab: "preview" }, remoteSession())).not.toThrow();
    const review = { ...localSession(), pullRequest: { number: 12, url: "https://github.com/unshoppable/hunt/pull/12" } };
    expect(() => ensureRunnable({ name: "tab", tab: "pullRequest" }, review)).not.toThrow();
  });

  it("needs a local worktree for files, diffs and guardrails", () => {
    const path = `${WORKTREE}/src/a.ts`;
    for (const command of [{ name: "openFile", path }, { name: "openDiff", path }, { name: "openGuardrails" }] as const) {
      expect(() => ensureRunnable(command, remoteSession())).toThrow("the session has no local worktree");
      expect(() => ensureRunnable(command, localSession())).not.toThrow();
    }
  });

  it("opens the browser only for a session on this Mac", () => {
    expect(() => ensureRunnable({ name: "openBrowser" }, remoteSession())).toThrow("the session runs on a VM");
    expect(() => ensureRunnable({ name: "openBrowser" }, localSession())).not.toThrow();
  });

  it("lets every session show itself and open the settings", () => {
    for (const session of [localSession(), remoteSession()]) {
      expect(() => ensureRunnable({ name: "show" }, session)).not.toThrow();
      expect(() => ensureRunnable({ name: "openSettings", page: "updates" }, session)).not.toThrow();
    }
  });
});

describe("worktreeFilePath", () => {
  it("makes a path inside the worktree relative to it", () => {
    expect(worktreeFilePath(`${WORKTREE}/src/a.ts`, WORKTREE)).toBe("src/a.ts");
    expect(worktreeFilePath(`${WORKTREE}/README.md`, WORKTREE)).toBe("README.md");
  });

  it("rejects the worktree itself, a sibling with the same prefix and paths elsewhere", () => {
    for (const path of [WORKTREE, `${WORKTREE}2/a.ts`, "/etc/hosts"]) {
      expect(() => worktreeFilePath(path, WORKTREE)).toThrow(`${path} lies outside the session's worktree ${WORKTREE}`);
    }
    expect(() => worktreeFilePath("/a.ts", "")).toThrow("lies outside the session's worktree");
  });
});
