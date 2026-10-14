import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SessionView } from "../ipc/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { HANDOFF_START_PROMPT } from "../preview/services";
import { useAgentDefaultsStore } from "./agentDefaults";
import { DEFAULT_GRAPH_AGENT, DEFAULT_REMOTE, useSettingsStore } from "./settings";
import { agentSetupOf, createEmptyChat, useHuntStore } from "./store";

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

describe("remote file sync", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: { [SESSION]: createEmptyChat() }, sessions: [], activeSessionId: null });
  });

  it("keeps the last success while a sync runs and reloads the views after one that changed local files", () => {
    const { applyRemoteSync } = useHuntStore.getState();
    applyRemoteSync({ huntSessionId: SESSION, isRunning: false, syncedAt: "2026-10-14T10:05:00Z", error: null, changedLocal: true });
    applyRemoteSync({ huntSessionId: SESSION, isRunning: true, syncedAt: null, error: null, changedLocal: false });
    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.fileSync).toEqual({ isRunning: true, syncedAt: "2026-10-14T10:05:00Z", error: null });
    expect(chat.editVersion).toBe(1);
  });

  it("records a failure until the next sync succeeds and leaves sessions without a chat alone", () => {
    const { applyRemoteSync } = useHuntStore.getState();
    applyRemoteSync({ huntSessionId: SESSION, isRunning: false, syncedAt: "2026-10-14T10:05:00Z", error: null, changedLocal: false });
    const error = "failed to list the files on the VM";
    applyRemoteSync({ huntSessionId: SESSION, isRunning: false, syncedAt: null, error, changedLocal: false });
    expect(useHuntStore.getState().chats[SESSION].fileSync).toEqual({ isRunning: false, syncedAt: "2026-10-14T10:05:00Z", error });
    applyRemoteSync({ huntSessionId: SESSION, isRunning: false, syncedAt: "2026-10-14T10:06:00Z", error: null, changedLocal: false });
    expect(useHuntStore.getState().chats[SESSION].fileSync.error).toBeNull();
    expect(useHuntStore.getState().chats[SESSION].editVersion).toBe(0);

    applyRemoteSync({ huntSessionId: "other", isRunning: true, syncedAt: null, error: null, changedLocal: false });
    expect(useHuntStore.getState().chats.other).toBeUndefined();
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

  it("streams the agent's images and text into one message", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AAAA", mimeType: "image/png" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before and after the fix." } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "BBBB", mimeType: "image/webp" } }));

    const items = useHuntStore.getState().chats[SESSION].items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "agent",
      text: "Before and after the fix.",
      images: ["data:image/png;base64,AAAA", "data:image/webp;base64,BBBB"],
    });
  });

  it("shows a placeholder instead of an image that is not PNG, JPEG, GIF or WebP in base64", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "<svg onload=alert(1)>", mimeType: "image/png" } }));

    expect(useHuntStore.getState().chats[SESSION].items).toEqual([
      { kind: "user", id: expect.any(String), text: "[unsupported image]", images: [] },
      { kind: "agent", id: expect.any(String), text: "[unsupported image]", images: [] },
    ]);
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

  it("leaves the agent's output of a turn Hunt sent itself out of the chat until the user's next turn", () => {
    const { applyUpdate } = useHuntStore.getState();
    const hidden = { hunt: { hidden: true } };
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Update the diagram" }, _meta: hidden }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the diff" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "tool_call", toolCallId: "toolu_3", title: "Write .hunt/graph.json", kind: "edit", status: "pending" }));
    applyUpdate(SESSION, notification({ sessionUpdate: "tool_call_update", toolCallId: "toolu_3", status: "completed" }));
    applyUpdate(SESSION, notification({ sessionUpdate: "plan", entries: [{ content: "Write the graph", priority: "medium", status: "pending" }] }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Diagram updated." } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "usage_update", used: 1_000, size: 200_000 }));
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Next question" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } }));

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.items.map((item) => [item.kind, "text" in item ? item.text : null])).toEqual([
      ["user", "Next question"],
      ["agent", "Answer"],
    ]);
    expect(chat.plan).toEqual([]);
    expect(chat.contextUsage).toEqual({ used: 1_000, size: 200_000 });
  });

  it("ignores a closed event for a session whose chat was deleted", () => {
    useHuntStore.getState().applyClosed({ huntSessionId: SESSION, error: "boom" });
    expect(useHuntStore.getState().chats[SESSION]).toBeUndefined();
  });

  it("drops a withdrawn permission request and keeps a newer one", () => {
    const { applyPermission, applyPermissionWithdrawn } = useHuntStore.getState();
    const request = { sessionId: "acp-session", toolCall: { toolCallId: "toolu_1", title: "Write README.md" }, options: [] };
    applyPermission({ huntSessionId: SESSION, requestId: "first", request });
    applyPermissionWithdrawn({ huntSessionId: SESSION, requestId: "first" });
    expect(useHuntStore.getState().chats[SESSION].permission).toBeNull();

    applyPermission({ huntSessionId: SESSION, requestId: "second", request });
    applyPermissionWithdrawn({ huntSessionId: SESSION, requestId: "first" });
    expect(useHuntStore.getState().chats[SESSION].permission?.requestId).toBe("second");
    applyPermissionWithdrawn({ huntSessionId: "other", requestId: "second" });
    expect(useHuntStore.getState().chats.other).toBeUndefined();
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
    branch: `feat/general/${title}`,
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
    workspace: "worktree",
    keepsBranch: false,
    remote: null,
    leftoverVm: null,
    dependencies: null,
    hasLocalWorktree: true,
  };
}

