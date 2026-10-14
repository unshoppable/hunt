import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { PlanUsage } from "../ipc/types";

/** Minimum time between two automatic refreshes; turns ending sooner share one trailing refresh. */
export const REFRESH_INTERVAL_MS = 60_000;
/** Age after which regaining window focus refreshes the usage. */
export const STALE_AFTER_MS = 5 * 60_000;


/** Milliseconds to wait before an automatic refresh may start; 0 starts it now. */
export function refreshDelay(lastStartedAt: number | null, now: number): number {
  if (lastStartedAt === null) return 0;
  return Math.max(0, lastStartedAt + REFRESH_INTERVAL_MS - now);
}

/** Catppuccin Mocha green, yellow, peach and red at the fill levels where each is pure. */
const USAGE_COLOR_STOPS: [percent: number, rgb: [number, number, number]][] = [
  [0, [166, 227, 161]],
  [50, [249, 226, 175]],
  [75, [250, 179, 135]],
  [100, [243, 139, 168]],
];

/** Color of a fill level (0–100), blended along the pastel scale green → yellow → peach → red, as CSS `rgb()`. */
export function usageColor(percent: number): string {
  const level = Math.min(Math.max(percent, 0), 100);
  const upper = USAGE_COLOR_STOPS.findIndex(([stop]) => stop >= level);
  if (upper <= 0) return toRgb(USAGE_COLOR_STOPS[0][1]);
  const [fromStop, from] = USAGE_COLOR_STOPS[upper - 1];
  const [toStop, to] = USAGE_COLOR_STOPS[upper];
  const ratio = (level - fromStop) / (toStop - fromStop);
  return toRgb([0, 1, 2].map((channel) => from[channel] + (to[channel] - from[channel]) * ratio));
}

function toRgb(rgb: number[]): string {
  return `rgb(${rgb.map(Math.round).join(" ")})`;
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
  usage: PlanUsage | null;
  /** When `usage` was read, unix milliseconds. */
  fetchedAt: number | null;
  isLoading: boolean;
  /** The last failed read; cleared by the next successful one. */
  error: string | null;
  /** Reads the usage now with `force`, otherwise at most once per `REFRESH_INTERVAL_MS`; never two reads at once. */
  refresh: (force?: boolean) => void;
  /** Refreshes when nothing was read yet or the last read is older than `STALE_AFTER_MS`. */
  refreshIfStale: () => void;
};

/** The claude.ai plan limits (5-hour, weekly, weekly per model), shared by the whole main window. */
export const usePlanUsageStore = create<PlanUsageState>()((set, get) => {
  let lastStartedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load() {
    if (get().isLoading) return;
    lastStartedAt = Date.now();
    set({ isLoading: true });
    try {
      const usage = await commands.getPlanUsage();
      set({ usage, fetchedAt: Date.now(), isLoading: false, error: null });
    } catch (error) {
      set({ isLoading: false, error: String(error) });
    }
  }

  return {
    usage: null,
    fetchedAt: null,
    isLoading: false,
    error: null,
    refresh: (force = false) => {
      if (force && timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (timer) return;
      const delay = force ? 0 : refreshDelay(lastStartedAt, Date.now());
      if (delay === 0) {
        void load();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, delay);
    },
    refreshIfStale: () => {
      const { fetchedAt, refresh } = get();
      if (fetchedAt && Date.now() - fetchedAt < STALE_AFTER_MS) return;
      refresh();
    },
  };
});
