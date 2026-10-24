import { useEffect, useState } from "react";
import { EMPTY_CHECKS, useChecksStore } from "../state/checks";
import { useHuntStore } from "../state/store";
import { AgentButton } from "../ui/AgentButton";
import { HEADER_BAR } from "../ui/bars";
import { GHOST_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { CheckIcon, CloseIcon, Spinner } from "../ui/icons";
import type { Tone } from "../preview/services";
import { CheckOutput } from "./CheckOutput";
import { checkRows, describeCheck, describeChecks, isAnyCheckRunning, type CheckRow } from "./checks";

/** How often the durations of running checks count up. */
const CLOCK_TICK_MS = 1000;

const HINT = "leading-snug text-neutral-500";

const TONE_COLOR: Record<Tone, string> = {
  ok: "text-green-300",
  pending: "text-neutral-300",
  warning: "text-amber-300",
  error: "text-red-300",
  idle: "text-neutral-400",
};

const EXAMPLE = `"checks": {
  "typecheck": { "command": "npm run typecheck" },
  "lint": { "command": "npm run lint", "cwd": "apps/web" }
}`;

/**
 * The Checks tab of a session: the checks of the worktree's hunt.json (lint, typecheck, test, …) with the state of their
 * last run, run one by one or all at once, locally or on the session's VM; below them the output of the selected
 * check, by default of the first one that runs or failed. A result that started on another state of the worktree reads
 * as outdated. A failed check goes to the agent with the end of its output. Reads the checks again when the agent
 * edits files and when the window gets the focus.
 */
export function ChecksPanel({ sessionId }: { sessionId: string }) {
  const checks = useChecksStore((state) => state.checks[sessionId] ?? EMPTY_CHECKS);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const { refresh, run, runAll, cancel, cancelAll, sendFailure, setUp } = useChecksStore.getState();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const isRunning = isAnyCheckRunning(checks.status);
  const now = useClock(isRunning);

  useEffect(() => {
    void refresh(sessionId);
  }, [sessionId, editVersion, refresh]);

  useEffect(() => {
    const onFocus = () => void refresh(sessionId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sessionId, refresh]);

  const rows = checkRows(checks.status);
  const summary = describeChecks(rows);
  const shownRow =
    rows.find((row) => row.definition.name === selectedName) ??
    rows.find((row) => row.run?.state === "running") ??
    rows.find((row) => row.run?.state === "failed" && !row.isOutdated) ??
    null;
  const problem = checks.status?.problem ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Checks</span>
        {rows.length ? <span className={`min-w-0 truncate text-[13px] ${TONE_COLOR[summary.tone]}`}>{summary.text}</span> : null}
        <span className="flex-1" />
        {checks.isRefreshing ? <Spinner /> : null}
        {rows.length ? (
          isRunning ? (
            <button type="button" onClick={() => cancelAll(sessionId)} className={SECONDARY_BUTTON_XS}>
              Stop all
            </button>
          ) : (
            <button type="button" onClick={() => runAll(sessionId)} className={SECONDARY_BUTTON_XS}>
              Run all
            </button>
          )
        ) : null}
      </div>

      {checks.error ? <p className="shrink-0 px-4 pt-3 text-[13px] leading-snug break-words text-red-300">{checks.error}</p> : null}
      {problem ? <p className="shrink-0 px-4 pt-3 text-[13px] leading-snug break-words text-red-300">{problem}</p> : null}

      {checks.status && !rows.length && !problem ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-[13px] text-neutral-300">
          <p className={HINT}>
            The repository's hunt.json declares no checks. Checks are the commands that typecheck, lint, test or build it; this tab runs them in the
            session's worktree and shows whether they pass.
          </p>
          <pre className="rounded-md bg-white/4 px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-300">{EXAMPLE}</pre>
          <div>
            <AgentButton label="Set up checks" title="Ask the agent to declare the checks in hunt.json" aria-label="Set up checks" onClick={() => setUp(sessionId)} />
          </div>
        </div>
      ) : null}

      {rows.length ? (
        <>
          <div className="flex max-h-[45%] shrink-0 flex-col overflow-y-auto py-1.5 text-[13px]">
            {rows.map((row) => (
              <CheckRowView
                key={row.definition.name}
                row={row}
                now={now}
                isSelected={row === shownRow}
                onSelect={() => setSelectedName(row.definition.name)}
                onRun={() => run(sessionId, row.definition.name)}
                onCancel={() => cancel(sessionId, row.definition.name)}
                onSendFailure={() => void sendFailure(sessionId, row.definition.name)}
              />
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-(--line)">
            {shownRow?.run ? (
              <CheckOutput key={`${shownRow.definition.name}:${shownRow.run.run}`} sessionId={sessionId} name={shownRow.definition.name} run={shownRow.run.run} />
            ) : (
              <p className={`px-4 py-3 text-[13px] ${HINT}`}>{shownRow ? "This check has not run yet." : "Select a check to see its output."}</p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** A check: its state, name and command, how its last run went, and the buttons to run or stop it and to send a failure to the agent. */
function CheckRowView({
  row,
  now,
  isSelected,
  onSelect,
  onRun,
  onCancel,
  onSendFailure,
}: {
  row: CheckRow;
  now: number;
  isSelected: boolean;
  onSelect: () => void;
  onRun: () => void;
  onCancel: () => void;
  onSendFailure: () => void;
}) {
  const { definition, run } = row;
  const description = describeCheck(row, now);
  const isRunning = run?.state === "running";
  return (
    <div className="tree-row flex h-9 min-w-0 shrink-0 cursor-default items-center gap-2.5 px-4" data-selected={isSelected} onClick={onSelect}>
      <StateIcon row={row} />
      <span className="shrink-0 font-mono text-neutral-100">{definition.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-neutral-500" title={definition.cwd ? `${definition.command} (in ${definition.cwd})` : definition.command}>
        {definition.command}
      </span>
      <span className={`shrink-0 ${TONE_COLOR[description.tone]}`}>{description.text}</span>
      {run?.state === "failed" ? (
        <AgentButton
          title="Send the failure to the agent"
          aria-label="Send the failure to the agent"
          onClick={(event) => {
            event.stopPropagation();
            onSendFailure();
          }}
        />
      ) : null}
      <button
        type="button"
        className={`${GHOST_BUTTON_XS} w-14 justify-center`}
        onClick={(event) => {
          event.stopPropagation();
          if (isRunning) {
            onCancel();
          } else {
            onRun();
          }
        }}
      >
        {isRunning ? "Stop" : "Run"}
      </button>
    </div>
  );
}

function StateIcon({ row }: { row: CheckRow }) {
  const state = row.run?.state;
  if (state === "running") return <Spinner className="size-3.5 shrink-0" />;
  if (state === "passed") return <CheckIcon className={`size-3.5 shrink-0 ${row.isOutdated ? "text-neutral-500" : "text-emerald-400"}`} />;
  if (state === "failed") return <CloseIcon className={`size-3.5 shrink-0 ${row.isOutdated ? "text-neutral-500" : "text-red-400"}`} />;
  return <span className="mx-[3px] size-2 shrink-0 rounded-full bg-neutral-600" />;
}

/** The time now, in milliseconds since the epoch; while `isTicking`, it renews every `CLOCK_TICK_MS`. */
function useClock(isTicking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!isTicking) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [isTicking]);
  return now;
}