const TARGET = { repoPath: "/repo", baseRef: "main", workspace: "worktree" as const, pullRequest: null, diffBaseRef: null, pullRequestBranch: null };
const START = { setup: { configValues: { model: "fable", effort: "high" }, modeId: "plan" }, prompt: { text: "build it", images: [] } };

describe("unseen activity", () => {
  const OTHER = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [storedSession(SESSION, "Build it")], creatingIds: [], activeSessionId: OTHER, draft: null });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("marks a turn that ended in a background session until the session is opened", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(true);

    await useHuntStore.getState().selectSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(false);
  });

  it("leaves the active session alone", async () => {
    useHuntStore.setState({ activeSessionId: SESSION });
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(false);
  });
});

describe("prompt queue", () => {
  const SESSION = "11111111-1111-1111-1111-111111111111";

  /** A `send_prompt` call the test finishes by hand with the given stop reason. */
  function deferredTurn() {
    let finish: (stopReason: string) => void = () => {};
    const turn = new Promise<string>((resolve) => {
      finish = resolve;
    });
    return { turn, finish: (stopReason: string) => finish(stopReason) };
  }

  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [storedSession(SESSION, "Build it")], creatingIds: [], activeSessionId: SESSION, draft: null });
    vi.mocked(invoke).mockReset();
  });

  it("queues a prompt sent during a turn and sends it once the turn ends", async () => {
    const first = deferredTurn();
    const second = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(first.turn).mockReturnValueOnce(second.turn);

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["two"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    first.finish("EndTurn");
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2));
    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.queue).toEqual([]);
    expect(chat.isBusy).toBe(true);
    expect(chat.items.filter((item) => item.kind === "user").map((item) => item.kind === "user" && item.text)).toEqual(["one", "two"]);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("send_prompt", { id: SESSION, text: "two", images: [] });

    second.finish("EndTurn");
    await firstSend;
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
  });

  it("shows neither a diagram refresh nor the agent's output, and the next prompt ends the hidden turn", async () => {
    vi.mocked(invoke).mockImplementation(async () => {
      useHuntStore.getState().applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Diagram updated." } }));
      return "EndTurn";
    });

    await useHuntStore.getState().refreshGraph(SESSION);
    await useHuntStore.getState().refreshGraph(SESSION);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ items: [], isHiddenTurn: true });

    await useHuntStore.getState().sendPrompt(SESSION, "next");
    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.isHiddenTurn).toBe(false);
    expect(chat.items.map((item) => item.kind)).toEqual(["user", "agent"]);
  });

  it("marks the chat as generating the diagram until the graph turn ends, not while a queued prompt runs after it", async () => {
    const graphTurn = deferredTurn();
    const promptTurn = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(graphTurn.turn).mockReturnValueOnce(promptTurn.turn);

    const refresh = useHuntStore.getState().refreshGraph(SESSION);
    expect(useHuntStore.getState().chats[SESSION].isGeneratingGraph).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("refresh_graph", { id: SESSION, ...DEFAULT_GRAPH_AGENT });
    await useHuntStore.getState().sendPrompt(SESSION, "next");

    graphTurn.finish("EndTurn");
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2));
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isGeneratingGraph: false, isBusy: true });

    promptTurn.finish("EndTurn");
    await refresh;
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
  });

  it("keeps queued prompts unsent when the turn was cancelled", async () => {
    const first = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(first.turn);

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    first.finish("Cancelled");
    await firstSend;

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.isBusy).toBe(false);
    expect(chat.queue.map((prompt) => prompt.text)).toEqual(["two"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("hands the queue over and takes single prompts out", async () => {
    const first = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(first.turn);
    void useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    await useHuntStore.getState().sendPrompt(SESSION, "three");

    const [two] = useHuntStore.getState().chats[SESSION].queue;
    useHuntStore.getState().unqueuePrompt(SESSION, two.id);
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["three"]);

    expect(useHuntStore.getState().takeQueue(SESSION).map((prompt) => prompt.text)).toEqual(["three"]);
    expect(useHuntStore.getState().chats[SESSION].queue).toEqual([]);
    expect(useHuntStore.getState().takeQueue(SESSION)).toEqual([]);
  });
});

