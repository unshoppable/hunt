/** Shared Tailwind class strings for the diff pane; buttons live in ui/buttons.ts. */
export const INPUT = "w-full rounded border border-neutral-600 bg-(--surface-inset) px-2 py-1 text-sm";

/** File name color by git status, like WebStorm's changelist: new green, modified blue, deleted struck through. */
export const STATUS_NAME_CLASS: Record<string, string> = {
  A: "text-emerald-300",
  "?": "text-emerald-300",
  M: "text-sky-300",
  D: "text-neutral-500 line-through",
  R: "text-blue-300",
};
