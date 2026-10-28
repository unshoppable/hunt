import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "./session.types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { usePlanUsageStore } from "../accounts/plan-usage.store";
import { useAgentDefaultsStore } from "../chat/agent-defaults.store";
import { createEmptyChat } from "../chat/chat-reducer.utils";
import { hasPendingQuestion } from "../chat/chat.store-slice";
import { useHuntStore } from "./hunt.store";
import { SESSION, START, TARGET, notification, storedSession } from "./hunt.store.fixtures";
import { agentSetupOf } from "./session.store-slice";

// The first turn that ends in a test file refreshes the plan usage at once (see accounts/plan-usage.store.ts); these
// tests list the backend calls of the sessions alone.
usePlanUsageStore.setState({ refresh: () => undefined });

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

describe("resumeSession", () => {
  const replay = [
    notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "first question" } }),
    notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "latest answer" } }),
  ];

  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [{ ...storedSession(SESSION, "one"), isLive: false }], activeSessionId: SESSION });
    vi.mocked(invoke).mockReset();
  });

  it("keeps the conversation when a second open during the first attaches to the agent the first started", async () => {
    const opens: Array<(view: SessionView) => void> = [];
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") return new Promise((resolve) => opens.push(resolve));
      if (command === "session_history") return Promise.resolve(replay);
      if (command === "list_sessions") return Promise.resolve([storedSession(SESSION, "one")]);
      return Promise.resolve(undefined);
    });
    const { resumeSession, applyUpdate } = useHuntStore.getState();
    const first = resumeSession(SESSION);
    // The started agent replays its conversation while the open still runs.
    for (const update of replay) {
      applyUpdate(SESSION, update);
    }
    // The second open (a double click) marks the shown conversation as stale and waits for the first open.
    const second = resumeSession(SESSION);
    expect(opens).toHaveLength(2);
    expect(useHuntStore.getState().chats[SESSION].isStale).toBe(true);

    opens[0]({} as SessionView);
    await first;
    expect(useHuntStore.getState().chats[SESSION].items.map((item) => item.kind)).toEqual(["user", "agent"]);

    opens[1]({} as SessionView);
    await second;
    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.items.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(chat).toMatchObject({ isLoading: false, isStale: false, hasHistory: true });
  });

  it("rebuilds the chat from the backend's history when the open attaches to an agent that already runs", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "session_history") return replay;
      if (command === "list_sessions") return [storedSession(SESSION, "one")];
      return undefined;
    });

    await useHuntStore.getState().resumeSession(SESSION);

    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.items.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(chat).toMatchObject({ isLoading: false, isStale: false, hasHistory: true });
    expect(useHuntStore.getState().sessions[0].isLive).toBe(true);
  });
});

