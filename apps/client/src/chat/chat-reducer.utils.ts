import type { ContentBlock, SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { ChatItem, HuntChunkMeta, ToolCallView } from "./chat.types";
import type { SessionChat } from "./chat.store-slice";
import { imageDataUrl, imagePlaceholder } from "./image-data.utils";

export function createEmptyChat(): SessionChat {
  return {
    items: [],
    plan: [],
    commands: [],
    modeId: "default",
    configOptions: [],
    permission: null,
    contextUsage: null,
    isBusy: false,
    queue: [],
    hasUnseenActivity: false,
    unseenAfterMessageId: null,
    isLoading: false,
    error: null,
    editVersion: 0,
    graphVersion: 0,
    generatingDiagrams: [],
    diagramErrors: {},
    isHiddenTurn: false,
    hasHistory: false,
    remoteStep: null,
    remoteDetail: null,
    remoteRun: null,
    isStale: false,
    move: null,
    fileSync: { isRunning: false, syncedAt: null, error: null, conflicts: [] },
    dismissedGuardrailId: null,
  };
}

/**
 * The empty chat a restarted agent fills; the mode, the queued prompts, a running remote operation or move, the file
 * sync and the diagram generations carry over.
 */
export function replacedChat(chat: SessionChat): SessionChat {
  const { modeId, queue, isLoading, remoteStep, remoteDetail, remoteRun, move, fileSync, generatingDiagrams, diagramErrors } = chat;
  return { ...createEmptyChat(), modeId, queue, hasHistory: true, isLoading, remoteStep, remoteDetail, remoteRun, move, fileSync, generatingDiagrams, diagramErrors };
}

/** The turn state the backend or the relay of a remote session reports in `_meta.hunt.turn` of a `session_info_update`, if any. */
export function huntTurnOf(meta: unknown): "running" | "idle" | null {
  const turn = (meta as { hunt?: { turn?: unknown } } | null | undefined)?.hunt?.turn;
  return turn === "running" || turn === "idle" ? turn : null;
}

let itemCounter = 0;
export function nextItemId(): string {
  itemCounter += 1;
  return `item-${itemCounter}`;
}

function describeContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return `[${block.name ?? block.uri}]`;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    default:
      return "";
  }
}

function appendThought(items: ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "thought") {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { kind: "thought", id: nextItemId(), text }];
}

/** A user turn or an agent reply: the items that show images next to their text. */
export type MessageItem = Extract<ChatItem, { kind: "user" | "agent" }>;

/** `message` with `block` added; an image block adds its data URL, or its placeholder text when the chat does not show it. */
function withBlock(message: MessageItem, block: ContentBlock): MessageItem {
  if (block.type !== "image") return { ...message, text: message.text + describeContentBlock(block) };
  const url = imageDataUrl(block);
  return url ? { ...message, images: [...message.images, url] } : { ...message, text: message.text + imagePlaceholder(block) };
}

/** The message a chunk belongs to and when it was written, as far as the backend knows them. */
type ChunkOrigin = Pick<MessageItem, "messageId" | "at">;

/** Adds one block to the last item when it is a message of `kind`, or starts a new message of `kind` from `origin` with it. */
function appendMessageBlock(items: ChatItem[], kind: MessageItem["kind"], block: ContentBlock, origin: ChunkOrigin): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === kind) return [...items.slice(0, -1), withBlock(last, block)];
  return [...items, withBlock({ kind, id: nextItemId(), text: "", images: [], ...origin }, block)];
}

/**
 * The text block claude-agent-acp's transcript holds for an attached file resource, as a replayed session sends it back;
 * the group is the file's URI.
 */
const REPLAYED_FILE_CONTEXT = /^\s*<context ref="([^"]*)">[\s\S]*<\/context>\s*$/;