describe("createSession", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [], creatingIds: [], activeSessionId: null, draft: { parentId: null }, untitledIds: [] });
    useAgentDefaultsStore.setState({ recentRepoPaths: [] });
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
    expect(useAgentDefaultsStore.getState().recentRepoPaths).toEqual(["/repo"]);
    expect(pending.chats[pending.sessions[0].id].items).toEqual([{ kind: "user", id: expect.any(String), text: "build it", images: [] }]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["create_session", { id: pending.sessions[0].id, repoPath: "/repo", baseRef: "main", title: "Build it", pullRequest: null, diffBaseRef: null, pullRequestBranch: null, workspace: "worktree" }]]);

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

  it("names a session created without a title after its repository until its first prompt names it", async () => {
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "create_session") return Promise.resolve(storedSession((args as { id: string }).id, "repo"));
      if (command === "rename_session") return Promise.resolve(storedSession((args as { id: string }).id, (args as { title: string }).title));
      if (command === "send_prompt") return Promise.resolve("end_turn");
      return Promise.resolve(undefined);
    });

    const id = await useHuntStore.getState().createSession(TARGET, null, { ...START, prompt: null });
    expect(useHuntStore.getState().sessions[0].title).toBe("repo");
    expect(useHuntStore.getState().untitledIds).toEqual([id]);
    expect(vi.mocked(invoke).mock.calls[0]).toEqual(["create_session", { id, repoPath: "/repo", baseRef: "main", title: "repo", pullRequest: null, diffBaseRef: null, pullRequestBranch: null, workspace: "worktree" }]);

    await useHuntStore.getState().sendPrompt(id, "Fix the login bug\nwith details");
    await vi.waitFor(() => expect(useHuntStore.getState().sessions[0].title).toBe("Fix the login bug"));
    expect(useHuntStore.getState().untitledIds).toEqual([]);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toContain("rename_session");

    vi.mocked(invoke).mockClear();
    await useHuntStore.getState().sendPrompt(id, "And the logout");
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).not.toContain("rename_session");
  });

  it("lists a pull request review under the pull request's own branch while the backend creates it", async () => {
    let finish: () => void = () => {};
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "create_session") return Promise.resolve(undefined);
      return new Promise((resolve) => {
        finish = () => resolve(storedSession((args as { id: string }).id, "#12 Review"));
      });
    });
    const review = {
      ...TARGET,
      baseRef: "origin/fix/sentry/admin-ui-errors",
      pullRequest: { number: 12, url: "https://github.com/acme/app/pull/12" },
      diffBaseRef: "origin/main",
      pullRequestBranch: "fix/sentry/admin-ui-errors",
    };

    const creation = useHuntStore.getState().createSession(review, "#12 Review", { ...START, prompt: null });
    const id = useHuntStore.getState().sessions[0].id;
    expect(useHuntStore.getState().sessions[0].branch).toBe("fix/sentry/admin-ui-errors");
    expect(vi.mocked(invoke).mock.calls[0]).toEqual([
      "create_session",
      {
        id,
        repoPath: "/repo",
        baseRef: "origin/fix/sentry/admin-ui-errors",
        title: "#12 Review",
        pullRequest: { number: 12, url: "https://github.com/acme/app/pull/12" },
        diffBaseRef: "origin/main",
        pullRequestBranch: "fix/sentry/admin-ui-errors",
        workspace: "worktree",
      },
    ]);
    finish();
    await creation;
  });

  it("keeps the title of a session created with one", async () => {
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "create_session" ? Promise.resolve(storedSession((args as { id: string }).id, "#12 Review")) : Promise.resolve("end_turn"),
    );

    const id = await useHuntStore.getState().createSession(TARGET, "#12 Review", { ...START, prompt: null });
    expect(useHuntStore.getState().untitledIds).toEqual([]);
    await useHuntStore.getState().sendPrompt(id, "Look at the diff");
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).not.toContain("rename_session");
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
    expect(state.untitledIds).toEqual([]);
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

