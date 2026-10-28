import type { ReactNode } from "react";
import { TAB_ACTIVE, TAB_BUTTON, TAB_INACTIVE } from "./buttons.constants";

/** A status dot on a tab: green while something runs there, red when something failed. */
export type TabDot = { tone: "running" | "failed"; title: string };

/**
 * A tab of the inspector; `dot` adds a small status dot after the label, a `commentCount` above 0 a blue badge with
 * that count of review comments, raised to the label's top right corner.
 */
export function TabButton({
  isActive,
  onClick,
  icon,
  label,
  dot = null,
  commentCount = 0,
}: {
  isActive: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  dot?: TabDot | null;
  commentCount?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${TAB_BUTTON} gap-1.5 ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`}
    >
      {icon}
      {label}
      {dot ? <span className={`size-1.5 shrink-0 rounded-full ${dot.tone === "running" ? "bg-green-400" : "bg-red-400"}`} title={dot.title} /> : null}
      {commentCount ? <CountBadge count={commentCount} label={`${commentCount} review ${commentCount === 1 ? "comment" : "comments"}`} /> : null}
    </button>
  );
}

const BADGE_HEIGHT = 16;
/** Extra width per digit beyond the first, so `12` stretches the circle into a pill. */
const BADGE_DIGIT_WIDTH = 6;
/** Baseline that centres digits: half the height plus half their height (~0.7 em at 10px). */
const BADGE_BASELINE = BADGE_HEIGHT / 2 + 3.5;

/**
 * A count in a blue circle, raised like a superscript; more than one digit stretch it into a pill. Drawn as one SVG
 * so circle and digits share the same sub-pixel offset; HTML text snaps its baseline to whole pixels and drifts.
 */
function CountBadge({ count, label }: { count: number; label: string }) {
  const text = count > 99 ? "99+" : String(count);
  const width = BADGE_HEIGHT + (text.length - 1) * BADGE_DIGIT_WIDTH;
  return (
    <svg width={width} height={BADGE_HEIGHT} viewBox={`0 0 ${width} ${BADGE_HEIGHT}`} className="relative -top-1.5 -ml-0.5 shrink-0" role="img" aria-label={label}>
      <title>{label}</title>
      <rect width={width} height={BADGE_HEIGHT} rx={BADGE_HEIGHT / 2} className="fill-blue-600" />
      <text x={width / 2} y={BADGE_BASELINE} textAnchor="middle" className="fill-white text-[10px] font-semibold">
        {text}
      </text>
    </svg>
  );
}
