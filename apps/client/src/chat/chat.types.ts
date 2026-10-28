import type {
  PermissionOption,
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
  | { kind: "tool"; id: string; toolCall: ToolCallView };

export type PendingPermission = {
  requestId: string;
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
