import type { UsageWindow } from "../accounts/plan-usage.types";
import { formatTokens } from "../chat/ContextMeter";
import type { RunTokens, SwfStepFile } from "../sessions/swf-pipeline.types";

/** The runs that can be opened: those with a step result or a transcript. */
export function openableRuns(steps: readonly SwfStepFile[], transcripts: readonly SwfStepFile[]): Set<number> {
  return new Set([...steps, ...transcripts].map((file) => file.n));
}

/**
 * The run the Factory tab shows: the selected one while it can be opened or is the `running` one (which shows that it
 * has not reported yet and its conversation as it grows), else the latest run that can be opened, null when none can.
 */
export function shownRun(selected: number | null, openable: ReadonlySet<number>, running: number | null = null): number | null {
  if (selected !== null && (openable.has(selected) || selected === running)) return selected;
  return openable.size > 0 ? Math.max(...openable) : null;
}

/** Token counts of one run or of several summed up. */
export type TokenCounts = Omit<RunTokens, "n">;

/** The token counts of `runs` summed up, for the total row of the run list. */
export function sumTokens(runs: readonly RunTokens[]): TokenCounts {
  return runs.reduce(
    (sum, run) => ({ input: sum.input + run.input, cacheWrite: sum.cacheWrite + run.cacheWrite, cacheRead: sum.cacheRead + run.cacheRead, output: sum.output + run.output }),
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  );
}

/** All tokens a run used: input, cache writes, cache reads and output. */
export function totalTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output;
}

/** The tokens a run paid for in full: everything but the cache reads, i.e. input, cache writes and output. */
export function uncachedTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheWrite + tokens.output;
}

/** The kinds of tokens a run used, for the tooltip of its total: `Input 1k · cache write 1.4M · cache read 215M · output 475k`. */
export function tokensTitle(tokens: TokenCounts): string {
  return `Input ${formatTokens(tokens.input)} · cache write ${formatTokens(tokens.cacheWrite)} · cache read ${formatTokens(tokens.cacheRead)} · output ${formatTokens(tokens.output)}`;
}

/**
 * The model and effort a step's conversation runs with, as the pipeline's step settings name them: `opus-5-5 · high`,
 * without the `claude-` prefix; `default` for what Claude Code picks itself, null for a step without an agent setting.
 */
export function modelText(setting: { model: string | null; effort: string | null } | undefined): string | null {
  if (!setting) return null;
  return `${setting.model?.replace(/^claude-/, "") ?? "default"} · ${setting.effort ?? "default"}`;
}

/** The plan limits that count every model, not one. */
const ALL_MODELS_WINDOWS = new Set(["5h", "Week"]);

/**
 * The weekly plan limits of the models the pipeline's runs used, in the order of `windows`: the window of each model
 * whose id contains its name (`claude-fable-5-1` → `Fable`), and the weekly limit of all models for a model without a
 * window of its own or Claude Code's default (null), whose model is unknown.
 */
export function runModelWindows(windows: readonly UsageWindow[], models: readonly (string | null)[]): UsageWindow[] {
  const shown = new Set<string>();
  for (const model of new Set(models)) {
    const own = model === null ? undefined : windows.find((window) => !ALL_MODELS_WINDOWS.has(window.label) && model.toLowerCase().includes(window.label.toLowerCase()));
    shown.add(own?.label ?? "Week");
  }
  return windows.filter((window) => shown.has(window.label));
}
