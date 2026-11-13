import { describe, expect, it } from "vitest";
import type { SessionView } from "./session.types";
import { createEmptyChat } from "../chat/chat-reducer.utils";
import type { SessionChat } from "../chat/chat.store-slice";
import { notifiedState, statusNotification, type NotifiedState } from "./session-notification.utils";

const session = { id: "s1", isLive: true, remote: null } as SessionView;

function chat(overrides: Partial<SessionChat> = {}): SessionChat {
  return { ...createEmptyChat(), ...overrides };
}

function state(overrides: Partial<NotifiedState> = {}): NotifiedState {
  return { isBusy: false, hasQuestion: false, permission: null, error: null, ...overrides };
}

describe("notifiedState", () => {
  it("is unknown while the chat loads", () => {
    expect(notifiedState(session, chat({ isLoading: true }), null)).toBeNull();
  });

  it("carries the mark state, the pending permission and the error", () => {
    const permission = { requestId: "r1", sessionId: "a1", toolCall: { toolCallId: "t1", title: "npm test" }, options: [] };
    expect(notifiedState(session, chat({ isBusy: true, permission }), null)).toEqual(state({ isBusy: true, permission: { requestId: "r1", title: "npm test" } }));
    expect(notifiedState(session, chat({ error: "agent exited" }), null)).toEqual(state({ error: "agent exited" }));
    expect(notifiedState(session, undefined, null)).toEqual(state());
  });
});

describe("statusNotification", () => {
  it("stays silent for a session seen for the first time and while nothing ends", () => {
    expect(statusNotification("Fix login", undefined, state())).toBeNull();
    expect(statusNotification("Fix login", state(), state())).toBeNull();
    expect(statusNotification("Fix login", state(), state({ isBusy: true }))).toBeNull();
    expect(statusNotification("Fix login", state({ isBusy: true }), state({ isBusy: true }))).toBeNull();
  });

  it("tells how a turn ended", () => {
    const busy = state({ isBusy: true });
    expect(statusNotification("Fix login", busy, state())).toEqual({ title: "Fix login", body: "Finished its turn" });
    expect(statusNotification("Fix login", busy, state({ hasQuestion: true }))).toEqual({ title: "Fix login", body: "Waiting for your answer" });
    expect(statusNotification("Fix login", busy, state({ error: "agent exited" }))).toEqual({ title: "Fix login", body: "Failed: agent exited" });
  });

  it("tells a new permission request once", () => {
    const asking = state({ isBusy: true, permission: { requestId: "r1", title: "npm test" } });
    expect(statusNotification("Fix login", state({ isBusy: true }), asking)).toEqual({ title: "Fix login", body: "Asks for permission: npm test" });
    expect(statusNotification("Fix login", asking, asking)).toBeNull();
    expect(statusNotification("Fix login", asking, state({ isBusy: true, permission: { requestId: "r2", title: null } }))).toEqual({
      title: "Fix login",
      body: "Asks for permission",
    });
    expect(statusNotification("Fix login", asking, state({ isBusy: true }))).toBeNull();
  });
});
