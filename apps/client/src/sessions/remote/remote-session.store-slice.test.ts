import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../session.types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { HANDOFF_START_PROMPT } from "../../preview/preview-services.utils";
import { useAgentDefaultsStore } from "../../chat/agent-defaults.store";
import { createEmptyChat } from "../../chat/chat-reducer.utils";
import { DEFAULT_REMOTE, useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../hunt.store";
import { SESSION, notification, storedSession } from "../hunt.store.fixtures";

describe("remote file sync", () => {
  beforeEach(() => {
    useHuntStore.setState({ chats: { [SESSION]: createEmptyChat() }, sessions: [], activeSessionId: null });
  });

  const ended = { huntSessionId: SESSION, isRunning: false, syncedAt: null, error: null, conflicts: [], changedLocal: false };

  it("keeps the last success while a sync runs and reloads the views after one that changed local files", () => {
    const { applyRemoteSync } = useHuntStore.getState();
    applyRemoteSync({ ...ended, syncedAt: "2026-10-14T10:05:00Z", changedLocal: true });
    applyRemoteSync({ ...ended, isRunning: true });
    const chat = useHuntStore.getState().chats[SESSION];
    expect(chat.fileSync).toEqual({ isRunning: true, syncedAt: "2026-10-14T10:05:00Z", error: null, conflicts: [] });
    expect(chat.editVersion).toBe(1);
  });

  it("records a failure and the files it could not sync until the next sync succeeds", () => {
    const { applyRemoteSync } = useHuntStore.getState();
    applyRemoteSync({ ...ended, syncedAt: "2026-10-14T10:05:00Z", conflicts: ["src: a folder here is where the VM has a file"] });
    expect(useHuntStore.getState().chats[SESSION].fileSync.conflicts).toEqual(["src: a folder here is where the VM has a file"]);
    const error = "failed to list the files on the VM";
    applyRemoteSync({ ...ended, error });
    expect(useHuntStore.getState().chats[SESSION].fileSync).toEqual({ isRunning: false, syncedAt: "2026-10-14T10:05:00Z", error, conflicts: [] });
    applyRemoteSync({ ...ended, syncedAt: "2026-10-14T10:06:00Z" });
    expect(useHuntStore.getState().chats[SESSION].fileSync.error).toBeNull();
    expect(useHuntStore.getState().chats[SESSION].editVersion).toBe(0);

    applyRemoteSync({ ...ended, huntSessionId: "other", isRunning: true });
    expect(useHuntStore.getState().chats.other).toBeUndefined();
  });

  it("reloads the views of the sub chats in the synced worktree and keeps the sync state on its session's chat", () => {
    const sub = "22222222-2222-2222-2222-222222222222";
    const other = "33333333-3333-3333-3333-333333333333";
    useHuntStore.setState({
      chats: { [SESSION]: createEmptyChat(), [sub]: createEmptyChat(), [other]: createEmptyChat() },
      sessions: [
        { id: SESSION, parentId: null, worktreePath: "/worktrees/top" },
        { id: sub, parentId: SESSION, worktreePath: "/worktrees/top" },
        { id: other, parentId: null, worktreePath: "/worktrees/other" },
      ] as unknown as SessionView[],
    });

    useHuntStore.getState().applyRemoteSync({ ...ended, syncedAt: "2026-10-14T10:05:00Z", changedLocal: true });

    const { chats } = useHuntStore.getState();
    expect([chats[SESSION].editVersion, chats[sub].editVersion, chats[other].editVersion]).toEqual([1, 1, 0]);
    expect(chats[SESSION].fileSync.syncedAt).toBe("2026-10-14T10:05:00Z");
    expect(chats[sub].fileSync.syncedAt).toBeNull();
  });

  it("stops showing a running sync when the connection ends", () => {
    useHuntStore.getState().applyRemoteSync({ ...ended, isRunning: true });
    useHuntStore.getState().applyClosed({ huntSessionId: SESSION, error: null });
    expect(useHuntStore.getState().chats[SESSION].fileSync.isRunning).toBe(false);
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
    agent: "",
    pushTargetPending: false,
    relayActivity: null,
  };

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("syncs remote sessions only with complete settings and keeps the failure", async () => {
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
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("adopt_session_vms", { settings: { ...vm, machineType: null }, repoPaths: ["/src/app"], ids: [] });
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
      return Promise.resolve(command === "session_history" ? [] : undefined);
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

  it("keeps the conversation next to the error when the connect fails, and starts from the backend's history when nothing is replayed", async () => {
    const stopped = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    useHuntStore.setState({ chats: {}, sessions: [stopped], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    useHuntStore.getState().applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }));
    vi.mocked(invoke).mockImplementation((command) => (command === "open_session" ? Promise.reject("failed to start the VM vm-hunt") : Promise.resolve([stopped])));

    await useHuntStore.getState().resumeSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ error: "failed to start the VM vm-hunt", isStale: false, isLoading: false });
    expect(useHuntStore.getState().chats[SESSION].items).toHaveLength(1);

    vi.mocked(invoke).mockImplementation((command) => Promise.resolve(command === "open_session" ? { ...stopped, isLive: true } : command === "session_history" ? [] : [stopped]));
    await useHuntStore.getState().resumeSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ items: [], isStale: false, isLoading: false, error: null });
  });

  it("connects a disconnected sub chat of a remote session before sending the prompt", async () => {
    const parent = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    const sub = { ...storedSession("sub", "Sub"), parentId: SESSION, isLive: false };
    useHuntStore.setState({ chats: {}, sessions: [sub, parent], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") return Promise.resolve({ ...sub, isLive: true });
      if (command === "list_sessions") return Promise.resolve([{ ...sub, isLive: true }, parent]);
      if (command === "send_prompt") return Promise.resolve("EndTurn");
      return Promise.resolve(command === "session_history" ? [] : undefined);
    });

    await useHuntStore.getState().sendPrompt("sub", "and this?");

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("open_session", { id: "sub" });
    const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(calls.indexOf("send_prompt")).toBeGreaterThan(calls.indexOf("open_session"));
  });

  it("leaves the stopped sub chats of a remote session alone when the session connects: they run here when opened", async () => {
    const parent = { ...storedSession(SESSION, "Remote"), isLive: false, remote };
    const subs = ["sub-a", "sub-b"].map((id) => ({ ...storedSession(id, id), parentId: SESSION, isLive: false }));
    useHuntStore.setState({ chats: {}, sessions: [parent, ...subs], creatingIds: [], activeSessionId: SESSION, draft: null, untitledIds: [] });
    const opened = new Set<string>();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "open_session") {
        const { id } = args as { id: string };
        opened.add(id);
        return Promise.resolve({ ...useHuntStore.getState().sessions.find((session) => session.id === id), isLive: true });
      }
      if (command === "list_sessions") return Promise.resolve(useHuntStore.getState().sessions.map((session) => (opened.has(session.id) ? { ...session, isLive: true } : session)));
      return Promise.resolve(command === "session_history" ? [] : undefined);
    });

    await useHuntStore.getState().resumeSession(SESSION);
    await useHuntStore.getState().refreshSessions();
    expect([...opened]).toEqual([SESSION]);
    expect(useHuntStore.getState().sessions.filter((session) => session.isLive).map((session) => session.id)).toEqual([SESSION]);
  });

  it("reports a stopped agent of a remote session's sub chat as an error, since it runs here", () => {
    useHuntStore.setState({ chats: {}, sessions: [{ ...storedSession("sub", "Sub"), parentId: SESSION }, { ...storedSession(SESSION, "Remote"), remote }] });
    useHuntStore.getState().ensureChat("sub");
    useHuntStore.getState().applyClosed({ huntSessionId: "sub", error: "Process exited with exit status: 255" });
    expect(useHuntStore.getState().chats.sub.error).toBe("Agent stopped: Process exited with exit status: 255");
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
    agent: "",
    pushTargetPending: false,
    relayActivity: null,
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
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hand_off_session", { id: SESSION, settings });
    expect(useHuntStore.getState().chats[SESSION].move).toBeNull();
  });

  it("leaves the sub chats stopped after the handoff: they start here again when opened", async () => {
    const sub = { ...storedSession("sub", "Sub"), parentId: SESSION, isLive: false };
    useHuntStore.setState({ sessions: [local, sub] });
    let isHandedOff = false;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "hand_off_session") {
        isHandedOff = true;
        return Promise.resolve(handedOff);
      }
      if (command === "list_sessions") return Promise.resolve([isHandedOff ? handedOff : local, sub]);
      return Promise.resolve(command === "session_history" ? [] : undefined);
    });

    await useHuntStore.getState().handOffSession(SESSION);
    await useHuntStore.getState().refreshSessions();

    expect(calls()).not.toContain("open_session");
    expect(useHuntStore.getState().sessions.find((session) => session.id === "sub")?.isLive).toBe(false);
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
