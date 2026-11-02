import { describe, expect, it } from "vitest";
import type { ChatItem, ToolCallView } from "../chat.types";
import { summarizeActivity } from "./activity-summary.utils";

const BASE = "/work/tree";

function tool(id: string, toolCall: Partial<ToolCallView>): ChatItem {
  return { kind: "tool", id, toolCall: { toolCallId: id, title: "Terminal", kind: "execute", status: "completed", content: [], locations: [], ...toolCall } };
}

function edit(id: string, path: string, status: ToolCallView["status"] = "completed"): ChatItem {
  return tool(id, { title: `Edit ${path}`, kind: "edit", status, content: [{ type: "diff", path, oldText: "a", newText: "b" }], locations: [{ path }] });
}

describe("summarizeActivity", () => {
  it("counts tool calls and thoughts", () => {
    const thought: ChatItem = { kind: "thought", id: "t", text: "hm" };
    expect(summarizeActivity([tool("1", {}), thought, tool("2", {})], BASE)).toMatchObject({ label: "2 tool calls, 1 thought", status: "completed" });
    expect(summarizeActivity([tool("1", {})], BASE).label).toBe("1 tool call");
  });

  it("reports a running tool before a failed one", () => {
    expect(summarizeActivity([tool("1", { status: "in_progress" }), tool("2", { status: "failed" })], BASE).status).toBe("in_progress");
    expect(summarizeActivity([tool("1", {}), tool("2", { status: "failed" })], BASE).status).toBe("failed");
  });

  it("lists each written or edited file once, repo-relative, leaving out edits that did not complete", () => {
    const write = tool("w", { title: "Write /work/tree/b.ts", kind: "edit", locations: [{ path: `${BASE}/b.ts` }] });
    const items = [edit("1", `${BASE}/a.ts`), tool("r", { kind: "read", locations: [{ path: `${BASE}/c.ts` }] }), write, edit("2", `${BASE}/a.ts`), edit("3", `${BASE}/d.ts`, "failed")];
    expect(summarizeActivity(items, BASE).files).toEqual(["a.ts", "b.ts"]);
  });
});