describe("loadAllChats", () => {
  const LIVE = "22222222-2222-2222-2222-222222222222";
  const REMOTE = "33333333-3333-3333-3333-333333333333";
  const WITHOUT_WORKTREE = "44444444-4444-4444-4444-444444444444";
  const answer = notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Shall I push?" } });

  beforeEach(() => {
    useHuntStore.setState({
      chats: {},
      creatingIds: [],
      activeSessionId: null,
      sessions: [
        { ...storedSession(SESSION, "stopped"), isLive: false },
        storedSession(LIVE, "live"),
        { ...storedSession(REMOTE, "remote"), isLive: false, remote: { agent: "running" } as SessionView["remote"] },
        { ...storedSession(WITHOUT_WORKTREE, "gone"), isLive: false, hasLocalWorktree: false },
      ],
    });
    vi.mocked(invoke).mockReset();
  });

  it("starts every stopped local agent and rebuilds every running one's chat, but connects no remote session", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "session_history") return [answer];
      if (command === "list_sessions") return useHuntStore.getState().sessions;
      return undefined;
    });

    await useHuntStore.getState().loadAllChats();

    const calls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "open_session" || command === "session_history");
    expect(calls).toEqual([
      ["open_session", { id: SESSION }],
      ["session_history", { id: LIVE }],
      ["session_history", { id: SESSION }],
    ]);
    const { chats } = useHuntStore.getState();
    expect(hasPendingQuestion(chats[SESSION])).toBe(true);
    expect(hasPendingQuestion(chats[LIVE])).toBe(true);
    expect(chats[REMOTE]).toBeUndefined();
    expect(chats[WITHOUT_WORKTREE]).toBeUndefined();
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
    expect(pending.chats[pending.sessions[0].id].items).toEqual([{ kind: "user", id: expect.any(String), text: "build it", images: [], messageId: expect.any(String) }]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["create_session", { id: pending.sessions[0].id, repoPath: "/repo", baseRef: "main", title: "Build it", pullRequest: null, diffBaseRef: null, pullRequestBranch: null, newBranch: null, workspace: "worktree" }]]);

    finish();
    const id = await creation;
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toContain("send_prompt"));

    const done = useHuntStore.getState();
    expect(id).toBe(pending.sessions[0].id);
    expect(done.sessions[0]).toEqual(storedSession(id, "Build it"));
    expect(done.creatingIds).toEqual([]);
    const [shown] = done.chats[id].items;
    expect(vi.mocked(invoke).mock.calls.slice(1)).toEqual([
      ["set_session_config_option", { id, configId: "model", value: "fable" }],
      ["set_session_config_option", { id, configId: "effort", value: "high" }],
      ["set_session_mode", { id, modeId: "plan" }],
      ["send_prompt", { id, text: "build it", images: [], messageId: shown.kind === "user" ? shown.messageId : "" }],
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
    expect(vi.mocked(invoke).mock.calls[0]).toEqual(["create_session", { id, repoPath: "/repo", baseRef: "main", title: "repo", pullRequest: null, diffBaseRef: null, pullRequestBranch: null, newBranch: null, workspace: "worktree" }]);

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
        newBranch: null,
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

  it("keeps a session being created at the end when the stored list is reloaded without it", async () => {
    vi.mocked(invoke).mockImplementation((command) => (command === "create_session" ? new Promise(() => {}) : Promise.resolve([storedSession("old", "Older")])));
    void useHuntStore.getState().createSession(TARGET, "Build it", START);

    await useHuntStore.getState().refreshSessions();

    expect(useHuntStore.getState().sessions.map((session) => session.title)).toEqual(["Older", "Build it"]);
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
    expect(pending.sessions.map((session) => [session.title, session.parentId, session.worktreePath])).toEqual([["Parent", null, "/worktrees/parent"], ["Sub", "parent", "/worktrees/parent"]]);
    expect(pending.activeSessionId).toBe("parent");

    const id = await creation;
    expect(useHuntStore.getState().sessions[1]).toEqual({ ...storedSession(id, "Sub"), parentId: "parent" });
    expect(vi.mocked(invoke).mock.calls).toEqual([["create_sub_session", { id, parentId: "parent", title: "Sub", selection: null }]]);
  });

  it("creates a sub chat of a remote session, whose agent the backend starts on its VM", async () => {
    const remote = { vm: { project: "p", zone: "z", instance: "vm-hunt" }, worktreePath: "/home/agent/app" } as SessionView["remote"];
    useHuntStore.setState({ sessions: [{ ...storedSession("parent", "Parent"), remote }] });
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "create_sub_session" ? Promise.resolve({ ...storedSession((args as { id: string }).id, "Sub"), parentId: "parent" }) : Promise.resolve(undefined),
    );

    const id = await useHuntStore.getState().createSubSession("parent", "Sub", null, { setup: { configValues: {}, modeId: "default" }, prompt: null }, false);

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
      annotations: { parent: [], other: [] },
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

    const closing = useHuntStore.getState().closeSession("parent", "delete");

    const pending = useHuntStore.getState();
    expect(pending.sessions.map((session) => session.id)).toEqual(["other"]);
    expect(pending.removingIds).toEqual(["parent", "sub"]);
    expect(pending.activeSessionId).toBeNull();
    expect(Object.keys(pending.chats)).toEqual(["other"]);
    expect(Object.keys(pending.annotations)).toEqual(["other"]);

    finish();
    await closing;
    expect(useHuntStore.getState().removingIds).toEqual([]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["close_session", { id: "parent", ending: "delete" }], ["list_sessions"]]);
  });

  it("keeps a session the backend still deletes out of a concurrent reload", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "close_session" ? new Promise(() => {}) : Promise.resolve([storedSession("parent", "Parent"), storedSession("other", "Other")]),
    );

    void useHuntStore.getState().closeSession("parent", "forget");
    await useHuntStore.getState().refreshSessions();

    expect(useHuntStore.getState().sessions.map((session) => session.id)).toEqual(["other"]);
  });

  it("lists the session again with the error when the deletion failed", async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      command === "close_session" ? Promise.reject("failed to remove the worktree") : Promise.resolve([storedSession("parent", "Parent"), storedSession("other", "Other")]),
    );

    await useHuntStore.getState().closeSession("parent", "delete");

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
