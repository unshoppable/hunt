import type { KeyboardEvent, RefObject } from "react";
import type { QueuedPrompt } from "../chat.store-slice";
import type { GuardrailDeclineReason } from "../guardrail/guardrail-suggestion.types";
import { PillSelect } from "../PillSelect";
import type { ConfigSelect } from "../prompt/PromptInput";
import { QueuedPrompts } from "../prompt/QueuedPrompts";
import { DeclineReasonButton } from "../guardrail/DeclineReasonButton";
import { DANGER_CLEAR_BUTTON, SEND_BUTTON } from "../../ui/buttons.constants";
import { SendIcon, TrashIcon } from "../../ui/Icons";
import { ResizeGrips, type ResizeHandlers } from "../../ui/ResizeGrips";
import { useShortcutLabel } from "../../ui/shortcut-label.hook";

type SubChatComposerProps = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (text: string) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The sub session the questions go to; `null` until the first question created it. */
  subSessionId: string | null;
  /** Whether a turn of the sub session runs, so that a question waits in its queue. */
  isTurnRunning: boolean;
  /** Whether the first question is creating the sub session. */
  isCreating: boolean;
  /** Whether a permission request is pending; the text area and the send button wait for its answer. */
  hasPermission: boolean;
  /** Placeholder of the first question's textarea. */
  placeholder?: string;
  queue: QueuedPrompt[];
  onSendQueuedNow: (prompt: QueuedPrompt) => void;
  onTakeBack: (prompt: QueuedPrompt) => void;
  configSelects: ConfigSelect[];
  onConfigChange: (configId: string, value: string) => void;
  /** Declines what the popover was opened to take up; offered until the first question is sent. */
  onDecline?: (reason: GuardrailDeclineReason) => void;
  onDelete: () => void;
  onSubmit: () => void;
  onClose: () => void;
  /** The handlers of the top edge's grip, which makes the text area taller. */
  heightGrips: ResizeHandlers;
};

/**
 * The input area of a running sub chat: the queued questions, the text area, the model and effort pills, the delete and
 * send buttons and, for an offer the popover was opened to take up, the "Decline" button.
 */
export function SubChatComposer({
  textareaRef,
  text,
  onTextChange,
  onTextareaKeyDown,
  subSessionId,
  isTurnRunning,
  isCreating,
  hasPermission,
  placeholder,
  queue,
  onSendQueuedNow,
  onTakeBack,
  configSelects,
  onConfigChange,
  onDecline,
  onDelete,
  onSubmit,
  onClose,
  heightGrips,
}: SubChatComposerProps) {
  const sendNowShortcut = useShortcutLabel("chat.sendNow");

  return (
    <div className="relative border-t border-(--line) bg-(--surface-input) px-12 py-3">
      <QueuedPrompts queue={queue} shortcutLabel={text.trim() ? null : sendNowShortcut} onSendNow={onSendQueuedNow} onTakeBack={onTakeBack} />
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          disabled={hasPermission}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={onTextareaKeyDown}
          rows={1}
          placeholder={isTurnRunning ? "Enter queues the question for after this turn" : subSessionId ? "Follow up…" : (placeholder ?? "Ask about the selected code…")}
          className="block min-w-0 flex-1 resize-none bg-transparent py-[calc((36px-1lh)/2)] outline-none placeholder:text-neutral-600 disabled:opacity-50"
        />
        <div className="flex flex-col items-end gap-2">
          {onDecline && !subSessionId ? (
            <DeclineReasonButton
              disabled={isCreating}
              onDecline={(reason) => {
                onDecline(reason);
                onClose();
              }}
            />
          ) : null}
          <div className="flex items-end gap-2">
            {configSelects.map((select) => (
              <PillSelect
                key={select.id}
                title={select.name}
                value={select.value}
                options={select.choices}
                onChange={(value) => onConfigChange(select.id, value)}
                disabled={isCreating}
              />
            ))}
            {subSessionId ? (
              <button type="button" onClick={onDelete} disabled={isCreating} title="Delete this sub chat" aria-label="Delete this sub chat" className={DANGER_CLEAR_BUTTON}>
                <TrashIcon />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onSubmit}
              disabled={!text.trim() || isCreating || hasPermission}
              title={isTurnRunning ? "Queue for after this turn (enter); ⌘↩ sends now" : "Send (enter)"}
              className={SEND_BUTTON}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
      <ResizeGrips edges={{ top: true }} {...heightGrips} />
    </div>
  );
}
