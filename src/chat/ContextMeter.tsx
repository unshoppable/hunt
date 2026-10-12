import type { ContextUsage } from "../state/store";
import { UsageBar } from "../ui/UsageBar";

/** Fill level of the context window as a bar plus `42.3k / 200k (21%)`, shown left of the Guardrail button above the prompt box. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const percent = contextPercent(usage);
  return (
    <div
      role="meter"
      aria-label="Context window"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title="Context window: used / size"
      className="flex shrink-0 items-center gap-2 pl-2.5 text-[12px] text-neutral-500 tabular-nums"
    >
      <UsageBar percent={percent} className="h-1.5 w-16" />
      {formatContextUsage(usage)}
    </div>
  );
}

function contextPercent({ used, size }: ContextUsage): number {
  return size > 0 ? Math.round((used / size) * 100) : 0;
}

/** `42.3k / 200k (21%)`: tokens in context, window size and fill level. */
export function formatContextUsage(usage: ContextUsage): string {
  return `${formatTokens(usage.used)} / ${formatTokens(usage.size)} (${contextPercent(usage)}%)`;
}

/** Token counts as `9.5k`, `200k` or `1M`: one decimal below ten units, none above. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${trimScaled(count / 1_000_000)}M`;
  if (count >= 1000) return `${trimScaled(count / 1000)}k`;
  return String(count);
}

function trimScaled(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}
