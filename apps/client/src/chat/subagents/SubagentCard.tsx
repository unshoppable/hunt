import type { SubagentChat } from "../chat.types";
import { formatTokens } from "../ContextMeter";
import { ChevronIcon, SparkleIcon } from "../../ui/Icons";
import { SUBAGENT_DOT, SUBAGENT_STATE_LABELS, subagentName } from "./subagent-list.utils";

/**
 * A subagent in the chat of the agent that started it: its state, name, task and tokens; a click shows its own chat.
 * `asks` marks one whose permission request waits for an answer.
 */
export function SubagentCard({ subagent, asks, onOpen }: { subagent: SubagentChat; asks: boolean; onOpen: () => void }) {
  const name = subagentName(subagent);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Show the chat of ${name}`}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-(--line) bg-(--surface-inset)/60 px-3 py-2 text-left transition-colors hover:bg-(--row-hover)"
    >
      <SparkleIcon className="size-4 shrink-0 text-neutral-400" />
      <span className={`size-2 shrink-0 rounded-full ${SUBAGENT_DOT[subagent.state]}`} title={SUBAGENT_STATE_LABELS[subagent.state]} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-neutral-100">{name}</span>
        {subagent.description && subagent.description !== name ? <span className="block truncate text-[13px] text-neutral-500">{subagent.description}</span> : null}
      </span>
      {asks ? <span className="shrink-0 text-[13px] text-amber-300">Waits for you</span> : null}
      {subagent.usage ? (
        <span className="shrink-0 text-[13px] text-neutral-500 tabular-nums" title="Tokens of its last request · tool uses">
          {formatTokens(subagent.usage.totalTokens)} · {subagent.usage.toolUses} {subagent.usage.toolUses === 1 ? "tool" : "tools"}
        </span>
      ) : null}
      <ChevronIcon expanded={false} className="size-3.5 shrink-0 text-neutral-500" />
    </button>
  );
}
