import { useHuntStore } from "../state/store";

const HEIGHT = 18;
/** Extra width per character beyond the first, so `B2` stretches the circle into a pill. */
const CHARACTER_WIDTH = 7;
/** Baseline that centres capitals and digits: half the height plus half the cap height (~0.7 em at 11px). */
const BASELINE = HEIGHT / 2 + 3.85;

/**
 * Circle with a session's mark (A, B, … for sessions, 1, 2, … for sub sessions); green while the session waits for the
 * agent's response. A mark longer than one character, e.g. `B2` for another session's sub session, stretches into a
 * pill. Drawn as one SVG so outline and text share the same sub-pixel offset; HTML text snaps its baseline to whole
 * pixels and drifts.
 */
export function SessionMark({ sessionId, mark, title }: { sessionId: string; mark: string; title?: string }) {
  const isBusy = useHuntStore((state) => state.chats[sessionId]?.isBusy ?? false);
  const width = HEIGHT + Math.max(0, mark.length - 1) * CHARACTER_WIDTH;
  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      className={`shrink-0 ${isBusy ? "text-emerald-300" : "text-neutral-300"}`}
      role="img"
      aria-label={isBusy ? `${title ?? mark}, agent is working` : (title ?? mark)}
    >
      {title ? <title>{title}</title> : null}
      <rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={HEIGHT - 1}
        rx={(HEIGHT - 1) / 2}
        className={isBusy ? "fill-emerald-400/15 stroke-emerald-400/60" : "fill-white/5 stroke-neutral-500"}
      />
      <text x={width / 2} y={BASELINE} textAnchor="middle" fill="currentColor" className="text-[11px] font-normal">
        {mark}
      </text>
    </svg>
  );
}
