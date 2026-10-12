import { useEffect, useState } from "react";
import type { ReviewLevel } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { TAB_ACTIVE, TAB_INACTIVE } from "../ui/buttons";
import { REVIEW_LABELS, ReviewBars } from "./nodes";

const LEVELS: ReviewLevel[] = [1, 2, 3, 4];

const GLOB_HELP =
  "Hides files whose path relative to the repository root matches one of these globs, separated by commas or spaces. A glob without a slash matches the file name in any folder, ** spans folders. Enter applies, Escape restores.";

/**
 * The relevance and glob filters of the dependency graph's toolbar, each preceded by a divider, stored in the settings
 * for every session. Four segments pick the lowest review rating shown, the first shows every file; they are disabled
 * while no file has a rating (`hasRatings`). The field applies its globs on Enter or when it is left; Escape restores
 * the applied text, a second Escape leaves the field.
 */
export function GraphFilters({ hasRatings }: { hasRatings: boolean }) {
  const filter = useSettingsStore((state) => state.graphFilter);
  const setGraphFilter = useSettingsStore((state) => state.setGraphFilter);
  const [draft, setDraft] = useState(filter.hiddenGlobs);

  useEffect(() => setDraft(filter.hiddenGlobs), [filter.hiddenGlobs]);

  return (
    <>
      <ToolbarDivider />
      <div className="flex shrink-0 items-center gap-1.5" title={hasRatings ? undefined : "Generate the diagram to filter by the agent's review rating"}>
        <span className="text-neutral-500">Min. relevance</span>
        <div className="flex h-7 items-center gap-0.5 rounded-md border border-white/10 bg-white/4 p-0.5">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              disabled={!hasRatings}
              aria-pressed={filter.minReview === level}
              onClick={() => setGraphFilter({ minReview: level })}
              title={level === 1 ? "Show every file" : `Show files rated ${level} (${REVIEW_LABELS[level]}) or higher; files without a rating stay`}
              className={`flex h-full w-7 items-center justify-center rounded transition-colors disabled:pointer-events-none disabled:opacity-40 ${filter.minReview === level ? TAB_ACTIVE : TAB_INACTIVE}`}
            >
              <ReviewBars level={level} className="pointer-events-none size-3.5" />
            </button>
          ))}
        </div>
      </div>
      <ToolbarDivider />
      <label className="flex min-w-0 items-center gap-1.5" title={GLOB_HELP}>
        <span className="shrink-0 text-neutral-500">Hide files</span>
        <input
          type="text"
          value={draft}
          spellCheck={false}
          placeholder="e.g. *.spec.ts"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft.trim() !== filter.hiddenGlobs) {
              setGraphFilter({ hiddenGlobs: draft });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (draft !== filter.hiddenGlobs) {
                setDraft(filter.hiddenGlobs);
              } else {
                event.currentTarget.blur();
              }
            }
          }}
          className="h-7 w-80 min-w-28 rounded-md border border-white/10 bg-(--surface-input) px-2 font-mono text-[13px] text-neutral-200 outline-none placeholder:font-sans placeholder:text-neutral-500 focus:border-white/20"
        />
      </label>
    </>
  );
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="h-4 w-px shrink-0 bg-white/10" />;
}
