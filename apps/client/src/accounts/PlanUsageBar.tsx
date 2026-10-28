import { useEffect, useRef, useState } from "react";
import type { UsageWindow } from "./plan-usage.types";
import { useAccountsStore } from "./accounts.store";
import { formatTimeUntil, usePlanUsageStore } from "./plan-usage.store";
import { usageColor } from "../ui/usage-color.utils";
import { UsageBar } from "../ui/UsageBar";

/**
 * The claude.ai plan limits under the session list: `5h 8% · Week 48% · Fable 94%`, each above a fill bar colored
 * from green to red by the level and the time left until the window resets (`1d 5h`, updated every minute). Reads them at start, when the window regains focus after a while
 * and right away on a switch of the Claude account. While the usage endpoint refuses reads, the last limits stay with a note in the
 * tooltip, or without any a row says when the next read can start. Renders nothing without plan limits (API key, Bedrock, Vertex) or before the first read.
 */
export function PlanUsageBar() {
  const usage = usePlanUsageStore((state) => state.usage);
  const fetchedAt = usePlanUsageStore((state) => state.fetchedAt);
  const isLoading = usePlanUsageStore((state) => state.isLoading);
  const error = usePlanUsageStore((state) => state.error);
  const blockedUntil = usePlanUsageStore((state) => state.blockedUntil);
  const refreshIfStale = usePlanUsageStore((state) => state.refreshIfStale);
  const switchAccount = usePlanUsageStore((state) => state.switchAccount);

  const activeAccountId = useAccountsStore((state) => state.accounts?.activeId);
  const shownAccountIdRef = useRef(activeAccountId);
  const [now, setNow] = useState(() => Date.now());

  // `undefined` means the accounts are not loaded yet; the first load is no switch.
  useEffect(() => {
    const shownAccountId = shownAccountIdRef.current;
    shownAccountIdRef.current = activeAccountId;
    if (shownAccountId === undefined || shownAccountId === activeAccountId) return;
    switchAccount();
  }, [activeAccountId, switchAccount]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshIfStale();
    window.addEventListener("focus", refreshIfStale);
    return () => window.removeEventListener("focus", refreshIfStale);
  }, [refreshIfStale]);

  const blockedFor = blockedUntil && blockedUntil > now ? formatTimeUntil(new Date(blockedUntil).toISOString(), now) : null;
  const status = [
    ...(blockedFor ? [`Claude refuses usage reads for too many requests; next read in ${blockedFor}`] : []),
    ...(error ? [`Last refresh failed: ${error}`] : []),
  ];

  if (!usage || usage.windows.length === 0) {
    if (status.length === 0) return null;
    return (
      <div
        title={status.join("\n")}
        className={`flex w-full shrink-0 gap-1 overflow-hidden border-t border-(--line) px-3 py-2.5 text-[13px] whitespace-nowrap text-neutral-500 ${isLoading ? "opacity-60" : ""}`}
      >
        <span className="min-w-0 truncate">Plan usage unavailable</span>
        {blockedFor ? <span className="shrink-0 tabular-nums text-neutral-600">· retry in {blockedFor}</span> : null}
      </div>
    );
  }

  const title = [
    ...usage.windows.map((window) => `${windowName(window)}: ${Math.round(window.utilization)}% used${resetText(window, now)}`),
    "",
    ...(fetchedAt ? [`Updated ${formatAge(now - fetchedAt)}`] : []),
    ...status,
  ].join("\n");

  return (
    <div
      title={title}
      className={`flex w-full shrink-0 gap-3 overflow-hidden border-t border-(--line) px-3 py-2.5 text-[13px] whitespace-nowrap text-neutral-500 ${isLoading ? "opacity-60" : ""}`}
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
    </div>
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