describe("closeSession", () => {
  beforeEach(() => {
    const sub = { ...storedSession("sub", "Sub"), parentId: "parent" };
    useHuntStore.setState({
      chats: { parent: createEmptyChat(), sub: createEmptyChat(), other: createEmptyChat() },
      sessions: [sub, storedSession("parent", "Parent"), storedSession("other", "Other")],
      creatingIds: [],
      removingIds: [],
      activeSessionId: "parent",
      draft: null,
    });
    vi.mocked(invoke).mockReset();
  });

  it("takes the session and its sub sessions off the list before the backend finished", async () => {
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "close_session" ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve([storedSession("other", "Other")]),
    );

    const closing = useHuntStore.getState().closeSession("parent", true);

    const pending = useHuntStore.getState();
    expect(pending.sessions.map((session) => session.id)).toEqual(["other"]);
    expect(pending.removingIds).toEqual(["parent", "sub"]);
    expect(pending.activeSessionId).toBeNull();
    expect(Object.keys(pending.chats)).toEqual(["other"]);

    finish();
    await closing;
    expect(useHuntStore.getState().removingIds).toEqual([]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["close_session", { id: "parent", removeWorktree: true }], ["list_sessions"]]);
  });

  it("keeps a session the backend still deletes out of a concurrent reload", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "close_session" ? new Promise(() => {}) : Promise.resolve([storedSession("parent", "Parent"), storedSession("other", "Other")]),
    );

    void useHuntStore.getState().closeSession("parent", true);
    await useHuntStore.getState().refreshSessions();

    expect(useHuntStore.getState().sessions.map((session) => session.id)).toEqual(["other"]);
  });

  it("lists the session again with the error when the deletion failed", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "close_session" ? Promise.reject("failed to remove the worktree") : Promise.resolve([storedSession("parent", "Parent"), storedSession("other", "Other")]),
    );

    await useHuntStore.getState().closeSession("parent", true);

    const state = useHuntStore.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(["parent", "other"]);
    expect(state.removingIds).toEqual([]);
    expect(state.activeSessionId).toBe("parent");
    expect(state.chats.parent.error).toBe("Deleting the session failed: failed to remove the worktree");
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

