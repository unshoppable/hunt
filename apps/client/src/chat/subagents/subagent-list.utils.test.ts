import { describe, expect, it } from "vitest";
import type { SubagentChat } from "../chat.types";
import { formatDuration, listSubagents, steppedAgent, subagentName } from "./subagent-list.utils";

function subagent(sessionId: string, parentSessionId = "root", change: Partial<SubagentChat> = {}): SubagentChat {
  return { sessionId, parentSessionId, title: sessionId, description: "", state: "running", items: [], plan: [], usage: null, isHidden: false, ...change };
}

describe("listSubagents", () => {
  it("lists every subagent after the agent that started it, in the order they started", () => {
    const subagents = { a: subagent("a"), b: subagent("b"), a1: subagent("a1", "a"), a1x: subagent("a1x", "a1") };
    expect(listSubagents(subagents).map(({ subagent, depth }) => [subagent.sessionId, depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a1x", 2],
      ["b", 0],
    ]);
  });

  it("leaves out the subagents of a turn Hunt sent itself", () => {
    expect(listSubagents({ a: subagent("a", "root", { isHidden: true }), b: subagent("b") }).map(({ subagent }) => subagent.sessionId)).toEqual(["b"]);
  });
});

describe("steppedAgent", () => {
  const listed = listSubagents({ a: subagent("a"), b: subagent("b") });

  it("steps through the main agent and the subagents, wrapping around", () => {
    expect(steppedAgent(listed, null, 1)).toBe("a");
    expect(steppedAgent(listed, "b", 1)).toBeNull();
    expect(steppedAgent(listed, null, -1)).toBe("b");
  });

  it("starts from the main agent when the selected subagent is gone", () => {
    expect(steppedAgent(listed, "gone", 1)).toBe("a");
  });
});

describe("subagentName", () => {
  it("falls back to the first line of the task", () => {
    expect(subagentName(subagent("a", "root", { title: "", description: "Count files\nthen report" }))).toBe("Count files");
  });
});

describe("formatDuration", () => {
  it("shows seconds, and minutes from one minute on", () => {
    expect(formatDuration(4421)).toBe("4s");
    expect(formatDuration(185_000)).toBe("3m 05s");
  });
});
