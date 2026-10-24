/**
 * The agent reply a conversation ends with, as the desktop's chat lays the relay's history out in items
 * (`reduceChat` in apps/client/src/state/store.ts): agent message chunks in a row form one reply, while a thought, a
 * tool call (also one an update names first) or a typed user message starts another item. A turn Hunt sent itself (a
 * user message chunk with `_meta.hunt.hidden`) leaves the items alone until the next user message, and a resource block
 * of a prompt is the attached file, not an item. The relay's status reports from it whether the agent waits for an answer.
 */
import { isRecord, type JsonRpcNotification } from "../../../../libs/domain/src/jsonRpc.ts";
import { asksQuestion } from "../../../../libs/domain/src/question.ts";

/** Updates that carry the agent's output for the running turn; a hidden turn's leave the items alone. */
const TURN_OUTPUT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

export class TrailingReply {
  /** How many history entries were taken in. */
  private taken = 0;
  /** The text of the last item when it is an agent reply; null when the last item is another one or there is none. */
  private text: string | null = null;
  private isHiddenTurn = false;
  private readonly toolCallIds = new Set<string>();

  /** Takes in the entries `history` gained since the last call; `history` only ever grows. */
  follow(history: readonly JsonRpcNotification[]): void {
    for (; this.taken < history.length; this.taken++) {
      const params = history[this.taken].params;
      if (isRecord(params) && isRecord(params.update)) {
        this.take(params.update);
      }
    }
  }

  /** Whether the conversation ends with an agent reply that asks the user a question. */
  asksQuestion(): boolean {
    return this.text !== null && asksQuestion(this.text);
  }

  private take(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate;
    if (typeof kind !== "string") return;
    if (TURN_OUTPUT_UPDATES.has(kind) && this.isHiddenTurn) return;
    switch (kind) {
      case "user_message_chunk":
        this.isHiddenTurn = isHidden(update._meta);
        if (!this.isHiddenTurn && !(isRecord(update.content) && update.content.type === "resource")) {
          this.text = null;
        }
        break;
      case "agent_message_chunk":
        this.text = (this.text ?? "") + textOf(update.content);
        break;
      case "agent_thought_chunk":
        this.text = null;
        break;
      case "tool_call":
      case "tool_call_update":
        if (typeof update.toolCallId === "string" && (kind === "tool_call" || !this.toolCallIds.has(update.toolCallId))) {
          this.toolCallIds.add(update.toolCallId);
          this.text = null;
        }
        break;
    }
  }
}

/** Whether a user message chunk belongs to a turn Hunt sent itself. */
function isHidden(meta: unknown): boolean {
  if (!isRecord(meta) || !isRecord(meta.hunt)) return false;
  return meta.hunt.hidden === true;
}

function textOf(content: unknown): string {
  return isRecord(content) && content.type === "text" && typeof content.text === "string" ? content.text : "";
}
