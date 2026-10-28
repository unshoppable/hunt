import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { PlanUsage } from "./plan-usage.types";

/** Minimum time between two automatic refreshes; turns ending sooner share one trailing refresh. The usage endpoint
 * refuses reads for about an hour once a token asks too often. */
export const REFRESH_INTERVAL_MS = 5 * 60_000;
/** Age after which regaining window focus refreshes the usage. */
export const STALE_AFTER_MS = 5 * 60_000;


/** Milliseconds to wait before an automatic refresh may start; 0 starts it now. */
export function refreshDelay(lastStartedAt: number | null, now: number): number {
  if (lastStartedAt === null) return 0;
  return Math.max(0, lastStartedAt + REFRESH_INTERVAL_MS - now);
}

/** Time until `resetsAt` in its two largest units: `1d 5h`, `3h 20m`, `12m`, `now`; a zero second unit is left out. */
export function formatTimeUntil(resetsAt: string, now: number): string {
  const minutes = Math.floor((Date.parse(resetsAt) - now) / 60_000);
  if (minutes < 1) return "now";
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor(minutes / 60) % 24;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${minutes}m`;
}

type PlanUsageState = {
  /** The last read with plan limits; kept while later reads fail or are refused. */
  usage: PlanUsage | null;
  /** When `usage` was read, unix milliseconds. */
  fetchedAt: number | null;
  isLoading: boolean;
  /** The last failed read; cleared by the next successful one. */
  error: string | null;
  /** Unix milliseconds until which the usage endpoint refuses reads for too many requests; no read starts before. */
  blockedUntil: number | null;
  /** Reads the usage at most once per `REFRESH_INTERVAL_MS`; never two reads at once. */
  refresh: () => void;
  /** Refreshes when nothing was read yet or the last read is older than `STALE_AFTER_MS`. */
  refreshIfStale: () => void;
  /** Drops the usage of the previous Claude account, including a running read and its refusal, and reads it again. */
  switchAccount: () => void;
};

/** The claude.ai plan limits (5-hour, weekly, weekly per model), shared by the whole main window. */
export const usePlanUsageStore = create<PlanUsageState>()((set, get) => {
  let lastStartedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by `switchAccount`; a read that started before applies nothing. */
  let generation = 0;

  async function load() {
    const { isLoading, blockedUntil } = get();
    if (isLoading) return;
    if (blockedUntil && Date.now() < blockedUntil) {
      scheduleLoad(blockedUntil - Date.now());
      return;
    }
    const readGeneration = generation;
    lastStartedAt = Date.now();
    set({ isLoading: true });
    try {
      const usage = await commands.getPlanUsage();
      if (readGeneration !== generation) return;
      if (usage.retryAfterSeconds) {
        set({ isLoading: false, blockedUntil: Date.now() + usage.retryAfterSeconds * 1000 });
        scheduleLoad(usage.retryAfterSeconds * 1000);
        return;
      }
      if (usage.windows.length === 0 && get().usage) {
        set({ isLoading: false, blockedUntil: null, error: "the last read returned no plan limits" });
        return;
      }
      set({ usage, fetchedAt: Date.now(), isLoading: false, error: null, blockedUntil: null });
    } catch (error) {
      if (readGeneration !== generation) return;
      set({ isLoading: false, error: String(error) });
    }
  }

  /** Starts a read after `delay` milliseconds unless one is scheduled already. */
  function scheduleLoad(delay: number) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void load();
    }, delay);
  }

  function cancelTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  return {
    usage: null,
    fetchedAt: null,
    isLoading: false,
    error: null,
    blockedUntil: null,
    refresh: () => {
      if (timer) return;
      const delay = refreshDelay(lastStartedAt, Date.now());
      if (delay === 0) {
        void load();
        return;
      }
      scheduleLoad(delay);
    },
    refreshIfStale: () => {
      const { fetchedAt, refresh } = get();
      if (fetchedAt && Date.now() - fetchedAt < STALE_AFTER_MS) return;
      refresh();
    },
    switchAccount: () => {
      generation++;
      cancelTimer();
      lastStartedAt = null;
      set({ usage: null, fetchedAt: null, isLoading: false, error: null, blockedUntil: null });
      void load();
    },
  };
});
