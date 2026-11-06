import type { ToolCallContent, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import type { ChatItem, ToolCallView } from "../chat/chat.types";

/**
 * The conversation of a run of the swf pipeline as the chat shows it, read from its Claude Code transcript
 * (`.hunt/swf/transcripts/<nn>-<step>.jsonl`): the prompts, the agent's replies and thoughts and its tool calls with
 * their results; `cwd` is the worktree the run worked in, which the chat strips from tool arguments.
 */
export type RunConversation = { items: ChatItem[]; cwd: string };

type JsonObject = Record<string, unknown>;

/**
 * The conversation the transcript `jsonl` records. The tool calls take the form claude-agent-acp gives them in a live
 * chat (kind, title, locations, diffs), so that the chat's tool rows render them alike. Lines that are not JSON, the
 * messages Claude Code adds itself (`isMeta`), those of subagents and empty thoughts are left out.
 */
export function runConversation(jsonl: string): RunConversation {
  const items: ChatItem[] = [];
  const toolIndexes = new Map<string, number>();
  let cwd = "";
  for (const line of jsonl.split("\n")) {
    const entry = parseLine(line);
    if (!entry || entry.isSidechain === true || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    const message = isObject(entry.message) ? entry.message : null;
    const id = typeof entry.uuid === "string" ? entry.uuid : `line-${items.length}`;
    const blocks = typeof message?.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message?.content) ? message.content : [];
    if (entry.type === "user") {
      const texts: string[] = [];
      for (const block of blocks.filter(isObject)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const index = toolIndexes.get(block.tool_use_id);
          const item = index === undefined ? undefined : items[index];
          if (index !== undefined && item?.kind === "tool") items[index] = { ...item, toolCall: withResult(item.toolCall, block) };
        } else if (block.type === "text" && typeof block.text === "string" && entry.isMeta !== true) {
          texts.push(block.text);
        }
      }
      if (texts.join("").trim()) items.push({ kind: "user", id, text: texts.join("\n"), images: [] });
      continue;
    }
    blocks.filter(isObject).forEach((block, position) => {
      const blockId = `${id}:${position}`;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        items.push({ kind: "agent", id: blockId, text: block.text, images: [] });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        items.push({ kind: "thought", id: blockId, text: block.thinking });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        toolIndexes.set(block.id, items.length);
        items.push({ kind: "tool", id: block.id, toolCall: toolCallOf(block.id, typeof block.name === "string" ? block.name : "Tool", block.input) });
      }
    });
  }
  return { items, cwd };
}

/** The tool call `name` with `input` before its result, as claude-agent-acp names and describes it. */
function toolCallOf(toolCallId: string, name: string, input: unknown): ToolCallView {
  const args = isObject(input) ? input : {};
  const path = text(args.file_path) ?? text(args.notebook_path);
  const call = (kind: ToolKind, title: string, content: ToolCallContent[] = []): ToolCallView => ({
    toolCallId,
    title,
    kind,
    status: "pending",
    content,
    locations: path && (kind === "read" || kind === "edit") ? [{ path }] : [],
    rawInput: input,
  });
  switch (name) {
    case "Bash":
      return call("execute", text(args.command) ?? "Terminal");
    case "Read":
      return call("read", path ? `Read ${path}` : "Read");
    case "Write":
      return call("edit", `Write ${path ?? ""}`, path ? [{ type: "diff", path, oldText: null, newText: text(args.content) ?? "" }] : []);
    case "Edit":
      return call("edit", `Edit ${path ?? ""}`, path ? [diffOf(path, args)] : []);
    case "MultiEdit":
      return call("edit", `Edit ${path ?? ""}`, path && Array.isArray(args.edits) ? args.edits.filter(isObject).map((edit) => diffOf(path, edit)) : []);
    case "Grep":
      return call("search", [text(args.pattern), text(args.path)].filter(Boolean).join(" "));
    case "Glob":
      return call("search", `Find ${text(args.pattern) ?? ""}`);
    case "WebFetch":
      return call("fetch", `Fetch ${text(args.url) ?? ""}`);
    case "WebSearch":
      return call("fetch", `Search ${text(args.query) ?? ""}`);
    default:
      return call("other", name);
  }
}

/** The change of an Edit (or of one edit of a MultiEdit) as a diff of `path`. */
function diffOf(path: string, edit: JsonObject): ToolCallContent {
  return { type: "diff", path, oldText: text(edit.old_string) ?? "", newText: text(edit.new_string) ?? "" };
}

/** `toolCall` with the `tool_result` block that answered it: completed or failed, with the text it returned. */
function withResult(toolCall: ToolCallView, result: JsonObject): ToolCallView {
  const status: ToolCallStatus = result.is_error === true ? "failed" : "completed";
  const output = resultText(result.content);
  const diffs = toolCall.content.filter((entry) => entry.type === "diff");
  const content: ToolCallContent[] = output ? [...diffs, { type: "content", content: { type: "text", text: output } }] : diffs;
  return { ...toolCall, status, content, rawOutput: result.content };
}

/** The text of a tool result's content, a string or text blocks; other blocks (images, tool references) are left out. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parseLine(line: string): JsonObject | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
