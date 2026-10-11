import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SessionView } from "../ipc/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { agentSetupOf, useHuntStore } from "./store";

const SESSION = "11111111-1111-1111-1111-111111111111";

/** Payloads recorded from claude-agent-acp 0.89.1 over the wire. */
function notification(update: Record<string, unknown>): SessionNotification {
  return { sessionId: "acp-session", update } as unknown as SessionNotification;
}

describe("session summary", () => {
  it("replaces title and summary of the summarized session only", () => {
    const session = { id: SESSION, title: "Old", summary: [] } as unknown as SessionView;
    const other = { id: "other", title: "Other", summary: ["kept"] } as unknown as SessionView;
    useHuntStore.setState({ sessions: [session, other] });

    useHuntStore.getState().applySummary({ huntSessionId: SESSION, title: "New", summary: ["did a", "did b"] });

    const sessions = useHuntStore.getState().sessions;
    expect(sessions[0]).toMatchObject({ title: "New", summary: ["did a", "did b"] });
    expect(sessions[1]).toMatchObject({ title: "Other", summary: ["kept"] });
  });
});

describe("acp update reducer", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [], activeSessionId: null });
  });

  it("streams agent text into one growing item", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Listing " } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the src directory now." } }));

    const items = useHuntStore.getState().chats[SESSION].items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "agent", text: "Listing the src directory now." });
  });

  it("collects the text and images of one user turn into one item, leaving an attached file resource out", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Look at this" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "resource", resource: { uri: "file:///repo/rule.md", text: "# Rule" } } }));

    const items = useHuntStore.getState().chats[SESSION].items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "Look at this", images: ["data:image/png;base64,AAAA"] });
  });

  it("merges tool_call_update fields and exposes terminal output from _meta", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_1",
      title: "Terminal",
      name: "Bash",
      kind: "execute",
      status: "pending",
      content: [{ type: "terminal", terminalId: "toolu_1" }],
      _meta: { claudeCode: { toolName: "Bash" }, terminal_info: { terminal_id: "toolu_1" } },
    }));
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      title: "ls src",
      status: "in_progress",
      rawInput: { command: "ls src" },
    }));
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      _meta: { terminal_output: { terminal_id: "toolu_1", data: "app\nchat" } },
    }));
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      status: "completed",
      _meta: { claudeCode: { toolName: "Bash" }, terminal_exit: { terminal_id: "toolu_1", exit_code: 0, signal: null } },
    }));

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.items).toHaveLength(1);
    const item = chat.items[0];
    if (item.kind !== "tool") throw new Error("expected tool item");
    expect(item.toolCall).toMatchObject({ title: "ls src", kind: "execute", status: "completed", terminalOutput: "app\nchat" });
    expect(chat.editVersion).toBe(0);
  });

  it("bumps editVersion when an edit completes even though kind is only on the initial tool_call", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_2",
      title: "Edit README.md",
      kind: "edit",
      status: "pending",
      content: [{ type: "diff", path: "/repo/README.md", oldText: "a", newText: "b" }],
    }));
    applyUpdate(SESSION, notification({ sessionUpdate: "tool_call_update", toolCallId: "toolu_2", status: "completed" }));

    expect(useHuntStore.getState().chats[SESSION].editVersion).toBe(1);
  });

  it("keeps the mode and commands in sync", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "current_mode_update", currentModeId: "plan" }));
    applyUpdate(SESSION, notification({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] }));

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.modeId).toBe("plan");
    expect(chat.commands.map((command) => command.name)).toEqual(["compact"]);
  });

  it("tracks the context window fill level from usage_update", () => {
    const { applyUpdate } = useHuntStore.getState();
    expect(useHuntStore.getState().chats[SESSION]?.contextUsage ?? null).toBeNull();
    applyUpdate(SESSION, notification({ sessionUpdate: "usage_update", used: 42_300, size: 200_000, cost: { amount: 0.12, currency: "USD" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "usage_update", used: 51_000, size: 200_000 }));

    expect(useHuntStore.getState().chats[SESSION].contextUsage).toEqual({ used: 51_000, size: 200_000 });
  });

  it("ignores a closed event for a session whose chat was deleted", () => {
    useHuntStore.getState().applyClosed({ huntSessionId: SESSION, error: "boom" });
    expect(useHuntStore.getState().chats[SESSION]).toBeUndefined();
  });
});

describe("loadHistory", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [], activeSessionId: null });
    vi.mocked(invoke).mockReset();
  });

  it("rebuilds a chat that live updates created before the history was loaded", async () => {
    const { applyUpdate, loadHistory } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "latest answer" } }));
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "session_history"
        ? [
            notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "first question" } }),
            notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "latest answer" } }),
          ]
        : undefined,
    );

    await loadHistory(SESSION);

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.items.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(chat.hasHistory).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);

    await loadHistory(SESSION);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

/** A stored top-level session as the backend lists it. */
function storedSession(id: string, title: string): SessionView {
  return {
    id,
    title,
    repoPath: "/repo",
    worktreePath: `/worktrees/${id}`,
    branch: `hunt/${title}`,
    baseRef: "main",
    baseCommit: "abc123",
    acpSessionId: "acp-session",
    createdAt: "2026-10-11T10:00:00Z",
    isLive: true,
    parentId: null,
    selection: null,
    summary: [],
    touchedFiles: [],
    worktreeChangedAt: null,
    pullRequest: null,
    diffBase: null,
    reviewComments: [],
  };
}

