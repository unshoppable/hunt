import { useHuntStore } from "../state/store";

const HEIGHT = 18;
/** Extra width per character beyond the first, so `B2` stretches the circle into a pill. */
const CHARACTER_WIDTH = 7;
/** Baseline that centres capitals and digits: half the height plus half the cap height (~0.7 em at 11px). */
const BASELINE = HEIGHT / 2 + 3.85;
/** Share of the outline the spinner arc covers. */
const SPINNER_ARC = 0.3;

/**
 * Circle with a session's mark (A, B, … for sessions, 1, 2, … for sub sessions). While the agent works, an arc runs
 * around the outline; a response the user has not looked at yet turns the mark green. A mark longer than one
 * character, e.g. `B2` for another session's sub session, stretches into a pill. Drawn as one SVG so outline and text
 * share the same sub-pixel offset; HTML text snaps its baseline to whole pixels and drifts.
 */
export function SessionMark({ sessionId, mark, title }: { sessionId: string; mark: string; title?: string }) {
  const isBusy = useHuntStore((state) => state.chats[sessionId]?.isBusy ?? false);
  const hasUnseenActivity = useHuntStore((state) => state.activeSessionId !== sessionId && (state.chats[sessionId]?.hasUnseenActivity ?? false));
  const width = HEIGHT + Math.max(0, mark.length - 1) * CHARACTER_WIDTH;
  const diameter = HEIGHT - 1;
  // Outline length of the rounded rect: two straight edges plus one full circle from the two caps.
  const perimeter = 2 * (width - HEIGHT) + Math.PI * diameter;
  const label = title ?? mark;
  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      className={`shrink-0 ${hasUnseenActivity ? "text-emerald-300" : "text-neutral-300"}`}
      role="img"
      aria-label={isBusy ? `${label}, agent is working` : hasUnseenActivity ? `${label}, unseen response` : label}
    >
      {title ? <title>{title}</title> : null}
      <rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={diameter}
        rx={diameter / 2}
        className={hasUnseenActivity ? "fill-emerald-400/15 stroke-emerald-400/60" : `fill-white/5 ${isBusy ? "stroke-neutral-700" : "stroke-neutral-500"}`}
      />
      {isBusy ? (
        <rect
          x={0.5}
          y={0.5}
          width={width - 1}
          height={diameter}
          rx={diameter / 2}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${perimeter * SPINNER_ARC} ${perimeter * (1 - SPINNER_ARC)}`}
          className={hasUnseenActivity ? "stroke-emerald-300" : "stroke-neutral-200"}
        >
          <animate attributeName="stroke-dashoffset" from={0} to={-perimeter} dur="1s" repeatCount="indefinite" />
        </rect>
      ) : null}
      <text x={width / 2} y={BASELINE} textAnchor="middle" fill="currentColor" className="text-[11px] font-normal">
        {mark}
      </text>
    </svg>
  );
}
