import type { SubagentChat } from "../chat.types";
import { formatTokens } from "../ContextMeter";
import { formatDuration, SUBAGENT_DOT, SUBAGENT_STATE_LABELS, subagentName } from "./subagent-list.utils";

/**
 * The top of a subagent's chat: the way back to the agent that started it (`parent`, the main agent when `null`), its
 * name and state, and its task.
 */
export function SubagentHeader({ subagent, parent, onSelect }: { subagent: SubagentChat; parent: SubagentChat | null; onSelect: (agentId: string | null) => void }) {
  return (
    <div className="mb-5 border-b border-(--line) pb-4">
      <nav aria-label="Agent path" className="flex min-w-0 items-center gap-1.5 text-[13px] text-neutral-500">
        <button type="button" onClick={() => onSelect(null)} className="shrink-0 hover:text-white">
          Main agent
        </button>
        {parent ? (
          <>
            <span aria-hidden="true">›</span>
            <button type="button" onClick={() => onSelect(parent.sessionId)} className="min-w-0 truncate hover:text-white">
              {subagentName(parent)}
            </button>
          </>
        ) : null}
        <span aria-hidden="true">›</span>
        <span className="min-w-0 truncate text-neutral-300">{subagentName(subagent)}</span>
      </nav>
      <div className="mt-2 flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${SUBAGENT_DOT[subagent.state]}`} />
        <span className="text-[13px] text-neutral-400">{SUBAGENT_STATE_LABELS[subagent.state]}</span>
      </div>
      {subagent.description && subagent.description !== subagentName(subagent) ? (
        <p className="mt-1.5 line-clamp-3 text-[13px] whitespace-pre-wrap text-neutral-500" title={subagent.description}>
          {subagent.description}
        </p>
      ) : null}
    </div>
  );
}

/** What a subagent spent, above the prompt box while its chat shows: `19.4k tokens · 2 tools · 4s`. */
export function SubagentUsageLine({ subagent }: { subagent: SubagentChat }) {
  if (!subagent.usage) return <span className="pl-2.5 text-[12px] text-neutral-500">No usage reported yet</span>;
  const { totalTokens, toolUses, durationMs } = subagent.usage;
  return (
    <span className="shrink-0 pl-2.5 text-[12px] text-neutral-500 tabular-nums" title="Tokens of the subagent's last request, its tool uses and how long it worked">
      {formatTokens(totalTokens)} tokens · {toolUses} {toolUses === 1 ? "tool" : "tools"} · {formatDuration(durationMs)}
    </span>
  );
}