/** The link claude-agent-acp puts ahead of the prompt's text for the attached file at `uri`. */
function attachedFileLink(uri: string): string {
  const path = uri.replace(/^file:\/\//, "");
  return `[@${path.split("/").pop() || path}](${uri})`;
}

/** `items` with the link to the attached file at `uri` taken off the start of the last user turn's text. */
function withoutAttachedFileLink(items: ChatItem[], uri: string): ChatItem[] {
  const last = items[items.length - 1];
  const link = attachedFileLink(uri);
  if (last?.kind !== "user" || !last.text.startsWith(link)) return items;
  return [...items.slice(0, -1), { ...last, text: last.text.slice(link.length) }];
}

/** Adds one block of a user turn to the last user item; an image block becomes a data URL the bubble can show. */
function appendUserBlock(items: ChatItem[], block: ContentBlock, origin: ChunkOrigin): ChatItem[] {
  // A resource block is the file content Hunt attaches to a prompt (see the backend's `send_prompt`), not something the user typed.
  if (block.type === "resource") return items;
  const replayedFileContext = block.type === "text" ? REPLAYED_FILE_CONTEXT.exec(block.text) : null;
  if (replayedFileContext) return withoutAttachedFileLink(items, replayedFileContext[1]);
  return appendMessageBlock(items, "user", block, origin);
}

/** Updates that carry the agent's output for the running turn; the chat leaves them out of a turn Hunt sent itself. */
const TURN_OUTPUT_UPDATES = new Set<SessionNotification["update"]["sessionUpdate"]>(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

/** Whether a user message chunk belongs to a turn Hunt sent itself. */
function isHiddenChunk(meta: unknown): boolean {
  return Boolean((meta as HuntChunkMeta | null | undefined)?.hunt?.hidden);
}

/** The message of a chunk and the transcript time the backend stamped it with. */
function chunkOrigin({ messageId, _meta }: { messageId?: string | null; _meta?: unknown }): ChunkOrigin {
  return { messageId: messageId ?? undefined, at: (_meta as HuntChunkMeta | null | undefined)?.hunt?.at };
}

function toToolCallView(toolCall: ToolCall): ToolCallView {
  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    kind: toolCall.kind ?? "other",
    status: toolCall.status ?? "pending",
    content: toolCall.content ?? [],
    locations: toolCall.locations ?? [],
    rawInput: toolCall.rawInput,
    rawOutput: toolCall.rawOutput,
  };
}

type TerminalMeta = {
  terminal_output?: { data?: unknown } | string;
  terminal_exit?: { exit_code?: number | null; signal?: string | null };
};

/**
 * claude-agent-acp puts Bash output into `_meta.terminal_output` when the client opted in and reports the exit in a
 * later update without output; a failed exit is appended below `previousOutput`.
 */
function readTerminalOutput(update: ToolCallUpdate, previousOutput?: string): string | undefined {
  const meta = update._meta as TerminalMeta | undefined;
  const output = meta?.terminal_output;
  let text = previousOutput;
  if (typeof output === "string") {
    text = output;
  } else if (output && typeof output.data === "string") {
    text = output.data;
  }

  const exitCode = meta?.terminal_exit?.exit_code;
  if (exitCode) {
    text = `${text ?? ""}\n[exit code ${exitCode}]`;
  }
  return text;
}

function mergeToolCallUpdate(items: ChatItem[], update: ToolCallUpdate): ChatItem[] {
  const index = items.findIndex((item) => item.kind === "tool" && item.toolCall.toolCallId === update.toolCallId);

  if (index === -1) {
    const toolCall: ToolCallView = {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? "other",
      status: update.status ?? "pending",
      content: update.content ?? [],
      locations: update.locations ?? [],
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
      terminalOutput: readTerminalOutput(update),
    };
    return [...items, { kind: "tool", id: nextItemId(), toolCall }];
  }

  const existing = items[index] as Extract<ChatItem, { kind: "tool" }>;
  const toolCall: ToolCallView = {
    ...existing.toolCall,
    title: update.title ?? existing.toolCall.title,
    kind: update.kind ?? existing.toolCall.kind,
    status: update.status ?? existing.toolCall.status,
    content: update.content ?? existing.toolCall.content,
    locations: update.locations ?? existing.toolCall.locations,
    rawInput: update.rawInput ?? existing.toolCall.rawInput,
    rawOutput: update.rawOutput ?? existing.toolCall.rawOutput,
    terminalOutput: readTerminalOutput(update, existing.toolCall.terminalOutput),
  };
  const next = [...items];
  next[index] = { ...existing, toolCall };
  return next;
}

export function reduceChat(chat: SessionChat, notification: SessionNotification): SessionChat {
  const update = notification.update;
  if (TURN_OUTPUT_UPDATES.has(update.sessionUpdate) && chat.isHiddenTurn) return chat;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      if (isHiddenChunk(update._meta)) return { ...chat, isHiddenTurn: true };
      return { ...chat, items: appendUserBlock(chat.items, update.content, chunkOrigin(update)), isHiddenTurn: false };
    case "agent_message_chunk":
      return { ...chat, items: appendMessageBlock(chat.items, "agent", update.content, chunkOrigin(update)) };
    case "agent_thought_chunk":
      return { ...chat, items: appendThought(chat.items, describeContentBlock(update.content)) };
    case "tool_call":
      return { ...chat, items: [...chat.items, { kind: "tool", id: nextItemId(), toolCall: toToolCallView(update) }] };
    case "tool_call_update": {
      const items = mergeToolCallUpdate(chat.items, update);
      const merged = items.find((item) => item.kind === "tool" && item.toolCall.toolCallId === update.toolCallId);
      const kind = merged?.kind === "tool" ? merged.toolCall.kind : "other";
      const isFinishedEdit = update.status === "completed" && (kind === "edit" || kind === "delete" || kind === "move");
      return { ...chat, items, editVersion: isFinishedEdit ? chat.editVersion + 1 : chat.editVersion };
    }
    case "plan":
      return { ...chat, plan: update.entries };
    case "available_commands_update":
      return { ...chat, commands: update.availableCommands };
    case "current_mode_update":
      return { ...chat, modeId: update.currentModeId };
    case "config_option_update": {
      // The `mode` option carries the current mode too, so a loaded session shows the mode its agent resumed in.
      const mode = update.configOptions.find((option) => option.id === "mode");
      return { ...chat, configOptions: update.configOptions, modeId: mode?.type === "select" ? mode.currentValue : chat.modeId };
    }
    case "usage_update":
      return { ...chat, contextUsage: { used: update.used, size: update.size } };
    case "session_info_update": {
      const turn = huntTurnOf(update._meta);
      if (!turn) return chat;
      // A turn that ends, whoever on the relay sent it, may have changed the worktree on the VM.
      const hasEnded = turn === "idle" && chat.isBusy;
      return { ...chat, isBusy: turn === "running", editVersion: hasEnded ? chat.editVersion + 1 : chat.editVersion };
    }
    default:
      return chat;
  }
}
