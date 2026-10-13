/** Helpers for asserting on the messages the relay sends, shared by its unit and integration tests. */
import { isRecord } from "../../../../../libs/domain/src/jsonRpc.ts";

/** The `update` of a `session/update` notification; undefined for any other message. */
export function updateOf(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message) || message.method !== "session/update" || !isRecord(message.params)) return undefined;
  return isRecord(message.params.update) ? message.params.update : undefined;
}

/** The turn state a relay `session_info_update` reports; undefined for any other message. */
export function turnOf(message: unknown): unknown {
  const meta = updateOf(message)?._meta;
  return isRecord(meta) && isRecord(meta.hunt) ? meta.hunt.turn : undefined;
}

/** The text of a message chunk update. */
export function textOf(message: unknown): unknown {
  const content = updateOf(message)?.content;
  return isRecord(content) ? content.text : undefined;
}

/** A short name per message for asserting the order of a stream: the update kind, `turn:<state>`, `request:<method>`, `response:<id>`. */
export function label(message: unknown): string {
  if (!isRecord(message)) return "invalid";
  const turn = turnOf(message);
  if (turn) return `turn:${String(turn)}`;
  const update = updateOf(message);
  if (update) return String(update.sessionUpdate);
  if (typeof message.method === "string") return message.id === undefined ? `notification:${message.method}` : `request:${message.method}`;
  return `response:${String(message.id)}`;
}
