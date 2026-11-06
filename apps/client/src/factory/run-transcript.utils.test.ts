import { describe, expect, it } from "vitest";
import { runConversation } from "./run-transcript.utils";

const CWD = "/home/agent/app";

function jsonl(...entries: object[]): string {
  return entries.map((entry) => JSON.stringify({ cwd: CWD, ...entry })).join("\n");
}

function user(uuid: string, content: unknown, extra: object = {}) {
  return { type: "user", uuid, message: { role: "user", content }, ...extra };
}

function assistant(uuid: string, content: unknown[]) {
  return { type: "assistant", uuid, message: { role: "assistant", content } };
}

describe("runConversation", () => {
  it("lists the prompt, the thoughts and the replies in order, with the worktree of the run", () => {
    const conversation = runConversation(
      jsonl(
        user("u1", "Plan the issue."),
        assistant("a1", [{ type: "thinking", thinking: "The issue asks for X.", signature: "s" }]),
        assistant("a2", [{ type: "text", text: "Here is the plan." }]),
      ),
    );
    expect(conversation.cwd).toBe(CWD);
    expect(conversation.items).toEqual([
      { kind: "user", id: "u1", text: "Plan the issue.", images: [] },
      { kind: "thought", id: "a1:0", text: "The issue asks for X." },
      { kind: "agent", id: "a2:0", text: "Here is the plan.", images: [] },
    ]);
  });

  it("leaves out empty thoughts, Claude Code's own messages, subagents' messages and lines that are not JSON", () => {
    const conversation = runConversation(
      [
        jsonl(user("u1", "<system-reminder>x</system-reminder>", { isMeta: true })),
        "not json",
        jsonl(
          assistant("a1", [{ type: "thinking", thinking: "", signature: "s" }]),
          { ...assistant("a2", [{ type: "text", text: "inside a subagent" }]), isSidechain: true },
          { type: "summary", summary: "x" },
        ),
      ].join("\n"),
    );
    expect(conversation.items).toEqual([]);
  });

  it("gives a tool call the form of the live chat and completes it with its result", () => {
    const { items } = runConversation(
      jsonl(
        assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }]),
        user("u1", [{ type: "tool_result", tool_use_id: "t1", content: "2 passed" }]),
        assistant("a2", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: `${CWD}/src/a.ts` } }]),
        user("u2", [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "1\tconst a = 1;" }], is_error: true }]),
      ),
    );
    expect(items.map((item) => (item.kind === "tool" ? [item.toolCall.kind, item.toolCall.title, item.toolCall.status] : item.kind))).toEqual([
      ["execute", "npm test", "completed"],
      ["read", `Read ${CWD}/src/a.ts`, "failed"],
    ]);
    const read = items[1];
    expect(read?.kind === "tool" && read.toolCall.locations).toEqual([{ path: `${CWD}/src/a.ts` }]);
    const bash = items[0];
    expect(bash?.kind === "tool" && bash.toolCall.content).toEqual([{ type: "content", content: { type: "text", text: "2 passed" } }]);
  });

  it("shows an edit as its diff and keeps a call without a result pending", () => {
    const { items } = runConversation(
      jsonl(
        assistant("a1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: `${CWD}/a.ts`, old_string: "a", new_string: "b" } }]),
        assistant("a2", [{ type: "tool_use", id: "t2", name: "mcp__playwright__browser_click", input: {} }]),
      ),
    );
    const [edit, click] = items;
    expect(edit?.kind === "tool" && edit.toolCall).toMatchObject({
      kind: "edit",
      title: `Edit ${CWD}/a.ts`,
      status: "pending",
      content: [{ type: "diff", path: `${CWD}/a.ts`, oldText: "a", newText: "b" }],
    });
    expect(click?.kind === "tool" && click.toolCall).toMatchObject({ kind: "other", title: "mcp__playwright__browser_click", status: "pending" });
  });
});
