import type { SwfStepFile } from "../sessions/swf-pipeline.types";

/** The runs that can be opened: those with a step result or a transcript. */
export function openableRuns(steps: readonly SwfStepFile[], transcripts: readonly SwfStepFile[]): Set<number> {
  return new Set([...steps, ...transcripts].map((file) => file.n));
}

/** The run the Factory tab shows: the selected one while it can be opened, else the latest run that can, null when none can. */
export function shownRun(selected: number | null, openable: ReadonlySet<number>): number | null {
  if (selected !== null && openable.has(selected)) return selected;
  return openable.size > 0 ? Math.max(...openable) : null;
}
