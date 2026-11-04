import type {
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

/**
 * `_meta` Hunt attaches to message chunks: `hidden` marks the chunks of a user turn it sent itself, `at` (RFC 3339) is
 * when the agent's transcript says the message was written (`agent/acp/message_time.rs`).
 */
export type HuntChunkMeta = { hunt?: HuntChunk };
type HuntChunk = { hidden?: boolean; at?: string };

export type UpdateEvent = { huntSessionId: string; notification: SessionNotification };
/** The updates a load of the conversation replayed, in order, sent at once when the load completes. */
export type ReplayEvent = { huntSessionId: string; notifications: SessionNotification[] };
export type PermissionEvent = { huntSessionId: string; requestId: string; request: RequestPermissionRequest };
/** The agent withdrew the permission request `requestId`; a remote session's relay does so when another client answered it. */
export type PermissionWithdrawnEvent = { huntSessionId: string; requestId: string };
export type ClosedEvent = { huntSessionId: string; error: string | null };
/** The transcript times (RFC 3339) of messages of a session that ended a turn, by the `messageId` of their chat items. */
/**
 * What became of a prompt sent into the running turn (`steering.rs`): the turn took it in, no turn runs (any more), or
 * the agent or its relay cannot steer; only a prompt the turn took in reached the agent.
 */
export type SteerOutcome = "injected" | "promptRequired" | "unsupported";

export type MessageTimesEvent = { huntSessionId: string; times: Record<string, string> };

export type ToolCallView = {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  terminalOutput?: string;
};

/**
 * An entry of the chat. The `images` of a message are URLs it shows: asset URLs of screenshots the user attached, or
 * `data:` URLs of image blocks that `imageDataUrl` (chat/image-data.utils.ts) accepted. `at` (RFC 3339) is when the agent's
 * transcript says the message was written; a live message gets it once its turn ended (`acp:message-times`, by
 * `messageId`), and one the transcript lacks has none.
 */
export type ChatItem =
  | { kind: "user"; id: string; text: string; images: string[]; messageId?: string; at?: string }
  | { kind: "agent"; id: string; text: string; images: string[]; messageId?: string; at?: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; toolCall: ToolCallView }
  | { kind: "subagent"; id: string; sessionId: string };

/** How far a subagent got: it works, or it ended as claude-agent-acp reports it (`subagent_state_update`). */
export type SubagentState = "running" | "completed" | "failed" | "cancelled" | "disconnected";

/**
 * What a subagent spent (`SubagentUsage` in `agent/acp/subagents.rs`): `totalTokens` is the size of its last request,
 * as Claude Code counts a subagent's tokens.
 */
export type SubagentUsage = { totalTokens: number; toolUses: number; durationMs: number };

/**
 * A subagent (Agent/Task tool) of the session: a child session of claude-agent-acp with a chat of its own. Its card
 * (a `subagent` item) sits in the chat of `parentSessionId`, the main agent's or another subagent's. `isHidden` marks one
 * a turn Hunt sent itself started, which the chat does not show.
 */
export type SubagentChat = {
  sessionId: string;
  parentSessionId: string;
  title: string;
  description: string;
  state: SubagentState;
  items: ChatItem[];
  plan: PlanEntry[];
  usage: SubagentUsage | null;
  isHidden: boolean;
};

/** What `agent/acp/subagents.rs` puts into `_meta.hunt.subagent` of a `subagent_update`; every field is a change. */
export type HuntSubagentMeta = { hunt?: { subagent?: { state?: SubagentState; prompt?: string; usage?: SubagentUsage } } };

/** A permission request of the agent; `sessionId` is a subagent's when one of them asks. */
export type PendingPermission = {
  requestId: string;
  sessionId: string;
  toolCall: RequestPermissionRequest["toolCall"];
  options: PermissionOption[];
};

/** An image file in the macOS screenshot folder. */
export type Screenshot = {
  name: string;
  /** Absolute path. */
  path: string;
  /** Last modification as unix milliseconds. */
  modifiedAt: number;
};
