import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredBrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import type { Screenshot } from "./chat.types";
import type { SessionView } from "../sessions/session.types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_GRAPH_AGENT } from "../settings/settings.store";
import { useHuntStore } from "../sessions/hunt.store";
import { SESSION, TARGET, notification, storedSession } from "../sessions/hunt.store.fixtures";
import { createEmptyChat } from "./chat-reducer.utils";
import { hasPendingQuestion } from "./chat.store-slice";

describe("browser annotations", () => {
  beforeEach(() => {
    useHuntStore.setState({ annotations: {} });
  });

  function annotation(id: string, comment: string): StoredBrowserAnnotation {
    return {
      id,
      createdAt: 1_760_000_000_000,
      url: "https://app.example/",
      title: "App",
      selector: "main > h1",
      text: "Welcome",
      outerHtml: "<h1>Welcome</h1>",
      rect: { x: 0, y: 0, width: 100, height: 40 },
      viewport: { width: 1280, height: 800 },
      styles: {},
      comment,
    };
  }

  it("collects the delivered annotations per session in arrival order and ignores one delivered again", () => {
    const { applyAnnotation } = useHuntStore.getState();
    applyAnnotation({ huntSessionId: SESSION, annotation: annotation("a", "Larger") });
    applyAnnotation({ huntSessionId: SESSION, annotation: annotation("b", "Bold") });
    applyAnnotation({ huntSessionId: "other", annotation: annotation("a", "Elsewhere") });
    const before = useHuntStore.getState().annotations;
    applyAnnotation({ huntSessionId: SESSION, annotation: annotation("a", "Larger, again") });

    const { annotations } = useHuntStore.getState();
    expect(annotations).toBe(before);
    expect(annotations[SESSION].map((stored) => stored.comment)).toEqual(["Larger", "Bold"]);
    expect(annotations.other.map((stored) => stored.comment)).toEqual(["Elsewhere"]);
  });

  it("removes one annotation, forgets a session without any and clears a session's annotations", () => {
    const { applyAnnotation, removeAnnotation, clearAnnotations } = useHuntStore.getState();
    applyAnnotation({ huntSessionId: SESSION, annotation: annotation("a", "Larger") });
    applyAnnotation({ huntSessionId: SESSION, annotation: annotation("b", "Bold") });
    applyAnnotation({ huntSessionId: "other", annotation: annotation("c", "Elsewhere") });

    removeAnnotation(SESSION, "a");
    expect(useHuntStore.getState().annotations[SESSION].map((stored) => stored.id)).toEqual(["b"]);
    const before = useHuntStore.getState().annotations;
    removeAnnotation(SESSION, "unknown");
    expect(useHuntStore.getState().annotations).toBe(before);
    removeAnnotation(SESSION, "b");
    expect(SESSION in useHuntStore.getState().annotations).toBe(false);

    clearAnnotations("other");
    expect(useHuntStore.getState().annotations).toEqual({});
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

describe("pending question", () => {
  const agent = (text: string) => ({ kind: "agent" as const, id: "a1", text, images: [] });

  it("is pending only while the turn ended with the agent's question as the last item", () => {
    const chat = { ...createEmptyChat(), items: [agent("Shall I push?")] };
    expect(hasPendingQuestion(chat)).toBe(true);
    expect(hasPendingQuestion({ ...chat, isBusy: true })).toBe(false);
    expect(hasPendingQuestion({ ...chat, queue: [{ id: "q1", text: "yes", images: [] }] })).toBe(false);
    expect(hasPendingQuestion({ ...chat, items: [agent("Shall I push?"), { kind: "user", id: "u1", text: "Yes.", images: [] }] })).toBe(false);
    expect(hasPendingQuestion({ ...chat, items: [agent("Done, pushed.")] })).toBe(false);
    expect(hasPendingQuestion({ ...chat, items: [agent("Shall I push?"), { kind: "thought", id: "t1", text: "…" }] })).toBe(false);
  });

  it("is pending when the agent ended its reply with the question marker, question mark or not", () => {
    const chat = { ...createEmptyChat(), items: [agent("Pick A or B.\n\n<!-- hunt:question -->\n")] };
    expect(hasPendingQuestion(chat)).toBe(true);
    expect(hasPendingQuestion({ ...chat, isBusy: true })).toBe(false);
    expect(hasPendingQuestion({ ...chat, items: [agent("<!-- hunt:question -->\nI pushed the branch.")] })).toBe(false);
  });
});

describe("unseen activity", () => {
  const OTHER = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [storedSession(SESSION, "Build it")], creatingIds: [], activeSessionId: OTHER, unreadLine: null, draft: null });
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

  it("marks a turn another window ran once it ends, but not one a load replays", () => {
    const running = notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "running" } } });
    const idle = notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } });
    useHuntStore.getState().applyReplay(SESSION, [running, idle]);
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(false);

    useHuntStore.getState().applyUpdate(SESSION, idle);
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(false);

    useHuntStore.getState().applyUpdate(SESSION, running);
    useHuntStore.getState().applyUpdate(SESSION, idle);
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(true);
  });

  it("clears the mark once the user looked at the chat and announces it to the other windows", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    vi.mocked(emit).mockClear();

    useHuntStore.getState().markChatSeen(SESSION);
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(false);
    expect(emit).toHaveBeenCalledWith("chat:seen", { sessionId: SESSION });

    vi.mocked(emit).mockClear();
    useHuntStore.getState().markChatSeen(SESSION);
    expect(emit).not.toHaveBeenCalled();
  });

  it("remembers the prompt whose reply began the unseen activity until the chat is seen", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    await useHuntStore.getState().sendPrompt(SESSION, "go on");
    const [first, second] = useHuntStore.getState().chats[SESSION].items;
    expect(first.kind === "user" && first.messageId).toBeTruthy();
    expect(useHuntStore.getState().chats[SESSION].unseenAfterMessageId).toBe(first.kind === "user" ? first.messageId : null);
    expect(second.kind).toBe("user");

    useHuntStore.getState().markChatSeen(SESSION);
    expect(useHuntStore.getState().chats[SESSION].unseenAfterMessageId).toBeNull();
  });

  it("keeps the unread line of the selected session until another session is selected", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    const afterMessageId = useHuntStore.getState().chats[SESSION].unseenAfterMessageId;

    await useHuntStore.getState().selectSession(SESSION);
    expect(useHuntStore.getState().unreadLine).toEqual({ sessionId: SESSION, afterMessageId });
    await useHuntStore.getState().selectSession(SESSION);
    expect(useHuntStore.getState().unreadLine).toEqual({ sessionId: SESSION, afterMessageId });

    await useHuntStore.getState().selectSession(OTHER);
    expect(useHuntStore.getState().unreadLine).toBeNull();
  });

  it("drops the unread line once the user sends a prompt in its session", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    const afterMessageId = useHuntStore.getState().chats[SESSION].unseenAfterMessageId;
    await useHuntStore.getState().selectSession(SESSION);
    expect(useHuntStore.getState().unreadLine).toEqual({ sessionId: SESSION, afterMessageId });

    await useHuntStore.getState().sendPrompt(SESSION, "go on");
    expect(useHuntStore.getState().unreadLine).toBeNull();
  });

  it("clears the mark another window announced as seen", async () => {
    await useHuntStore.getState().sendPrompt(SESSION, "go");
    useHuntStore.getState().applyChatSeen(SESSION);
    expect(useHuntStore.getState().chats[SESSION].hasUnseenActivity).toBe(false);
  });
});

