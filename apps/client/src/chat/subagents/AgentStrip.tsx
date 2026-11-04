import { TAB_ACTIVE, TAB_BUTTON_SM, TAB_INACTIVE } from "../../ui/buttons.constants";
import { formatTokens } from "../ContextMeter";
import { SUBAGENT_DOT, SUBAGENT_STATE_LABELS, subagentName, type ListedSubagent } from "./subagent-list.utils";

/**
 * The agents of the chat as tabs below the session summary: the main agent, then every subagent after the agent that
 * started it, each with its state and tokens; the tab picks whose chat shows. `asking` is the agent whose permission
 * request waits for an answer (`null` for the main agent), `undefined` while none waits.
 */
export function AgentStrip({
  listed,
  selected,
  mainTokens,
  asking,
  onSelect,
}: {
  listed: ListedSubagent[];
  selected: string | null;
  /** The tokens of the main agent's last request, as the subagents' count them; `null` until it finished one. */
  mainTokens: number | null;
  asking: string | null | undefined;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <nav aria-label="Agents" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-(--line) px-3 py-2">
      <AgentTab label="Main agent" isActive={selected === null} tokens={mainTokens} asks={asking === null} onClick={() => onSelect(null)} />
      {listed.map(({ subagent, depth }) => (
        <AgentTab
          key={subagent.sessionId}
          label={`${"› ".repeat(depth)}${subagentName(subagent)}`}
          title={subagent.description}
          isActive={selected === subagent.sessionId}
          tokens={subagent.usage?.totalTokens ?? null}
          dot={{ className: SUBAGENT_DOT[subagent.state], title: SUBAGENT_STATE_LABELS[subagent.state] }}
          asks={asking === subagent.sessionId}
          onClick={() => onSelect(subagent.sessionId)}
        />
      ))}
    </nav>
  );
}

function AgentTab({
  label,
  title,
  isActive,
  tokens,
  dot = null,
  asks,
  onClick,
}: {
  label: string;
  title?: string;
  isActive: boolean;
  tokens: number | null;
  dot?: { className: string; title: string } | null;
  asks: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || label}
      aria-current={isActive ? "page" : undefined}
      className={`${TAB_BUTTON_SM} max-w-64 gap-1.5 ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`}
    >
      {dot ? <span className={`size-1.5 shrink-0 rounded-full ${dot.className}`} title={dot.title} /> : null}
      <span className="truncate">{label}</span>
      {tokens !== null ? <span className="shrink-0 text-[12px] font-normal text-neutral-500 tabular-nums">{formatTokens(tokens)}</span> : null}
      {asks ? <span className="size-1.5 shrink-0 rounded-full bg-amber-400" title="Waits for your answer" /> : null}
    </button>
  );
}
