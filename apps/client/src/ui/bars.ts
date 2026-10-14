/**
 * Shared classes for the thin information rows at the bottom of a view: the editor breadcrumb, the path row of a
 * popup, the legend and the counts under the architecture diagram. Callers add their gap, background and colors.
 */
/**
 * The top row of a pane or window: 42px (`h-12` at the 14px root font), the height the macOS traffic lights are
 * positioned for (see tauri.conf.json), so every header lines up across panes. Callers add their padding, border
 * and the drag region.
 */
export const HEADER_BAR = "flex h-12 shrink-0 items-center";

export const STATUS_BAR = "flex h-[36px] shrink-0 items-center overflow-hidden border-t border-(--line) px-3 text-[13px] whitespace-nowrap";
