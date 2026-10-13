import { useEffect, useRef, useState } from "react";
import type { UsageWindow } from "../ipc/types";
import { useAccountsStore } from "../state/accounts";
import { formatTimeUntil, usageColor, usePlanUsageStore } from "../state/planUsage";
import { UsageBar } from "../ui/UsageBar";

/**
 * The claude.ai plan limits under the session list: `5h 8% · Week 48% · Fable 94%`, each above a fill bar colored
 * from green to red by the level and the time left until the window resets (`1d 5h`, updated every minute). Reads them at start and when the window regains focus after a while; a click or
 * a switch of the Claude account reads them again right away. Renders nothing without plan limits (API key, Bedrock, Vertex) or before the first read.
 */
export function PlanUsageBar() {
  const usage = usePlanUsageStore((state) => state.usage);
  const fetchedAt = usePlanUsageStore((state) => state.fetchedAt);
  const isLoading = usePlanUsageStore((state) => state.isLoading);
  const error = usePlanUsageStore((state) => state.error);
  const refresh = usePlanUsageStore((state) => state.refresh);
  const refreshIfStale = usePlanUsageStore((state) => state.refreshIfStale);

  const activeAccountId = useAccountsStore((state) => state.accounts?.activeId);
  const shownAccountIdRef = useRef(activeAccountId);
  const [now, setNow] = useState(() => Date.now());

  // `undefined` means the accounts are not loaded yet; the first load is no switch.
  useEffect(() => {
    const shownAccountId = shownAccountIdRef.current;
    shownAccountIdRef.current = activeAccountId;
    if (shownAccountId === undefined || shownAccountId === activeAccountId) return;
    refresh(true);
  }, [activeAccountId, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshIfStale();
    window.addEventListener("focus", refreshIfStale);
    return () => window.removeEventListener("focus", refreshIfStale);
  }, [refreshIfStale]);

  if (!usage || usage.windows.length === 0) return null;

  const title = [
    ...usage.windows.map((window) => `${windowName(window)}: ${Math.round(window.utilization)}% used${resetText(window, now)}`),
    "",
    fetchedAt ? `Updated ${formatAge(now - fetchedAt)} · click to refresh` : "Click to refresh",
    ...(error ? [`Last refresh failed: ${error}`] : []),
  ].join("\n");

  return (
    <button
      type="button"
      onClick={() => refresh(true)}
      title={title}
      aria-label="Plan usage, click to refresh"
      className={`flex w-full shrink-0 gap-3 overflow-hidden border-t border-(--line) px-3 py-2.5 text-left text-[13px] whitespace-nowrap text-neutral-500 hover:bg-white/5 ${isLoading ? "opacity-60" : ""}`}
    >
      {usage.windows.map((window) => (
        <span key={window.label} className="flex min-w-0 flex-auto flex-col gap-[5px]">
          <span className="flex gap-1 leading-none">
            <span className="min-w-0 truncate">{window.label}</span>
            <span className="shrink-0 tabular-nums" style={{ color: usageColor(window.utilization) }}>{Math.round(window.utilization)}%</span>
          </span>
          <UsageBar percent={window.utilization} />
          {window.resetsAt ? <span className="text-[12px] leading-none tabular-nums text-neutral-600">{formatTimeUntil(window.resetsAt, now)}</span> : null}
        </span>
      ))}
    </button>
  );
}

function windowName(window: UsageWindow): string {
  if (window.label === "5h") return "5-hour limit";
  if (window.label === "Week") return "Weekly limit, all models";
  return `Weekly limit, ${window.label}`;
}

function resetText(window: UsageWindow, now: number): string {
  if (!window.resetsAt) return "";
  const at = new Date(window.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return ` · resets in ${formatTimeUntil(window.resetsAt, now)} (${at})`;
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}
