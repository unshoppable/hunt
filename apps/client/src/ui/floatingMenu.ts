/** One choice of a dropdown: `id` is the value it stands for, `name` its label, `description` a muted line below it. */
export type DropdownOption = { id: string; name: string; description?: string | null; isDisabled?: boolean };

/** Fixed-position placement of a floating menu; `maxHeight` caps it to the room on its side of the anchor. */
export type MenuPlacement = { left: number; top: number; maxHeight: number; isAbove: boolean };

type Rect = { left: number; top: number; bottom: number };
type Size = { width: number; height: number };

/** Space between a menu and its anchor. */
const ANCHOR_GAP = 6;
/** Space a menu keeps from the window edges. */
const VIEWPORT_MARGIN = 8;

/**
 * Places a menu of `size` next to `anchor`: below it and left-aligned, or above it when it does not fit below and there
 * is more room above; `forceAbove` fixes the side instead. The menu shifts left to stay inside `viewport` and scrolls
 * when it is taller than the room on its side.
 */
export function placeMenu(anchor: Rect, size: Size, viewport: Size, forceAbove?: boolean): MenuPlacement {
  const roomBelow = viewport.height - anchor.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const roomAbove = anchor.top - ANCHOR_GAP - VIEWPORT_MARGIN;
  const isAbove = forceAbove ?? (size.height > roomBelow && roomAbove > roomBelow);
  const maxHeight = Math.max(0, isAbove ? roomAbove : roomBelow);
  const top = isAbove ? anchor.top - ANCHOR_GAP - Math.min(size.height, maxHeight) : anchor.bottom + ANCHOR_GAP;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, viewport.width - size.width - VIEWPORT_MARGIN));
  return { left, top, maxHeight, isAbove };
}

/**
 * The nearest enabled option after `from` in direction `step`, without wrapping: `from` -1 with step 1 finds the first
 * enabled option, `options.length` with step -1 the last. Stays at `from` when there is none, -1 if `from` is out of range.
 */
export function stepEnabled(options: DropdownOption[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < options.length; index += step) {
    if (!options[index].isDisabled) return index;
  }
  return from >= 0 && from < options.length ? from : -1;
}

/**
 * The first enabled option whose name starts with `query` (case-insensitive), searched from `from` on and wrapping
 * around; -1 when none matches. A one-letter query starts after `from`, so repeating a letter cycles through the options
 * starting with it; a longer one starts at `from`, so typing on refines the current match.
 */
export function findTypeahead(options: DropdownOption[], query: string, from: number): number {
  const needle = query.toLowerCase();
  const start = query.length === 1 ? from + 1 : Math.max(from, 0);
  for (let offset = 0; offset < options.length; offset++) {
    const index = (start + offset) % options.length;
    const option = options[index];
    if (!option.isDisabled && option.name.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/** The options whose name or ID contains `query`, case-insensitive; all of them for a blank query. */
export function filterOptions(options: DropdownOption[], query: string): DropdownOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => option.name.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle));
}
