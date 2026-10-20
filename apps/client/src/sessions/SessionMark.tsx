import { hasPendingQuestion, useHuntStore } from "../state/store";
import { runsOnVm } from "./remoteOrigin";

const HEIGHT = 18;
/** Extra width per character beyond the first, so `B2` stretches the circle into a pill. */
const CHARACTER_WIDTH = 7;
/** Baseline that centres capitals and digits: half the height plus half the cap height (~0.7 em at 11px). */
const BASELINE = HEIGHT / 2 + 3.85;
/** Share of the outline the spinner arc covers. */
const SPINNER_ARC = 0.3;
/** Radius of the question badge at the top right corner. */
const BADGE_RADIUS = 5.5;
/** Radius of the unseen-response dot at the top right corner. */
const DOT_RADIUS = 4;

/** The colour of a mark: blue for a session that runs on a VM, grey for one that runs here. */
export type MarkTone = "remote" | "idle";

/** The badge at a mark's top right corner: a `?` while the agent waits for an answer, a dot for an unseen response. */
export type MarkBadge = "question" | "unseen" | null;

/**
 * Circle with a session's mark (A, B, … for sessions, 1, 2, … for sub sessions), showing the state of its agent from
 * the store: while the agent works, an arc runs around the outline; a session on a VM is blue (its sub sessions run
 * here and stay grey); an agent that ended its turn with a question adds an amber `?` badge at the corner, otherwise a
 * response the user has not looked at yet adds a green dot there.
 */
export function SessionMark({ sessionId, mark, title }: { sessionId: string; mark: string; title?: string }) {
  const isBusy = useHuntStore((state) => state.chats[sessionId]?.isBusy ?? false);
  const hasQuestion = useHuntStore((state) => {
    const chat = state.chats[sessionId];
    // A chat that was never loaded shows what the gateway recorded about the session's agent.
    if (!chat || chat.items.length === 0) return state.sessions.find((session) => session.id === sessionId)?.remote?.agent === "question";
    return hasPendingQuestion(chat);
  });
  const isRemote = useHuntStore((state) => runsOnVm(sessionId, state.sessions));
  const hasUnseenActivity = useHuntStore((state) => state.activeSessionId !== sessionId && (state.chats[sessionId]?.hasUnseenActivity ?? false));
  const badge = hasQuestion ? "question" : hasUnseenActivity ? "unseen" : null;
  return <MarkGlyph mark={mark} isBusy={isBusy} badge={badge} tone={isRemote ? "remote" : "idle"} label={title ?? mark} title={title} />;
}

/**
 * The drawing of a mark from a given state, for `SessionMark` and for sessions the store does not know (the start
 * view's list of session VMs). A mark longer than one character, e.g. `B2` for another session's sub session,
 * stretches into a pill. Drawn as one SVG so outline and text share the same sub-pixel offset; HTML text snaps its
 * baseline to whole pixels and drifts. `label` names the session for assistive technology.
 */
export function MarkGlyph({
  mark,
  isBusy,
  badge,
  tone,
  label,
  title,
}: {
  mark: string;
  isBusy: boolean;
  badge: MarkBadge;
  tone: MarkTone;
  label: string;
  title?: string;
}) {
  const width = HEIGHT + Math.max(0, mark.length - 1) * CHARACTER_WIDTH;
  const diameter = HEIGHT - 1;
  // Outline length of the rounded rect: two straight edges plus one full circle from the two caps.
  const perimeter = 2 * (width - HEIGHT) + Math.PI * diameter;
  const state = isBusy ? "agent is working" : badge === "question" ? "waiting for an answer" : badge === "unseen" ? "unseen response" : tone === "remote" ? "on a VM" : null;
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
      {badge === "question" ? (
        <QuestionBadge cx={width - 1.5} cy={1.5} />
      ) : badge === "unseen" ? (
        <circle cx={width - 1.5} cy={1.5} r={DOT_RADIUS} className="fill-emerald-400" aria-hidden="true" />
      ) : null}
    </svg>
  );
}

const TEXT = { remote: "text-sky-300", idle: "text-neutral-300" };
const OUTLINE = {
  remote: "fill-sky-400/15 stroke-sky-400/60",
  idle: "",
};
const SPINNER = { remote: "stroke-sky-300", idle: "stroke-neutral-200" };

/** The amber `?` badge of an agent that waits for an answer, centred on (`cx`, `cy`) inside an SVG. */
function QuestionBadge({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g aria-hidden="true">
      <circle cx={cx} cy={cy} r={BADGE_RADIUS} className="fill-amber-400" />
      <text x={cx} y={cy + 3.3} textAnchor="middle" className="fill-neutral-950 text-[9.5px] font-bold">
        ?
      </text>
    </g>
  );
}

/** The question badge of a session mark as a standalone icon, for text that says the agent waits for an answer. */
export function QuestionIcon() {
  const size = 2 * BADGE_RADIUS;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden="true">
      <QuestionBadge cx={BADGE_RADIUS} cy={BADGE_RADIUS} />
    </svg>
  );
}
