import { describe, expect, it } from "vitest";
import { SubagentSessions } from "./subagent-sessions.domain.ts";

const ROOT = "acp-1";

function spawned(subagentSessionId: unknown): Record<string, unknown> {
  return { sessionUpdate: "subagent_spawned", subagentSessionId, name: "Count files", task: "Count files", capabilities: {} };
}

describe("SubagentSessions", () => {
  it("owns the root session and the children announced on it, nested ones included", () => {
    const sessions = SubagentSessions.of(ROOT);
    expect(sessions.owns(ROOT)).toBe(true);
    expect(sessions.isChild(ROOT)).toBe(false);
    expect(sessions.owns("a84ac2fc8a50f5d9a")).toBe(false);

    sessions.observe(ROOT, spawned("a84ac2fc8a50f5d9a"));
    sessions.observe("a84ac2fc8a50f5d9a", spawned("b1"));
    sessions.observe("a84ac2fc8a50f5d9a", spawned("a84ac2fc8a50f5d9a:generation:2"));
    sessions.observe(ROOT, spawned(`${ROOT}:replay-subagent:toolu_1`));

    for (const child of ["a84ac2fc8a50f5d9a", "b1", "a84ac2fc8a50f5d9a:generation:2", `${ROOT}:replay-subagent:toolu_1`]) {
      expect(sessions.isChild(child)).toBe(true);
      expect(sessions.owns(child)).toBe(true);
    }
  });

  it("ignores a spawn on a foreign session, other updates and a spawn without a child ID", () => {
    const sessions = SubagentSessions.of(ROOT);

    sessions.observe("acp-other", spawned("c1"));
    sessions.observe(ROOT, { sessionUpdate: "subagent_state_update", subagentSessionId: "c2", state: "completed" });
    sessions.observe(ROOT, spawned(""));
    sessions.observe(ROOT, spawned(7));
    sessions.observe(ROOT, spawned(ROOT));

    expect([...sessions.childSessionIds]).toEqual([]);
  });

  it("keeps a child owned after it ended", () => {
    const sessions = SubagentSessions.of(ROOT);
    sessions.observe(ROOT, spawned("c1"));

    sessions.observe(ROOT, { sessionUpdate: "subagent_state_update", subagentSessionId: "c1", state: "completed" });

    expect(sessions.owns("c1")).toBe(true);
  });
});
