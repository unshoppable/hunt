import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { ReviewThread } from "../ipc/types";
import { errorText } from "../ui/useLoad";

/** Age after which showing a file loads the review threads again, so that new replies on GitHub show up. */
export const THREADS_STALE_AFTER_MS = 30_000;

/** Outcome of the last load of a pull request's review threads. */
export type ThreadLoad = {
  /** Threads of the last load that succeeded; empty before one did. */
  threads: ReviewThread[];
  /** Message of the last load when it failed, else null. */
  error: string | null;
  loadedAt: number;
};

type ReviewThreadState = {
  /** Last load per review session (a sub session's parent, see `reviewSessionOf`); absent until the first one ends. */
  loads: Record<string, ThreadLoad>;
  /**
   * Loads the review threads of the pull request `reviewSessionId` reviews unless the last load is younger than
   * `THREADS_STALE_AFTER_MS`; `force` loads regardless, after the running load if there is one.
   */
  refresh: (reviewSessionId: string, force?: boolean) => void;
};

/** Review sessions whose threads are loading, each with whether a forced load waits for the running one. */
const running = new Map<string, boolean>();

export const useReviewThreadStore = create<ReviewThreadState>((set, get) => ({
  loads: {},
  refresh: (reviewSessionId, force = false) => {
    if (running.has(reviewSessionId)) {
      if (force) {
        running.set(reviewSessionId, true);
      }
      return;
    }
    const last = get().loads[reviewSessionId];
    if (!force && last && Date.now() - last.loadedAt < THREADS_STALE_AFTER_MS) return;
    running.set(reviewSessionId, false);
    const store = (next: (previous: ThreadLoad | undefined) => ThreadLoad) =>
      set((state) => ({ loads: { ...state.loads, [reviewSessionId]: next(state.loads[reviewSessionId]) } }));
    void commands
      .listReviewThreads(reviewSessionId)
      .then(
        (threads) => store(() => ({ threads, error: null, loadedAt: Date.now() })),
        (reason) => store((previous) => ({ threads: previous?.threads ?? [], error: errorText(reason), loadedAt: Date.now() })),
      )
      .finally(() => {
        const isForcedAgain = running.get(reviewSessionId);
        running.delete(reviewSessionId);
        if (isForcedAgain) {
          get().refresh(reviewSessionId, true);
        }
      });
  },
}));
