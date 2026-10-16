import { hasPendingQuestion, useHuntStore } from "../state/store";

const HEIGHT = 18;
/** Extra width per character beyond the first, so `B2` stretches the circle into a pill. */
const CHARACTER_WIDTH = 7;
/** Baseline that centres capitals and digits: half the height plus half the cap height (~0.7 em at 11px). */
const BASELINE = HEIGHT / 2 + 3.85;
/** Share of the outline the spinner arc covers. */
const SPINNER_ARC = 0.3;
/** Radius of the question badge at the top right corner. */
const BADGE_RADIUS = 4.5;

/** The colour of a mark: amber while the agent waits for an answer, green for a response the user has not looked at yet. */
export type MarkTone = "question" | "unseen" | "idle";

/**
 * Circle with a session's mark (A, B, … for sessions, 1, 2, … for sub sessions), showing the state of its agent from
 * the store: while the agent works, an arc runs around the outline; an agent that ended its turn with a question
 * turns the mark amber with a `?` badge at the corner, a response the user has not looked at yet turns it green.
 */
export function SessionMark({ sessionId, mark, title }: { sessionId: string; mark: string; title?: string }) {
  const isBusy = useHuntStore((state) => state.chats[sessionId]?.isBusy ?? false);
  const hasQuestion = useHuntStore((state) => {
    const chat = state.chats[sessionId];
    // A chat that was never loaded shows what the gateway recorded about the session's agent.
    if (!chat || chat.items.length === 0) return state.sessions.find((session) => session.id === sessionId)?.remote?.agent === "question";
    return hasPendingQuestion(chat);
  });
  const hasUnseenActivity = useHuntStore((state) => state.activeSessionId !== sessionId && (state.chats[sessionId]?.hasUnseenActivity ?? false));
  const tone = hasQuestion ? "question" : hasUnseenActivity ? "unseen" : "idle";
  return <MarkGlyph mark={mark} isBusy={isBusy} tone={tone} label={title ?? mark} title={title} />;
}

/**
 * The drawing of a mark from a given state, for `SessionMark` and for sessions the store does not know (the start
 * view's list of session VMs). A mark longer than one character, e.g. `B2` for another session's sub session,
 * stretches into a pill. Drawn as one SVG so outline and text share the same sub-pixel offset; HTML text snaps its
 * baseline to whole pixels and drifts. `label` names the session for assistive technology.
 */
export function MarkGlyph({ mark, isBusy, tone, label, title }: { mark: string; isBusy: boolean; tone: MarkTone; label: string; title?: string }) {
  const width = HEIGHT + Math.max(0, mark.length - 1) * CHARACTER_WIDTH;
  const diameter = HEIGHT - 1;
  // Outline length of the rounded rect: two straight edges plus one full circle from the two caps.
  const perimeter = 2 * (width - HEIGHT) + Math.PI * diameter;
  const state = isBusy ? "agent is working" : tone === "question" ? "waiting for an answer" : tone === "unseen" ? "unseen response" : null;
  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      overflow="visible"
      className={`shrink-0 ${TEXT[tone]}`}
      role="img"
      aria-label={state ? `${label}, ${state}` : label}
    >
      {title ? <title>{title}</title> : null}
      <rect x={0.5} y={0.5} width={width - 1} height={diameter} rx={diameter / 2} className={tone === "idle" ? `fill-white/5 ${isBusy ? "stroke-neutral-700" : "stroke-neutral-500"}` : OUTLINE[tone]} />
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
          className={SPINNER[tone]}
        >
          <animate attributeName="stroke-dashoffset" from={0} to={-perimeter} dur="1s" repeatCount="indefinite" />
        </rect>
      ) : null}
      <text x={width / 2} y={BASELINE} textAnchor="middle" fill="currentColor" className="text-[11px] font-normal">
        {mark}
      </text>
      {tone === "question" ? (
        <g aria-hidden="true">
          <circle cx={width - 1.5} cy={1.5} r={BADGE_RADIUS} className="fill-amber-400" />
          <text x={width - 1.5} y={1.5 + 2.6} textAnchor="middle" className="fill-neutral-950 text-[7.5px] font-bold">
            ?
          </text>
        </g>
      ) : null}
    </svg>
  );
}

const TEXT = { question: "text-amber-300", unseen: "text-emerald-300", idle: "text-neutral-300" };
const OUTLINE = { question: "fill-amber-400/15 stroke-amber-400/60", unseen: "fill-emerald-400/15 stroke-emerald-400/60", idle: "" };
const SPINNER = { question: "stroke-amber-300", unseen: "stroke-emerald-300", idle: "stroke-neutral-200" };