describe("remote sessions", () => {
  const remote = {
    vm: { project: "p", zone: "z", instance: "vm-hunt" },
    worktreePath: `/srv/worktrees/${SESSION}`,
    repo: "o/r",
    branch: "feat/general/x",
    handoffHead: "abc",
    handedOffAt: "2026-10-12T20:00:00Z",
    localMode: "default",
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: null,
    origin: "handoff" as const,
    issue: null,
  };

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("adopts session VMs only with complete settings and keeps the failure", async () => {
    useHuntStore.setState({ remoteSync: { isRunning: false, error: null } });
    useSettingsStore.setState({ remote: DEFAULT_REMOTE });
    await useHuntStore.getState().syncRemoteSessions();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    const vm = { project: "acme-hunt" };
    useSettingsStore.setState({ remote: { ...DEFAULT_REMOTE, ...vm } });
    useAgentDefaultsStore.setState({ recentRepoPaths: ["/src/app"] });
    const failure = "failed to run sessions.list on the gateway: forbidden";
    vi.mocked(invoke).mockImplementation((command) => (command === "adopt_session_vms" ? Promise.reject(failure) : Promise.resolve([])));
    await useHuntStore.getState().syncRemoteSessions();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("adopt_session_vms", { settings: { ...vm, machineType: null }, repoPaths: ["/src/app"] });
    expect(useHuntStore.getState().remoteSync).toEqual({ isRunning: false, error: failure });

    vi.mocked(invoke).mockImplementation((command) => Promise.resolve(command === "adopt_session_vms" ? ["new-id"] : []));
    await useHuntStore.getState().syncRemoteSessions();
    expect(useHuntStore.getState().remoteSync).toEqual({ isRunning: false, error: null });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("list_sessions");
    useSettingsStore.setState({ remote: DEFAULT_REMOTE });
  });

  it("reloads the changes once a turn on the relay ends, whoever sent it", () => {
    useHuntStore.setState({ chats: {} });
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } }));
    expect(useHuntStore.getState().chats[SESSION].editVersion).toBe(0);
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "running" } } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } }));
    expect(useHuntStore.getState().chats[SESSION].editVersion).toBe(1);
  });

  it("shows the mode the agent reports in its mode option", () => {
    useHuntStore.setState({ chats: {} });
    useHuntStore.getState().applyUpdate(SESSION, notification({
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "mode", name: "Mode", type: "select", currentValue: "bypassPermissions", options: [{ value: "bypassPermissions", name: "Bypass" }] }],
    }));
    expect(useHuntStore.getState().chats[SESSION].modeId).toBe("bypassPermissions");
  });

  it("takes the turn state the relay reports after a reconnect", () => {
    useHuntStore.setState({ chats: {} });
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "running" } } }));
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(true);
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } }));
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", title: "unrelated" }));
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
  });

  it("connects a disconnected remote session before sending the prompt", async () => {
    const stopped = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    useHuntStore.setState({ chats: {}, sessions: [stopped], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") return Promise.resolve({ ...stopped, isLive: true });
      if (command === "list_sessions") return Promise.resolve([{ ...stopped, isLive: true }]);
      if (command === "send_prompt") return Promise.resolve("EndTurn");
      return Promise.resolve(undefined);
    });

    await useHuntStore.getState().sendPrompt(SESSION, "go on");

    const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(calls.indexOf("open_session")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("send_prompt")).toBeGreaterThan(calls.indexOf("open_session"));
  });

  it("keeps the prompt in the queue when the VM cannot be reached", async () => {
    const stopped = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    useHuntStore.setState({ chats: {}, sessions: [stopped], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") return Promise.reject("failed to start the VM vm-hunt");
      if (command === "list_sessions") return Promise.resolve([stopped]);
      return Promise.resolve(undefined);
    });

    await useHuntStore.getState().sendPrompt(SESSION, "go on");

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.queue.map((prompt) => prompt.text)).toEqual(["go on"]);
    expect(chat.error).toBe("failed to start the VM vm-hunt");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("send_prompt", expect.anything());
  });

  it("keeps the conversation while a remote session reconnects until the replay replaces it", async () => {
    const stopped = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    useHuntStore.setState({ chats: {}, sessions: [stopped], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "before" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }));
    const itemsBefore = useHuntStore.getState().chats[SESSION].items;
    let itemsWhileConnecting: unknown = null;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") {
        itemsWhileConnecting = useHuntStore.getState().chats[SESSION].items;
        applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed" } }));
        return Promise.resolve({ ...stopped, isLive: true });
      }
      if (command === "list_sessions") return Promise.resolve([{ ...stopped, isLive: true }]);
      return Promise.resolve(undefined);
    });

    await useHuntStore.getState().resumeSession(SESSION);

    expect(itemsWhileConnecting).toBe(itemsBefore);
    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.items).toHaveLength(1);
    expect(JSON.stringify(chat.items)).toContain("replayed");
    expect(chat.isStale).toBe(false);
  });

  it("keeps the conversation next to the error when the connect fails, and starts empty when nothing is replayed", async () => {
    const stopped = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    useHuntStore.setState({ chats: {}, sessions: [stopped], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    useHuntStore.getState().applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }));
    vi.mocked(invoke).mockImplementation((command) => (command === "open_session" ? Promise.reject("failed to start the VM vm-hunt") : Promise.resolve([stopped])));

    await useHuntStore.getState().resumeSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ error: "failed to start the VM vm-hunt", isStale: false, isLoading: false });
    expect(useHuntStore.getState().chats[SESSION].items).toHaveLength(1);

    vi.mocked(invoke).mockImplementation((command) => Promise.resolve(command === "open_session" ? { ...stopped, isLive: true } : [stopped]));
    await useHuntStore.getState().resumeSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ items: [], isStale: false, isLoading: false, error: null });
  });

  it("does not report a dropped VM connection as an error", () => {
    useHuntStore.setState({ chats: {}, sessions: [{ ...storedSession(SESSION, "Remote"), remote }] });
    useHuntStore.getState().ensureChat(SESSION);
    useHuntStore.getState().applyClosed({ huntSessionId: SESSION, error: "Process exited with exit status: 255" });
    expect(useHuntStore.getState().chats[SESSION].error).toBeNull();
    expect(useHuntStore.getState().sessions[0].isLive).toBe(false);
  });
});

