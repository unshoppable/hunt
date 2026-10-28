/**
 * The agent reply a conversation ends with, as the desktop's chat lays the relay's history out in items
 * (`reduceChat` in apps/client/src/chat/chat-reducer.utils.ts): agent message chunks in a row form one reply, while a
 * thought, a tool call (also one an update names first) or a typed user message starts another item. A turn Hunt sent
 * itself (a user message chunk with `_meta.hunt.hidden`) leaves the items alone until the next user message, and a
 * resource block of a prompt is the attached file, not an item. The relay's status reports from it whether the agent
 * waits for an answer.
 */
import * as z from "zod/mini";
import { DomainModel } from "../../../../libs/domain/src/model/domain.model.ts";
import { isRecord, type JsonRpcNotification } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { asksQuestion } from "../../../../libs/domain/src/shared/question.utils.ts";

/** Updates that carry the agent's output for the running turn; a hidden turn's leave the items alone. */
const TURN_OUTPUT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

const ZodTrailingReplyState = z.object({
  /** How many history entries were taken in. */
  taken: z.int().check(z.nonnegative()),
  /** The text of the last item when it is an agent reply; null when the last item is another one or there is none. */
  text: z.nullable(z.string()),
  /** Whether the entries taken in last belong to a turn Hunt sent itself. */
  isHiddenTurn: z.boolean(),
  /** The tool calls the history named, so that an update of a known one is told apart from one that names a call first. */
  toolCallIds: z.set(z.string()),
});

export interface TrailingReply extends z.infer<typeof ZodTrailingReplyState> {}

/** The reply the relay's history ends with; see the module comment. */
export class TrailingReply extends DomainModel<typeof ZodTrailingReplyState> {
  static readonly schema = ZodTrailingReplyState;

  constructor(value: z.input<typeof ZodTrailingReplyState>) {
    super(value);
  }

  /** The reply of a history of which nothing was taken in yet. */
  static start(): TrailingReply {
    return new TrailingReply({ taken: 0, text: null, isHiddenTurn: false, toolCallIds: new Set() });
  }

  /** Whether the conversation ends with an agent reply that asks the user a question. */
  asksQuestion(): boolean {
    return this.text !== null && asksQuestion(this.text);
  }

  /** Takes in the entries `history` gained since the last call; `history` only ever grows. */
  follow(history: readonly JsonRpcNotification[]): void {
    if (this.taken >= history.length) return;
    this.changeState(() => {
      // A copy, so that a rejected change leaves the set of the last valid state as it was.
      this.toolCallIds = new Set(this.toolCallIds);
      for (let index = this.taken; index < history.length; index++) {
        const params = history[index].params;
        if (isRecord(params) && isRecord(params.update)) {
          this.take(params.update);
        }
      }
      this.taken = history.length;
    });
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