describe("turns of every window", () => {
  /** The `session_info_update` the backend sends to every window when a turn starts or ends. */
  function turn(state: "running" | "idle") {
    return notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: state } } });
  }

  beforeEach(() => {
    useHuntStore.setState({ chats: {}, sessions: [storedSession(SESSION, "Build it")], creatingIds: [], activeSessionId: SESSION, draft: null });
    vi.mocked(invoke).mockReset();
  });

  it("shows the prompt and the running turn another window sent", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "mache es analog" }, messageId: "m1" }));
    applyUpdate(SESSION, turn("running"));
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isBusy: true, items: [{ kind: "user", text: "mache es analog", messageId: "m1" }] });

    applyUpdate(SESSION, turn("idle"));
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
  });

  it("shows a prompt it sent once and keeps its turn busy until the prompt call returns", async () => {
    let finish: (stopReason: string) => void = () => {};
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "send_prompt") return Promise.resolve(undefined);
      const { messageId } = args as { messageId: string };
      const { applyUpdate } = useHuntStore.getState();
      applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "go" }, messageId }));
      applyUpdate(SESSION, turn("running"));
      return new Promise((resolve) => {
        finish = resolve;
      });
    });

    const send = useHuntStore.getState().sendPrompt(SESSION, "go");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("send_prompt", expect.anything()));
    useHuntStore.getState().applyUpdate(SESSION, turn("idle"));
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isBusy: true, items: [{ kind: "user", text: "go" }] });

    finish("EndTurn");
    await send;
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
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
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("send_prompt", { id: SESSION, text: "two", images: [], messageId: expect.any(String) });

    second.finish("EndTurn");
    await firstSend;
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
  });

  it("generates a diagram apart from the chat: the chat stays idle, a prompt runs meanwhile and a second click waits", async () => {
    const generation = deferredTurn();
    const promptTurn = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(generation.turn).mockReturnValueOnce(promptTurn.turn);
    const commandsCalled = () => vi.mocked(invoke).mock.calls.map(([command]) => command).filter((command) => command !== "get_plan_usage");

    const refresh = useHuntStore.getState().refreshGraph(SESSION, "erd");
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("refresh_graph", { id: SESSION, diagramType: "erd", instructions: "", ...DEFAULT_GRAPH_AGENT });
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ generatingDiagrams: ["erd"], isBusy: false, isHiddenTurn: false });

    await useHuntStore.getState().refreshGraph(SESSION, "erd");
    expect(commandsCalled()).toEqual(["refresh_graph"]);

    const send = useHuntStore.getState().sendPrompt(SESSION, "next");
    expect(commandsCalled()).toEqual(["refresh_graph", "send_prompt"]);
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(true);

    generation.finish("");
    await refresh;
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ generatingDiagrams: [], isBusy: true });

    promptTurn.finish("EndTurn");
    await send;
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(false);
  });

  it("keeps the error of a failed generation for its diagram type until that type is generated again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("failed to generate the diagram: Not logged in");
    await useHuntStore.getState().refreshGraph(SESSION, "dependencies");
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({
      generatingDiagrams: [],
      diagramErrors: { dependencies: "failed to generate the diagram: Not logged in" },
      error: null,
    });

    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await useHuntStore.getState().refreshGraph(SESSION, "dependencies");
    expect(useHuntStore.getState().chats[SESSION].diagramErrors.dependencies).toBeUndefined();
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

  it("keeps the turn busy when the relay reports it idle before the prompt call returns, and sends the queue then", async () => {
    const first = deferredTurn();
    const second = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(first.turn).mockReturnValueOnce(second.turn);

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    useHuntStore.getState().applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "idle" } } }));
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isBusy: true, editVersion: 0 });
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["two"]);

    first.finish("EndTurn");
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("send_prompt", { id: SESSION, text: "two", images: [], messageId: expect.any(String) });
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isBusy: true, queue: [], editVersion: 1 });

    second.finish("EndTurn");
    await firstSend;
    useHuntStore.getState().applyUpdate(SESSION, notification({ sessionUpdate: "session_info_update", _meta: { hunt: { turn: "running" } } }));
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(true);
  });

  it("sends a prompt at once by interrupting the running turn, ahead of the queue", async () => {
    const first = deferredTurn();
    const second = deferredTurn();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "cancel_prompt") {
        first.finish("Cancelled");
        return Promise.resolve(null);
      }
      return vi.mocked(invoke).mock.calls.filter(([name]) => name === "send_prompt").length === 1 ? first.turn : second.turn;
    });

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    useHuntStore.getState().applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working on it" } }));
    await useHuntStore.getState().sendPromptNow(SESSION, "now");
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("send_prompt", { id: SESSION, text: "now", images: [], messageId: expect.any(String) }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("cancel_prompt", { id: SESSION });
    expect(useHuntStore.getState().chats[SESSION].isBusy).toBe(true);
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["two"]);

    second.finish("EndTurn");
    await firstSend;
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("send_prompt", { id: SESSION, text: "two", images: [], messageId: expect.any(String) });
  });

  it("lets a turn the agent has not answered yet go on and sends the prompt after it, ahead of the queue", async () => {
    const first = deferredTurn();
    vi.mocked(invoke).mockImplementation((command) => {
      const isFirstSend = command === "send_prompt" && vi.mocked(invoke).mock.calls.filter(([name]) => name === "send_prompt").length === 1;
      return isFirstSend ? first.turn : Promise.resolve("EndTurn");
    });

    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    await useHuntStore.getState().sendPromptNow(SESSION, "now");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("cancel_prompt", { id: SESSION });
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["now", "two"]);

    first.finish("EndTurn");
    await firstSend;
    const sentTexts = vi.mocked(invoke).mock.calls.filter(([name]) => name === "send_prompt").map(([, args]) => (args as { text: string }).text);
    expect(sentTexts).toEqual(["one", "now", "two"]);
  });

  it("sends a prompt at once like any other while no turn runs", async () => {
    vi.mocked(invoke).mockResolvedValue("EndTurn");
    await useHuntStore.getState().sendPromptNow(SESSION, "now");
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("send_prompt", { id: SESSION, text: "now", images: [], messageId: expect.any(String) });
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isBusy: false, queue: [] });
  });

  it("queues a prompt sent while the agent starts and sends it once the agent runs", async () => {
    const stopped = { ...storedSession(SESSION, "Build it"), isLive: false };
    useHuntStore.setState({ sessions: [stopped] });
    let finishStart: (session: SessionView) => void = () => {};
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") {
        return new Promise<SessionView>((resolve) => {
          finishStart = resolve;
        });
      }
      if (command === "list_sessions") return Promise.resolve([{ ...stopped, isLive: true }]);
      if (command === "send_prompt") return Promise.resolve("end_turn");
      return Promise.resolve(command === "session_history" ? [] : undefined);
    });

    const resume = useHuntStore.getState().resumeSession(SESSION);
    expect(useHuntStore.getState().chats[SESSION].isLoading).toBe(true);
    await useHuntStore.getState().sendPrompt(SESSION, "while starting");
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["while starting"]);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("send_prompt", expect.anything());

    finishStart({ ...stopped, isLive: true });
    await resume;
    expect(useHuntStore.getState().chats[SESSION]).toMatchObject({ isLoading: false, queue: [] });
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("send_prompt", { id: SESSION, text: "while starting", images: [], messageId: expect.any(String) }));
    expect(useHuntStore.getState().chats[SESSION].items.map((item) => item.kind)).toEqual(["user"]);
  });

  it("queues a prompt sent while the session is created and sends it once the agent runs", async () => {
    let finishCreation: (session: SessionView) => void = () => {};
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "create_session") {
        return new Promise<SessionView>((resolve) => {
          finishCreation = resolve;
        });
      }
      if (command === "send_prompt") return Promise.resolve("end_turn");
      if (command === "list_sessions") return Promise.resolve(useHuntStore.getState().sessions);
      return Promise.resolve(undefined);
    });
    const creation = useHuntStore.getState().createSession(TARGET, "Build it", { setup: { configValues: {}, modeId: "default" }, prompt: null });
    const id = useHuntStore.getState().creatingIds[0];

    await useHuntStore.getState().sendPrompt(id, "while creating");
    expect(useHuntStore.getState().chats[id].queue.map((prompt) => prompt.text)).toEqual(["while creating"]);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("send_prompt", expect.anything());

    finishCreation(storedSession(id, "Build it"));
    await creation;
    await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("send_prompt", { id, text: "while creating", images: [], messageId: expect.any(String) }));
    expect(useHuntStore.getState().chats[id].queue).toEqual([]);
  });

  it("starts a stopped local session before sending the prompt and names an untitled one after it", async () => {
    const stopped = { ...storedSession(SESSION, "repo"), isLive: false };
    useHuntStore.setState({ sessions: [stopped], untitledIds: [SESSION] });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "open_session") return Promise.resolve({ ...stopped, isLive: true });
      if (command === "list_sessions") return Promise.resolve([{ ...stopped, isLive: true }]);
      if (command === "send_prompt") return Promise.resolve("end_turn");
      if (command === "rename_session") return Promise.resolve({ ...stopped, isLive: true, title: "Fix the build" });
      return Promise.resolve(command === "session_history" ? [] : undefined);
    });

    await useHuntStore.getState().sendPrompt(SESSION, "Fix the build");

    const calls = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(calls.indexOf("send_prompt")).toBeGreaterThan(calls.indexOf("open_session"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("rename_session", expect.objectContaining({ id: SESSION }));
    expect(useHuntStore.getState().untitledIds).toEqual([]);
  });

  it("hands the queue over and takes single prompts out", async () => {
    const first = deferredTurn();
    vi.mocked(invoke).mockReturnValueOnce(first.turn);
    const firstSend = useHuntStore.getState().sendPrompt(SESSION, "one");
    await useHuntStore.getState().sendPrompt(SESSION, "two");
    await useHuntStore.getState().sendPrompt(SESSION, "three");

    const [two] = useHuntStore.getState().chats[SESSION].queue;
    useHuntStore.getState().unqueuePrompt(SESSION, two.id);
    expect(useHuntStore.getState().chats[SESSION].queue.map((prompt) => prompt.text)).toEqual(["three"]);

    expect(useHuntStore.getState().takeQueue(SESSION).map((prompt) => prompt.text)).toEqual(["three"]);
    expect(useHuntStore.getState().chats[SESSION].queue).toEqual([]);
    expect(useHuntStore.getState().takeQueue(SESSION)).toEqual([]);
    first.finish("EndTurn");
    await firstSend;
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

describe("prompt draft", () => {
  const OTHER = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    useHuntStore.setState({ chats: { [SESSION]: createEmptyChat(), [OTHER]: createEmptyChat() }, promptDrafts: {}, sessions: [] });
  });

  it("keeps the draft of every session apart and forgets one that was emptied", () => {
    const { setPromptDraft } = useHuntStore.getState();
    setPromptDraft(SESSION, { text: "what about", images: [] });
    setPromptDraft(OTHER, { text: "/clear", images: [] });
    expect(useHuntStore.getState().promptDrafts).toEqual({ [SESSION]: { text: "what about", images: [] }, [OTHER]: { text: "/clear", images: [] } });

    setPromptDraft(SESSION, { text: "", images: [] });
    expect(useHuntStore.getState().promptDrafts).toEqual({ [OTHER]: { text: "/clear", images: [] } });
  });

  it("leaves the state alone for a draft that did not change or is empty like the missing one", () => {
    const { setPromptDraft } = useHuntStore.getState();
    const before = useHuntStore.getState();
    setPromptDraft(SESSION, { text: "", images: [] });
    expect(useHuntStore.getState()).toBe(before);

    const images = [{ path: "/tmp/one.png", name: "one.png", width: 1, height: 1 }] as unknown as Screenshot[];
    setPromptDraft(SESSION, { text: "look", images });
    const stored = useHuntStore.getState();
    setPromptDraft(SESSION, { text: "look", images });
    expect(useHuntStore.getState()).toBe(stored);
  });

  it("drops the draft together with the chat when the session is closed", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
    useHuntStore.getState().setPromptDraft(SESSION, { text: "unsent", images: [] });
    await useHuntStore.getState().closeSession(SESSION, "stop");
    expect(useHuntStore.getState().promptDrafts[SESSION]).toBeUndefined();
    expect(useHuntStore.getState().chats[SESSION]).toBeUndefined();
  });
});