describe("moving a session to and from the VM", () => {
  const settings = { project: "acme-hunt", machineType: null };
  const remote = {
    vm: { project: "acme-hunt", zone: "z", instance: "vm-hunt" },
    worktreePath: `/srv/worktrees/${SESSION}`,
    repo: "o/r",
    branch: "feat/general/x",
    handoffHead: "abc",
    handedOffAt: "2026-10-14T20:00:00Z",
    localMode: "default",
    lastActiveAt: null,
    cleanupAskedAt: null,
    previewDomain: null,
    origin: "handoff" as const,
    issue: null,
  };
  const local = storedSession(SESSION, "Build it");
  const handedOff = { ...local, remote };

  /** A promise the test settles by hand. */
  function deferred<T>() {
    let settle: (value: T) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return { promise, settle: (value: T) => settle(value), fail: (reason: unknown) => fail(reason) };
  }

  /** The commands the store invoked so far, with the prompt text of each `send_prompt`. */
  function calls(): string[] {
    return vi.mocked(invoke).mock.calls.map(([command, args]) => (command === "send_prompt" ? `send_prompt ${(args as { text: string }).text}` : command));
  }

  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [local], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    useSettingsStore.setState({ remote: { ...DEFAULT_REMOTE, project: "acme-hunt" } });
    vi.mocked(invoke).mockReset();
  });

  it("brings the VM up during a turn, hands off once the turn ended and sends the prompts queued meanwhile there", async () => {
    const turn = deferred<string>();
    const prepared = deferred<void>();
    let isHandedOff = false;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "send_prompt") return calls().filter((call) => call.startsWith("send_prompt")).length === 1 ? turn.promise : Promise.resolve("EndTurn");
      if (command === "prepare_hand_off") return prepared.promise;
      if (command === "hand_off_session") {
        isHandedOff = true;
        return Promise.resolve({ ...handedOff });
      }
      if (command === "list_sessions") return Promise.resolve([isHandedOff ? handedOff : local]);
      return Promise.resolve(undefined);
    });

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    const handOff = useHuntStore.getState().handOffSession(SESSION);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("prepare_hand_off", { id: SESSION, settings });
    expect(useHuntStore.getState().chats[SESSION].move).toBe("handOff");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["two"]);

    prepared.settle();
    await vi.waitFor(() => expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(true));
    expect(calls()).not.toContain("hand_off_session");

    turn.settle("EndTurn");
    await Promise.all([firstSend, handOff]);
    expect(calls()).toEqual(["send_prompt one", "prepare_hand_off", "hand_off_session", "list_sessions", "send_prompt two"]);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ move: null, queue: [], isBusy: false });
  });

  it("hands an idle session off without bringing the VM up first", async () => {
    vi.mocked(invoke).mockImplementation((command) => Promise.resolve(command === "list_sessions" ? [handedOff] : command === "hand_off_session" ? handedOff : undefined));

    await useHuntStore.getState().handOffSession(SESSION);

    expect(calls()).toEqual(["hand_off_session", "list_sessions"]);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hand_off_session", { id: SESSION, settings, filePatterns: DEFAULT_REMOTE.filePatterns });
    expect(useHuntStore.getState().chats[SESSION].move).toBeNull();
  });

  const stoppedService = { name: "ui", port: 4200, url: "https://x-4200.hunt.example.com", guarded: true, tls: false, enabled: false, state: "stopped", responds: false };

  /** Answers the commands of a handoff with `previewStatus` for preview_status and ends every turn. */
  function answerHandOff(previewStatus: () => Promise<unknown>) {
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "list_sessions") return Promise.resolve([handedOff]);
      if (command === "hand_off_session") return Promise.resolve(handedOff);
      if (command === "preview_status") return previewStatus();
      return Promise.resolve("EndTurn");
    });
  }

  it("has the agent start the services its task needs once a session with a prompt arrived on the VM", async () => {
    answerHandOff(() => Promise.resolve({ vmRunning: true, services: [stoppedService], listening: [] }));
    await useHuntStore.getState().sendPrompt(SESSION, "Fix the admin page");

    await useHuntStore.getState().handOffSession(SESSION);

    expect(calls()).toEqual(["send_prompt Fix the admin page", "hand_off_session", "list_sessions", "preview_status", `send_prompt ${HANDOFF_START_PROMPT}`]);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ move: null, isBusy: false, error: null });
  });

  it("asks for no start after the handoff when a service runs already or hunt.json declares none, and reports a failed check", async () => {
    const cases: [string, () => Promise<unknown>, string | null][] = [
      ["running", () => Promise.resolve({ vmRunning: true, services: [{ ...stoppedService, state: "running", responds: true }], listening: [] }), null],
      ["starting", () => Promise.resolve({ vmRunning: true, services: [{ ...stoppedService, state: "starting" }], listening: [] }), null],
      ["no services", () => Promise.resolve({ vmRunning: true, services: [], listening: [] }), null],
      ["failed check", () => Promise.reject("failed to read the preview status: ssh exited with 255"), "failed to check the services on the VM: failed to read the preview status: ssh exited with 255"],
    ];
    for (const [name, previewStatus, error] of cases) {
      useHuntStore.setState({ chats: {}, sessions: [local] });
      vi.mocked(invoke).mockReset();
      answerHandOff(previewStatus);
      await useHuntStore.getState().sendPrompt(SESSION, "Fix the admin page");

      await useHuntStore.getState().handOffSession(SESSION);

      expect(calls(), name).toEqual(["send_prompt Fix the admin page", "hand_off_session", "list_sessions", "preview_status"]);
      expect(useHuntStore.getState().chats[SESSION].error, name).toBe(error);
    }
  });

  it("keeps the session local when its VM cannot be brought up, and the turn and its queue go on", async () => {
    const turn = deferred<string>();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "send_prompt") return calls().filter((call) => call.startsWith("send_prompt")).length === 1 ? turn.promise : Promise.resolve("EndTurn");
      if (command === "prepare_hand_off") return Promise.reject("failed to provision the session's VM: quota exceeded");
      return Promise.resolve(undefined);
    });

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    await useHuntStore.getState().handOffSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ move: null, isBusy: true, error: "failed to provision the session's VM: quota exceeded" });

    turn.settle("EndTurn");
    await firstSend;
    expect(calls()).toEqual(["send_prompt one", "prepare_hand_off", "send_prompt two"]);
  });

  it("brings a remote session back once the turn on the relay ended", async () => {
    useHuntStore.setState({ sessions: [handedOff] });
    vi.mocked(invoke).mockImplementation((command) => Promise.resolve(command === "list_sessions" ? [local] : command === "retrieve_session" ? local : undefined));
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "running" } } }));

    const retrieval = useHuntStore.getState().retrieveSession(SESSION);
    await Promise.resolve();
    expect(calls()).toEqual([]);
    expect(useHuntStore.getState().chats[SESSION].move).toBe("retrieve");

    applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } }));
    await retrieval;
    expect(calls()).toEqual(["retrieve_session", "list_sessions"]);
    expect(useHuntStore.getState().chats[SESSION].move).toBeNull();
  });
});

describe("clearing", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [storedSession(SESSION, "Build it")], creatingIds: [], activeSessionId: SESSION, draft: null });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("restarts the agent for /clear instead of sending it", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, " /clear ");

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("clear_session", { id: SESSION });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("send_prompt", expect.anything());
    expect(useHuntStore.getState().chats[SESSION].items).toEqual([]);
  });

  it("queues /clear while a turn runs and restarts once it ended", async () => {
    let finishTurn: (stopReason: string) => void = () => {};
    vi.mocked(invoke).mockReturnValueOnce(new Promise<string>((resolve) => {
      finishTurn = resolve;
    }));
    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "/clear");
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    finishTurn("end_turn");
    await firstSend;
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("clear_session", { id: SESSION }));
    expect(useHuntStore.getState().chats[SESSION].queue).toEqual([]);
  });
});
