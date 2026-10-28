import type { ReviewLevel } from "../common/diagram/diagram.types";

/** Bar color per review level: red for files that need little review up to green for those that need a close look. */
const REVIEW_COLORS: Record<ReviewLevel, string> = { 1: "#f87171", 2: "#fb923c", 3: "#facc15", 4: "#4ade80" };

/** What each review level means, for tooltips and the legend. */
export const REVIEW_LABELS: Record<ReviewLevel, string> = { 1: "little review needed", 2: "some review", 3: "review recommended", 4: "needs close review" };

/**
 * The agent's review rating as a signal-strength icon: four bars rising from left to right, of which `level` are lit
 * in the level's color, red for 1 up to green for 4. The tooltip states the level and the agent's reason.
 */
export function ReviewBars({ level, reason, className = "size-3.5" }: { level: ReviewLevel; reason?: string; className?: string }) {
  const title = `Review ${level}/4: ${REVIEW_LABELS[level]}${reason ? ` — ${reason}` : ""}`;
  return (
    <svg viewBox="0 0 15 12" className={`${className} shrink-0`} role="img" aria-label={title}>
      <title>{title}</title>
      {[0, 1, 2, 3].map((bar) => (
        <rect key={bar} x={bar * 4} y={9 - bar * 3} width="3" height={3 + bar * 3} rx="0.75" fill={bar < level ? REVIEW_COLORS[level] : "rgba(255,255,255,0.14)"} />
      ))}
    </svg>
  );
}
