import { useEffect, useState } from "react";
import type { SessionChat } from "../state/store";
import { formatElapsed, REMOTE_STEP_LABELS, remoteOperation, remotePosition } from "./remoteSession";

/** The current time in ms, renewed every second while the component is mounted. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Where the remote operation of `chat` is among its steps; `null` before it reached one of them. */
function progressOf(chat: SessionChat) {
  return chat.remoteRun ? remotePosition(remoteOperation(chat), chat.remoteRun.steps) : null;
}

/**
 * The step a remote operation of `chat` runs, `Waiting for the VM…  3 of 7 · 1:12` with the step's run time, a bar with a
 * segment per step and, with `showsDetail`, the gateway's last log line about the step. Nothing while no step runs.
 */
export function RemoteStepProgress({ chat, showsDetail = false }: { chat: SessionChat; showsDetail?: boolean }) {
  const now = useNow();
  if (!chat.remoteStep) return null;
  const progress = progressOf(chat);
  const stepStartedAt = chat.remoteRun?.stepStartedAt ?? null;
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span>{REMOTE_STEP_LABELS[chat.remoteStep]}</span>
        {progress && stepStartedAt !== null ? (
          <span className="shrink-0 text-[13px] tabular-nums">
            {progress.position} of {progress.total} · {formatElapsed(now - stepStartedAt)}
          </span>
        ) : null}
      </div>
      {progress ? (
        <div aria-hidden="true" className="mt-1.5 flex gap-1">
          {Array.from({ length: progress.total }, (_, index) => (
            <span key={index} className={`h-1 w-6 rounded-full ${segmentColor(index + 1, progress.position)}`} />
          ))}
        </div>
      ) : null}
      {showsDetail && chat.remoteDetail ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-snug">{chat.remoteDetail}</pre>
      ) : null}
    </div>
  );
}

/** The color of the bar segment of step `step` (1-based) while step `position` runs. */
function segmentColor(step: number, position: number): string {
  if (step < position) return "bg-neutral-500";
  if (step === position) return "animate-pulse bg-sky-400";
  return "bg-white/10";
}
