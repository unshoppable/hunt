/**
 * Shared button classes, shaped like T3 Code's: rounded rectangles (never pills), medium 13px text, quiet surfaces.
 * Pick a size (`BUTTON_XS` 28px for dense toolbars, `BUTTON_MD` 32px, `BUTTON_LG` 36px for a view's headline
 * action) and a variant, or use the ready-made combinations below. Variants never repeat a size's utilities, so they can be swapped
 * at runtime without conflicting classes.
 */
export const BUTTON_BASE =
  "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:pointer-events-none disabled:opacity-40";

export const BUTTON_XS = `${BUTTON_BASE} h-7 gap-1.5 px-3 text-[13px]`;
export const BUTTON_MD = `${BUTTON_BASE} h-8 gap-2 px-3.5 text-sm`;
export const BUTTON_LG = `${BUTTON_BASE} h-9 gap-2 px-4 text-sm`;

/** Filled accent button for the one main action of a view. */
export const PRIMARY = "bg-blue-600 text-white hover:bg-blue-500 active:bg-blue-700";
/** Outlined button on a faint surface, like T3's header actions. */
export const SECONDARY = "border border-white/10 bg-white/4 text-neutral-200 hover:border-white/15 hover:bg-white/8 active:bg-white/5";
/** Text-only button that shows its surface while hovered. */
export const GHOST = "text-neutral-300 hover:bg-(--row-hover) hover:text-white active:bg-(--row-active)";
/** Text-only button for destructive actions. */
export const DANGER = "text-red-300 hover:bg-red-400/10 hover:text-red-200 active:bg-red-400/15";

export const PRIMARY_BUTTON_XS = `${BUTTON_XS} ${PRIMARY}`;
export const SECONDARY_BUTTON_XS = `${BUTTON_XS} ${SECONDARY}`;
export const GHOST_BUTTON_XS = `${BUTTON_XS} ${GHOST}`;
export const DANGER_BUTTON_XS = `${BUTTON_XS} ${DANGER}`;

export const PRIMARY_BUTTON_MD = `${BUTTON_MD} ${PRIMARY}`;
export const SECONDARY_BUTTON_MD = `${BUTTON_MD} ${SECONDARY}`;
export const GHOST_BUTTON_MD = `${BUTTON_MD} ${GHOST}`;

export const PRIMARY_BUTTON_LG = `${BUTTON_LG} ${PRIMARY}`;
export const SECONDARY_BUTTON_LG = `${BUTTON_LG} ${SECONDARY}`;

/** Violet agent glow (`.hunt-agent-glow` in index.css) for a button that hands work to the agent. */
export const AGENT_GLOW = "hunt-agent-glow";

/** Square icon-only buttons with a generous hit area; combine with `GHOST` / `DANGER` or use the ready-made ones. */
const ICON_BASE =
  "inline-flex shrink-0 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:pointer-events-none disabled:opacity-40";
export const ICON_BUTTON_BASE = `${ICON_BASE} size-9`;
export const ICON_BUTTON_BASE_SM = `${ICON_BASE} size-8`;
/** 28px, for icon toolbars that sit in a `BUTTON_XS` row (the markdown toolbar of the review comment box). */
export const ICON_BUTTON_BASE_XS = `${ICON_BASE} size-7`;
export const ICON_BUTTON = `${ICON_BUTTON_BASE} text-neutral-400 hover:bg-(--row-hover) hover:text-white`;
export const ICON_BUTTON_SM = `${ICON_BUTTON_BASE_SM} text-neutral-400 hover:bg-(--row-hover) hover:text-white`;
export const ICON_BUTTON_XS = `${ICON_BUTTON_BASE_XS} text-neutral-400 hover:bg-(--row-hover) hover:text-white`;

/** Round accent button that submits a prompt; while a turn runs it queues the prompt, there is no stop button. */
export const SEND_BUTTON =
  "flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40";
/** Quiet round button beside the send button for a secondary prompt action, e.g. clearing the conversation. */
export const CLEAR_BUTTON =
  "flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/4 text-neutral-400 transition-colors hover:border-white/15 hover:bg-white/8 hover:text-white active:bg-white/5 disabled:pointer-events-none disabled:opacity-40";
/** Round red button beside the send button for a destructive prompt action, e.g. discarding the conversation. */
export const DANGER_CLEAR_BUTTON =
  "flex size-9 shrink-0 items-center justify-center rounded-full border border-red-400/30 bg-red-400/10 text-red-300 transition-colors hover:border-red-400/50 hover:bg-red-400/20 hover:text-red-200 active:bg-red-400/25 disabled:pointer-events-none disabled:opacity-40";

/** Segmented tab, e.g. Diff / Editor / Dependency Graph; add `TAB_ACTIVE` or `TAB_INACTIVE`. */
export const TAB_BUTTON = "inline-flex h-8 shrink-0 select-none items-center rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60";
export const TAB_BUTTON_SM = "inline-flex h-7 shrink-0 select-none items-center rounded-md px-2.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60";
export const TAB_ACTIVE = "bg-(--row-active) text-white";
export const TAB_INACTIVE = "text-neutral-400 hover:bg-(--row-hover) hover:text-white";
