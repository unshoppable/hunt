import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useHuntStore } from "../sessions/hunt.store";
import { SESSION, notification } from "../sessions/hunt.store.fixtures";

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

  it("takes a message's transcript time from its chunk or, for a live message, from the times its turn's end announces", () => {
    const { applyUpdate, applyMessageTimes } = useHuntStore.getState();
    const replayed = { messageId: "u1", _meta: { hunt: { at: "2026-10-20T06:22:44.000Z" } } };
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix it" }, ...replayed }));
    applyUpdate(SESSION, notification({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixed." }, messageId: "msg_1" }));
    expect(useHuntStore.getState().chats[SESSION].items).toMatchObject([{ at: "2026-10-20T06:22:44.000Z" }, { messageId: "msg_1", at: undefined }]);

    applyMessageTimes({ huntSessionId: SESSION, times: { msg_1: "2026-10-20T06:23:01.000Z", other: "2026-10-20T06:24:00.000Z" } });
    expect(useHuntStore.getState().chats[SESSION].items).toMatchObject([{ at: "2026-10-20T06:22:44.000Z" }, { at: "2026-10-20T06:23:01.000Z" }]);
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

  it("leaves the attached file's link and context block out of a replayed user turn", () => {
    const { applyUpdate } = useHuntStore.getState();
    const uri = "file:///repo/.ci/common/init-backend.sh";
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `[@init-backend.sh](${uri})` } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Why these changes?" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: `\n<context ref="${uri}">\n#!/usr/bin/env bash\n</context>` } }));

    const items = useHuntStore.getState().chats[SESSION].items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "Why these changes?" });
  });

  it("keeps a file link the user typed when no context block of that file follows", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "[@a.ts](file:///repo/a.ts) breaks" } }));
    applyUpdate(SESSION, notification({ sessionUpdate: "user_message_chunk", content: { type: "text", text: '\n<context ref="file:///repo/b.ts">\nlet b;\n</context>' } }));

    expect(useHuntStore.getState().chats[SESSION].items[0]).toMatchObject({ kind: "user", text: "[@a.ts](file:///repo/a.ts) breaks" });
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

  it("keeps a failed command's output and appends its exit code from the later exit update", () => {
    const { applyUpdate } = useHuntStore.getState();
    applyUpdate(SESSION, notification({ sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "Terminal", kind: "execute", status: "pending" }));
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      _meta: { terminal_output: { terminal_id: "toolu_1", data: "psql: connection refused" } },
    }));
    applyUpdate(SESSION, notification({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_1",
      status: "failed",
      _meta: { claudeCode: { toolName: "Bash" }, terminal_exit: { terminal_id: "toolu_1", exit_code: 1, signal: null } },
    }));

    const item = useHuntStore.getState().chats[SESSION].items[0];
    if (item.kind !== "tool") throw new Error("expected tool item");
    expect(item.toolCall).toMatchObject({ status: "failed", terminalOutput: "psql: connection refused\n[exit code 1]" });
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
