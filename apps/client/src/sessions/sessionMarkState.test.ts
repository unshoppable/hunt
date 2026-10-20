import { describe, expect, it } from "vitest";
import type { RemoteTarget, SessionView } from "../ipc/types";
import { createEmptyChat, type SessionChat } from "../state/store";
import { sessionMarkState } from "./sessionMarkState";

const question = { kind: "agent" as const, id: "a1", text: "Shall I push?", images: [] };
const answer = { kind: "agent" as const, id: "a2", text: "Pushed.", images: [] };

function session(remote: Partial<RemoteTarget> | null, isLive = false): SessionView {
  return { id: "s1", isLive, remote: remote ? ({ agent: "", relayActivity: null, ...remote } as RemoteTarget) : null } as SessionView;
}

function chat(overrides: Partial<SessionChat> = {}): SessionChat {
  return { ...createEmptyChat(), ...overrides };
}

describe("sessionMarkState", () => {
  it("takes a local session's state from its chat", () => {
    expect(sessionMarkState(session(null, true), chat({ items: [question] }))).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session(null, true), chat({ isBusy: true }))).toEqual({ isBusy: true, hasQuestion: false });
    expect(sessionMarkState(session(null), undefined)).toEqual({ isBusy: false, hasQuestion: false });
  });

  it("takes a connected remote session's state from its loaded chat, not from the relay's report", () => {
    const remote = { relayActivity: { isTurnRunning: true, isQuestion: false } };
    expect(sessionMarkState(session(remote, true), chat({ items: [question] }))).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session(remote, true), chat({ isLoading: true }))).toEqual({ isBusy: true, hasQuestion: false });
    expect(sessionMarkState(session(remote, true), chat({ items: [question], isStale: true }))).toEqual({ isBusy: true, hasQuestion: false });
  });

  it("takes an unconnected remote session's state from the relay's report, also over the chat of an earlier connect", () => {
    const asking = { relayActivity: { isTurnRunning: false, isQuestion: true } };
    expect(sessionMarkState(session(asking), undefined)).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session(asking), chat({ items: [answer] }))).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session({ relayActivity: { isTurnRunning: true, isQuestion: false } }), chat({ items: [question] }))).toEqual({
      isBusy: true,
      hasQuestion: false,
    });
  });

  it("lets the chat stand in for a relay too old to report questions", () => {
    const oldRelay = { relayActivity: { isTurnRunning: false, isQuestion: null } };
    expect(sessionMarkState(session(oldRelay), chat({ items: [question] }))).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session(oldRelay), undefined)).toEqual({ isBusy: false, hasQuestion: false });
  });

  it("counts the gateway's question of an swf agent, but not while its turn runs", () => {
    expect(sessionMarkState(session({ agent: "question", relayActivity: { isTurnRunning: false, isQuestion: false } }), undefined).hasQuestion).toBe(true);
    expect(sessionMarkState(session({ agent: "question", relayActivity: { isTurnRunning: true, isQuestion: false } }), undefined)).toEqual({
      isBusy: true,
      hasQuestion: false,
    });
  });

  it("falls back to the chat of an earlier connect, else to the agent state the gateway recorded", () => {
    expect(sessionMarkState(session({ agent: "running" }), chat({ items: [question] }))).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session({ agent: "running" }), undefined)).toEqual({ isBusy: true, hasQuestion: false });
    expect(sessionMarkState(session({ agent: "question" }), chat())).toEqual({ isBusy: false, hasQuestion: true });
    expect(sessionMarkState(session({ agent: "" }), undefined)).toEqual({ isBusy: false, hasQuestion: false });
  });
});
