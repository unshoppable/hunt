/**
 * One journal line per tool call the agent finishes: the tool, its status and duration, for a command its exit code and
 * the number of output lines, and its title, which for Bash is the whole command. The output itself stays out of the
 * journal: it can be long and hold secrets the command printed.
 */
import * as z from "zod/mini";
import { DomainModel } from "../../../../libs/domain/src/model/domain.model.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";

/** Longer titles, such as a command with a heredoc that writes a file, are cut to this many characters. */
const MAX_TITLE_LENGTH = 4_000;
const OPEN_STATUSES = new Set(["pending", "in_progress"]);

const ZodOpenToolCall = z.object({
  name: z.nullable(z.string()),
  title: z.nullable(z.string()),
  startedAt: z.number(),
  /** The terminal output of a command so far; null for other tools. */
  output: z.nullable(z.string()),
  exitCode: z.nullable(z.number()),
});

type OpenToolCall = z.infer<typeof ZodOpenToolCall>;

const ZodToolCallLogState = z.object({
  /** The tool calls that have not finished yet, by their ID. */
  openCalls: z.map(z.string(), ZodOpenToolCall),
});

export interface ToolCallLog extends z.infer<typeof ZodToolCallLogState> {}

/** Follows the tool calls of `session/update`s by their ID until they finish. */
export class ToolCallLog extends DomainModel<typeof ZodToolCallLogState> {
  static readonly schema = ZodToolCallLogState;

  constructor(value: z.input<typeof ZodToolCallLogState>) {
    super(value);
  }

  /** A log that follows no tool call yet. */
  static start(): ToolCallLog {
    return new ToolCallLog({ openCalls: new Map() });
  }

  /** Takes a `tool_call` or `tool_call_update`; returns the line to log when the update finishes the call, else null. */
  record(update: Record<string, unknown>, now: number): string | null {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
    const id = update.toolCallId;
    if (typeof id !== "string") return null;
    const call = this.absorb(id, update, now);
    const status = typeof update.status === "string" ? update.status : null;
    const isFinished = status !== null && !OPEN_STATUSES.has(status);
    this.changeState(() => {
      const openCalls = new Map(this.openCalls);
      if (isFinished) {
        openCalls.delete(id);
      } else {
        openCalls.set(id, call);
      }
      this.openCalls = openCalls;
    });
    return isFinished ? describe(call, status, now) : null;
  }

  /** The open call `id`, or one that starts at `now`, with what `update` tells about it; the state is left alone. */
  private absorb(id: string, update: Record<string, unknown>, now: number): OpenToolCall {
    const call: OpenToolCall = { ...(this.openCalls.get(id) ?? { name: null, title: null, startedAt: now, output: null, exitCode: null }) };
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
    return call;
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
