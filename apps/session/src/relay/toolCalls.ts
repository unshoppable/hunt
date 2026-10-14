/**
 * One journal line per tool call the agent finishes: the tool, its status and duration, for a command its exit code and
 * the number of output lines, and its title, which for Bash is the whole command. The output itself stays out of the
 * journal: it can be long and hold secrets the command printed.
 */
import { isRecord } from "../../../../libs/domain/src/jsonRpc.ts";

/** Longer titles, such as a command with a heredoc that writes a file, are cut to this many characters. */
const MAX_TITLE_LENGTH = 4_000;
const OPEN_STATUSES = new Set(["pending", "in_progress"]);

interface OpenToolCall {
  name: string | null;
  title: string | null;
  startedAt: number;
  /** The terminal output of a command so far; `null` for other tools. */
  output: string | null;
  exitCode: number | null;
}

/** Follows the tool calls of `session/update`s by their ID until they finish. */
export class ToolCallLog {
  private readonly open = new Map<string, OpenToolCall>();

  /** Takes a `tool_call` or `tool_call_update`; returns the line to log when the update finishes the call, else null. */
  record(update: Record<string, unknown>, now: number): string | null {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
    const id = update.toolCallId;
    if (typeof id !== "string") return null;
    const call = this.open.get(id) ?? { name: null, title: null, startedAt: now, output: null, exitCode: null };
    this.open.set(id, call);
    absorb(call, update);
    if (typeof update.status !== "string" || OPEN_STATUSES.has(update.status)) return null;
    this.open.delete(id);
    return describe(call, update.status, now);
  }
}

function absorb(call: OpenToolCall, update: Record<string, unknown>): void {
  const meta = isRecord(update._meta) ? update._meta : {};
  const claudeCode = isRecord(meta.claudeCode) ? meta.claudeCode : {};
  const name = typeof update.name === "string" ? update.name : claudeCode.toolName;
  if (typeof name === "string" && name) {
    call.name = name;
  }
  if (typeof update.title === "string" && update.title) {
    call.title = update.title;
  }
  const output = meta.terminal_output_delta ?? meta.terminal_output;
  if (isRecord(output) && typeof output.data === "string") {
    call.output = (call.output ?? "") + output.data;
  }
  const exit = meta.terminal_exit;
  if (isRecord(exit) && typeof exit.exit_code === "number") {
    call.exitCode = exit.exit_code;
  }
}

function describe(call: OpenToolCall, status: string, now: number): string {
  const facts = [`${status} in ${now - call.startedAt} ms`];
  if (call.exitCode !== null) {
    facts.push(`exit code ${call.exitCode}`);
  }
  if (call.output !== null) {
    facts.push(`${lineCount(call.output)} output lines`);
  }
  const name = call.name ?? "unknown";
  const title = call.title && call.title !== name ? `: ${oneLine(call.title)}` : "";
  return `tool ${name} ${facts.join(", ")}${title}`;
}

function lineCount(text: string): number {
  const trimmed = text.trimEnd();
  return trimmed ? trimmed.split("\n").length : 0;
}

/** The title on one journal line: newlines escaped, cut to `MAX_TITLE_LENGTH`. */
function oneLine(title: string): string {
  const escaped = title.replaceAll("\r", "").replaceAll("\n", "\\n");
  if (escaped.length <= MAX_TITLE_LENGTH) return escaped;
  return `${escaped.slice(0, MAX_TITLE_LENGTH)}… (${escaped.length - MAX_TITLE_LENGTH} more characters)`;
}