const TARGET = { repoPath: "/repo", baseRef: "main", pullRequest: null, diffBaseRef: null };
const START = { setup: { configValues: { model: "fable", effort: "high" }, modeId: "plan" }, prompt: { text: "build it", images: [] } };

describe("createSession", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [], creatingIds: [], activeSessionId: null, draft: { parentId: null } });
    vi.mocked(invoke).mockReset();
  });

  it("lists and shows the session with its first prompt before the backend created it", async () => {
    let finish: () => void = () => {};
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "create_session") {
        return new Promise((resolve) => {
          finish = () => resolve(storedSession((args as { id: string }).id, "Build it"));
        });
      }
      return Promise.resolve(undefined);
    });

    const creation = useHuntStore.getState().createSession(TARGET, "Build it", START);

    const pending = useHuntStore.getState();
    expect(pending.sessions.map((session) => session.title)).toEqual(["Build it"]);
    expect(pending.creatingIds).toEqual([pending.sessions[0].id]);
    expect(pending.activeSessionId).toBe(pending.sessions[0].id);
    expect(pending.draft).toBeNull();
    expect(pending.chats[pending.sessions[0].id].items).toEqual([{ kind: "user", id: expect.any(String), text: "build it", images: [] }]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["create_session", { id: pending.sessions[0].id, repoPath: "/repo", baseRef: "main", title: "Build it", pullRequest: null, diffBaseRef: null }]]);

    finish();
    const id = await creation;
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toContain("send_prompt"));

    const done = useHuntStore.getState();
    expect(id).toBe(pending.sessions[0].id);
    expect(done.sessions[0]).toEqual(storedSession(id, "Build it"));
    expect(done.creatingIds).toEqual([]);
    expect(vi.mocked(invoke).mock.calls.slice(1)).toEqual([
      ["set_session_config_option", { id, configId: "model", value: "fable" }],
      ["set_session_config_option", { id, configId: "effort", value: "high" }],
      ["set_session_mode", { id, modeId: "plan" }],
      ["send_prompt", { id, text: "build it", images: [] }],
    ]);
    expect(done.chats[id].items).toHaveLength(1);
  });

  it("brings the start view back with the error and the prompt when the backend could not create the session", async () => {
    vi.mocked(invoke).mockImplementation((command) => (command === "create_session" ? Promise.reject("failed to add worktree") : Promise.resolve([])));

    await expect(useHuntStore.getState().createSession(TARGET, "Build it", START)).rejects.toBe("failed to add worktree");

    const state = useHuntStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.creatingIds).toEqual([]);
    expect(state.chats).toEqual({});
    expect(state.activeSessionId).toBeNull();
    expect(state.draft).toEqual({ parentId: null, error: "failed to add worktree", prompt: START.prompt });
  });

  it("keeps a session being created when the stored list is reloaded without it", async () => {
    vi.mocked(invoke).mockImplementation((command) => (command === "create_session" ? new Promise(() => {}) : Promise.resolve([storedSession("old", "Older")])));
    void useHuntStore.getState().createSession(TARGET, "Build it", START);

    await useHuntStore.getState().refreshSessions();

    expect(useHuntStore.getState().sessions.map((session) => session.title)).toEqual(["Build it", "Older"]);
  });
});

describe("createSubSession", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [storedSession("parent", "Parent")], creatingIds: [], activeSessionId: "parent", draft: null });
    vi.mocked(invoke).mockReset();
  });

  it("lists the sub session under its parent at once and leaves the active session alone unless asked", async () => {
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "create_sub_session" ? Promise.resolve({ ...storedSession((args as { id: string }).id, "Sub"), parentId: "parent" }) : Promise.resolve(undefined),
    );

    const creation = useHuntStore.getState().createSubSession("parent", "Sub", null, { setup: { configValues: {}, modeId: "default" }, prompt: null }, false);

    const pending = useHuntStore.getState();
    expect(pending.sessions.map((session) => [session.title, session.parentId, session.worktreePath])).toEqual([["Sub", "parent", "/worktrees/parent"], ["Parent", null, "/worktrees/parent"]]);
    expect(pending.activeSessionId).toBe("parent");

    const id = await creation;
    expect(useHuntStore.getState().sessions[0]).toEqual({ ...storedSession(id, "Sub"), parentId: "parent" });
    expect(vi.mocked(invoke).mock.calls).toEqual([["create_sub_session", { id, parentId: "parent", title: "Sub", selection: null }]]);
  });

  it("rejects an unlisted parent", async () => {
    await expect(useHuntStore.getState().createSubSession("missing", "Sub", null, { setup: { configValues: {}, modeId: "default" }, prompt: null }, true)).rejects.toThrow("missing");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("agentSetupOf", () => {
  it("takes the chat's select options and mode", () => {
    useHuntStore.setState({ chats: {} });
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate("parent", notification({
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "fable", options: [{ value: "fable", name: "Fable" }] },
        { id: "effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
      ],
    }));
    applyUpdate("parent", notification({ sessionUpdate: "current_mode_update", currentModeId: "plan" }));

    expect(agentSetupOf(useHuntStore.getState().chats.parent)).toEqual({ configValues: { model: "fable", effort: "high" }, modeId: "plan" });
  });
});
