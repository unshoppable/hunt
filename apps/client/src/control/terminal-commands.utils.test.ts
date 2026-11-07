import { describe, expect, it } from "vitest";
import type { PreviewService } from "../preview/preview.types";
import { terminalTabs } from "../terminal/terminal-tabs.utils";
import type { TmuxWindow } from "../terminal/terminal.types";
import { parseWindowTabKey, shellDirectory, tabWithKey, terminalState } from "./terminal-commands.utils";

const WORKTREE = "/worktrees/s1";

function tmuxWindow(id: string, name: string, change: Partial<TmuxWindow> = {}): TmuxWindow {
  return { id, name, script: null, check: null, service: null, isDead: false, exitCode: null, owner: "s1", ...change };
}

function service(name: string): PreviewService {
  return { name, port: 4200, url: `https://${name}.example`, guarded: false, tls: true, enabled: true, state: "running", responds: true, invocation: "1" };
}

describe("parseWindowTabKey", () => {
  it("reads the machine and window ID of a window tab's key", () => {
    expect(parseWindowTabKey("window:desktop:@3")).toEqual({ machine: "desktop", id: "@3" });
    expect(parseWindowTabKey("window:vm:@12")).toEqual({ machine: "vm", id: "@12" });
  });

  it("refuses the keys of services and unknown machines", () => {
    expect(parseWindowTabKey("service:web")).toBeNull();
    expect(parseWindowTabKey("local-service:web")).toBeNull();
    expect(parseWindowTabKey("window:laptop:@3")).toBeNull();
    expect(parseWindowTabKey("window:vm:")).toBeNull();
  });
});

describe("tabWithKey", () => {
  const tabs = terminalTabs([], [], [tmuxWindow("@1", "shell"), tmuxWindow("@2", "vite")], false);

  it("finds the tab of a key", () => {
    expect(tabWithKey(tabs, "window:desktop:@2").label).toBe("vite");
  });

  it("names the keys when the key is unknown", () => {
    expect(() => tabWithKey(tabs, "window:desktop:@9")).toThrow("the Terminal tab has no tab window:desktop:@9; its tabs are window:desktop:@1, window:desktop:@2");
    expect(() => tabWithKey([], "service:web")).toThrow("its tabs are none");
  });
});

describe("shellDirectory", () => {
  it("opens in the worktree without a folder or for the worktree itself", () => {
    expect(shellDirectory(undefined, WORKTREE)).toBe("");
    expect(shellDirectory(WORKTREE, WORKTREE)).toBe("");
  });

  it("makes a folder of the worktree relative", () => {
    expect(shellDirectory(`${WORKTREE}/apps/client`, WORKTREE)).toBe("apps/client");
  });

  it("refuses a folder outside the worktree", () => {
    expect(() => shellDirectory("/tmp", WORKTREE)).toThrow("lies outside");
  });
});

describe("terminalState", () => {
  const windows = [
    tmuxWindow("@1", "shell"),
    tmuxWindow("@2", "test", { script: "test", isDead: true, exitCode: 1 }),
    tmuxWindow("@3", "claude", { owner: "s2" }),
  ];

  it("lists the tabs with their state and owner and shows the stored tab", () => {
    const tabs = terminalTabs([], [], windows, false);
    expect(terminalState(tabs, "s1", "window:desktop:@2", true, undefined, null)).toEqual({
      tabs: [
        { key: "window:desktop:@1", label: "shell", state: null, owner: null },
        { key: "window:desktop:@2", label: "test", state: "Process finished with exit code 1.", owner: null },
        { key: "window:desktop:@3", label: "claude", state: null, owner: "s2" },
      ],
      activeKey: "window:desktop:@2",
      error: null,
    });
  });

  it("shows the first tab when the stored one is gone or none is stored", () => {
    const tabs = terminalTabs([], [], windows, false);
    expect(terminalState(tabs, "s1", "window:desktop:@9", true, undefined, null).activeKey).toBe("window:desktop:@1");
    expect(terminalState(tabs, "s1", null, true, undefined, null).activeKey).toBe("window:desktop:@1");
    expect(terminalState([], "s1", "window:desktop:@1", true, undefined, "no tmux").activeKey).toBeNull();
  });

  it("reports for a session on a VM its services and whether the app is to start", () => {
    const tabs = terminalTabs([service("web")], [tmuxWindow("@1", "shell")], [], true);
    expect(terminalState(tabs, "s1", null, false, true, null)).toEqual({
      tabs: [
        { key: "service:web", label: "web", state: "Starts with the VM", owner: null },
        { key: "window:vm:@1", label: "shell", state: null, owner: null },
      ],
      activeKey: "service:web",
      awaitingStart: true,
      error: null,
    });
  });
});
