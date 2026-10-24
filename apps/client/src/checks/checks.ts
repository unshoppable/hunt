import type { CheckDefinition, CheckRun, ChecksStatus } from "../ipc/types";
import type { Description } from "../preview/services";

/** A check of the worktree's hunt.json with its last run, if any, and whether that run started on another state of the worktree. */
export type CheckRow = { definition: CheckDefinition; run: CheckRun | null; isOutdated: boolean };

/** The checks in the order of hunt.json, each with its last run. */
export function checkRows(status: ChecksStatus | null): CheckRow[] {
  if (!status) return [];
  return status.definitions.map((definition) => ({
    definition,
    run: status.runs.find((run) => run.name === definition.name) ?? null,
    isOutdated: status.outdated.includes(definition.name),
  }));
}

/** `milliseconds` as a short duration: `0.4s`, `12s`, `2m 05s`. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** How long `run` took, or has been running at `now` (milliseconds since the epoch). */
export function runDuration(run: CheckRun, now: number): number {
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return end - Date.parse(run.startedAt);
}

/** A check's state as its row in the Checks tab shows it; an outdated result reads in grey. */
export function describeCheck(row: CheckRow, now: number): Description {
  const { run } = row;
  if (!run) return { text: "Not run yet", tone: "idle" };
  const duration = formatDuration(runDuration(run, now));
  const outdated = row.isOutdated && run.state !== "running" ? ", outdated" : "";
  switch (run.state) {
    case "running":
      return { text: `Running · ${duration}`, tone: "pending" };
    case "passed":
      return { text: `Passed in ${duration}${outdated}`, tone: outdated ? "idle" : "ok" };
    case "failed": {
      const exit = run.exitCode === null ? "" : ` (exit ${run.exitCode})`;
      return { text: `Failed${exit} after ${duration}${outdated}`, tone: outdated ? "idle" : "error" };
    }
    case "cancelled":
      return { text: "Stopped", tone: "idle" };
  }
}

/** The checks as the Checks tab's header sums them up: how many passed, failed and run. */
export function describeChecks(rows: CheckRow[]): Description {
  if (!rows.length) return { text: "No checks in hunt.json", tone: "idle" };
  const passed = rows.filter((row) => row.run?.state === "passed").length;
  const failed = rows.filter((row) => row.run?.state === "failed").length;
  const running = rows.filter((row) => row.run?.state === "running").length;
  const parts = [`${passed} of ${rows.length} passed`];
  if (failed) {
    parts.push(`${failed} failed`);
  }
  if (running) {
    parts.push(`${running} running`);
  }
  return { text: parts.join(", "), tone: failed ? "error" : running ? "pending" : passed === rows.length ? "ok" : "idle" };
}

export function isAnyCheckRunning(status: ChecksStatus | null): boolean {
  return Boolean(status?.runs.some((run) => run.state === "running"));
}

/** Most lines of a failed check's output that go to the agent. */
const EXCERPT_LINES = 200;
/** Most characters of a failed check's output that go to the agent. */
const EXCERPT_CHARACTERS = 30_000;

/** Escape sequences of a terminal: CSI (colors, cursor moves), OSC (titles, links) and the two-byte ones. */
const ESCAPE_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * The end of a check's terminal output as plain text for the agent: escape sequences removed, a line overwritten
 * through carriage returns (a progress bar) reduced to what it showed last, and cut to the last `EXCERPT_LINES` lines
 * and `EXCERPT_CHARACTERS` characters.
 */
export function failureExcerpt(output: string): string {
  const lines = output
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).trimEnd());
  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  const text = lines.slice(-EXCERPT_LINES).join("\n");
  return text.length > EXCERPT_CHARACTERS ? text.slice(-EXCERPT_CHARACTERS) : text;
}
