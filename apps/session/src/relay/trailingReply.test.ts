import { describe, expect, it } from "vitest";
import { notificationMessage, type JsonRpcNotification } from "../../../../libs/domain/src/jsonRpc.ts";
import { TrailingReply } from "./trailingReply.ts";

function entry(update: Record<string, unknown>): JsonRpcNotification {
  return notificationMessage("session/update", { sessionId: "acp-1", update });
}

const agent = (text: string) => entry({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const user = (text: string, meta?: Record<string, unknown>) => entry({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: meta });
const HIDDEN = { hunt: { hidden: true } };

/** Whether `history`, taken in at once, ends with a question. */
function asksQuestion(history: JsonRpcNotification[]): boolean {
  const reply = new TrailingReply();
  reply.follow(history);
  return reply.asksQuestion();
}

describe("TrailingReply", () => {
  it("joins the agent's chunks in a row into one reply and asks by question mark or marker", () => {
    expect(asksQuestion([user("fix it"), agent("Done. Shall I "), agent("push?")])).toBe(true);
    expect(asksQuestion([user("fix it"), agent("Pick A or B.\n<!-- hunt:question -->")])).toBe(true);
    expect(asksQuestion([user("fix it"), agent("Pushed.")])).toBe(false);
    expect(asksQuestion([])).toBe(false);
  });

  it("ends the reply with a thought, a tool call, a tool call an update names first or a typed user message", () => {
    const question = agent("Shall I push?");
    expect(asksQuestion([question, entry({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } })])).toBe(false);
    expect(asksQuestion([question, entry({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" })])).toBe(false);
    expect(asksQuestion([question, entry({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" })])).toBe(false);
    expect(asksQuestion([question, user("yes")])).toBe(false);
  });

  it("keeps the reply across updates of a known tool call, a plan and a prompt's attached file", () => {
    const toolCall = entry({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" });
    const toolUpdate = entry({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    const plan = entry({ sessionUpdate: "plan", entries: [] });
    const file = entry({ sessionUpdate: "user_message_chunk", content: { type: "resource", resource: { uri: "file:///a", text: "x" } } });
    expect(asksQuestion([toolCall, agent("Shall I push?"), toolUpdate, plan, file])).toBe(true);
  });

  it("leaves a turn Hunt sent itself out until the next user message", () => {
    const refresh = [user("draw the diagram", HIDDEN), entry({ sessionUpdate: "tool_call", toolCallId: "t9", title: "Write" }), agent("Diagram written.")];
    expect(asksQuestion([user("fix it"), agent("Shall I push?"), ...refresh])).toBe(true);
    expect(asksQuestion([user("fix it"), agent("Shall I push?"), user("refresh", { harness: { hidden: true } }), agent("Done.")])).toBe(true);
    expect(asksQuestion([agent("Shall I push?"), ...refresh, user("go on"), agent("Pushed.")])).toBe(false);
  });

  it("takes in only what the history gained since the last call", () => {
    const history = [user("fix it"), agent("Shall I push?")];
    const reply = new TrailingReply();
    reply.follow(history);
    expect(reply.asksQuestion()).toBe(true);

    history.push(user("yes"));
    reply.follow(history);
    expect(reply.asksQuestion()).toBe(false);

    history.push(agent("Pushed. Anything else?"));
    reply.follow(history);
    expect(reply.asksQuestion()).toBe(true);
  });
});
