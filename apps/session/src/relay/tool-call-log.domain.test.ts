import { describe, expect, it } from "vitest";
import { ToolCallLog } from "./tool-call-log.domain.ts";

describe("ToolCallLog", () => {
  it("logs a finished command with its duration, exit code, output lines and the whole command", () => {
    const log = ToolCallLog.start();

    expect(log.record({ sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash", title: "Terminal", status: "pending" }, 1_000)).toBeNull();
    expect(log.record({ sessionUpdate: "tool_call_update", toolCallId: "t1", title: "git status --short && git log -1" }, 1_010)).toBeNull();
    const output = { _meta: { terminal_output: { terminal_id: "t1", data: "M a.ts\nM b.ts\n" } } };
    expect(log.record({ sessionUpdate: "tool_call_update", toolCallId: "t1", ...output }, 1_200)).toBeNull();
    const exit = { _meta: { claudeCode: { toolName: "Bash" }, terminal_exit: { terminal_id: "t1", exit_code: 0, signal: null } } };
    const line = log.record({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", ...exit }, 1_234);

    expect(line).toBe("tool Bash completed in 234 ms, exit code 0, 2 output lines: git status --short && git log -1");
  });

  it("logs another tool with its title only, taking the name from the claudeCode meta", () => {
    const log = ToolCallLog.start();
    log.record({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Read apps/a.ts", status: "pending" }, 0);

    const line = log.record({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed", _meta: { claudeCode: { toolName: "Read" } } }, 5);

    expect(line).toBe("tool Read failed in 5 ms: Read apps/a.ts");
    expect(log.record({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" }, 6)).toBe("tool unknown failed in 0 ms");
  });

  it("puts a multi-line command on one line and cuts a very long one", () => {
    const log = ToolCallLog.start();
    const command = `cat > big.txt <<'EOF'\n${"x".repeat(5_000)}\nEOF`;

    const line = log.record({ sessionUpdate: "tool_call", toolCallId: "t3", name: "Bash", title: command, status: "completed" }, 0);

    expect(line).toMatch(/^tool Bash completed in 0 ms: cat > big\.txt <<'EOF'\\nxxx/);
    expect(line).toMatch(/xxx… \(1028 more characters\)$/);
    expect(line).not.toContain("\n");
  });

  it("ignores other updates and updates without a tool call ID", () => {
    const log = ToolCallLog.start();

    expect(log.record({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, 0)).toBeNull();
    expect(log.record({ sessionUpdate: "tool_call", title: "Read", status: "completed" }, 0)).toBeNull();
  });

  it("follows a call until it finishes and then forgets it", () => {
    const log = ToolCallLog.start();
    log.record({ sessionUpdate: "tool_call", toolCallId: "t4", name: "Bash", status: "pending" }, 0);
    log.record({ sessionUpdate: "tool_call", toolCallId: "t5", name: "Read", status: "pending" }, 0);

    expect([...log.openCalls.keys()]).toEqual(["t4", "t5"]);
    expect(log.record({ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed" }, 10)).toBe("tool Bash completed in 10 ms");
    expect([...log.openCalls.keys()]).toEqual(["t5"]);
    expect(log.record({ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed" }, 20)).toBe("tool unknown completed in 0 ms");
  });

  it("rejects a construction with an open call whose start is no time", () => {
    const openCalls = new Map([["t1", { name: "Bash", title: null, startedAt: Number.NaN, output: null, exitCode: null }]]);

    expect(() => new ToolCallLog({ openCalls })).toThrow();
  });
});
