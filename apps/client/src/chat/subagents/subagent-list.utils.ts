import type { SubagentChat, SubagentState } from "../chat.types";

/** A subagent as the agent strip lists it: `depth` 0 for one the main agent started, 1 for one that subagent started, … */
export type ListedSubagent = { subagent: SubagentChat; depth: number };

/**
 * The subagents the chat shows, each after the agent that started it, in the order they started; hidden ones (from a
 * turn Hunt sent itself) are left out.
 */
export function listSubagents(subagents: Record<string, SubagentChat>): ListedSubagent[] {
  const visible = Object.values(subagents).filter((subagent) => !subagent.isHidden);
  const children = new Map<string, SubagentChat[]>();
  const roots: SubagentChat[] = [];
  for (const subagent of visible) {
    if (subagents[subagent.parentSessionId]) {
      children.set(subagent.parentSessionId, [...(children.get(subagent.parentSessionId) ?? []), subagent]);
    } else {
      roots.push(subagent);
    }
  }
  const listed: ListedSubagent[] = [];
  const visit = (subagent: SubagentChat, depth: number) => {
    listed.push({ subagent, depth });
    for (const child of children.get(subagent.sessionId) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  return listed;
}

/**
 * The agent `step` places after `selected` in the strip's order (main agent first, `null`), wrapping around; the main
 * agent when `selected` is gone.
 */
export function steppedAgent(listed: ListedSubagent[], selected: string | null, step: 1 | -1): string | null {
  const order = [null, ...listed.map(({ subagent }) => subagent.sessionId)];
  const index = Math.max(0, order.indexOf(selected));
  return order[(index + step + order.length) % order.length];
}

/** The name a subagent shows: its title, else the first line of its task. */
export function subagentName(subagent: SubagentChat): string {
  return subagent.title || subagent.description.split("\n")[0] || "Subagent";
}

/** Status dot per subagent state, like a tool call's: pulsing while it works, red when it did not complete. */
export const SUBAGENT_DOT: Record<SubagentState, string> = {
  running: "bg-sky-400 animate-pulse",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  cancelled: "bg-neutral-500",
  disconnected: "bg-neutral-500",
};

export const SUBAGENT_STATE_LABELS: Record<SubagentState, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  disconnected: "Ended",
};

/** A duration as `42s` or `3m 05s`. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
