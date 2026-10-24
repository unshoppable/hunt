import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { ChevronIcon } from "../ui/icons";

/** Set while a separator arrow runs its action, so the layout it leaves is saved like one the user dragged to. */
let isArrowAction = false;

/** Resizable pane group whose layout survives restarts (persisted in localStorage under `id`). */
export function PersistentGroup({
  id,
  orientation = "horizontal",
  className,
  children,
}: {
  id: string;
  orientation?: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ groupId: id, onlySaveAfterUserInteractions: true });
  return (
    <Group
      id={id}
      orientation={orientation}
      defaultLayout={defaultLayout}
      onLayoutChanged={(layout, meta) => onLayoutChanged(layout, isArrowAction ? { ...meta, isUserInteraction: true } : meta)}
      className={className}
    >
      {children}
    </Group>
  );
}

export function PaneSeparator({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  const isHorizontal = orientation === "horizontal";
  return (
    <Separator
      className={`group relative shrink-0 bg-(--line) transition-colors hover:bg-blue-500 data-[separator=active]:bg-blue-500 ${isHorizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}`}
    >
      <span className={`absolute ${isHorizontal ? "-left-1 top-0 h-full w-2" : "-top-1 left-0 h-2 w-full"}`} />
    </Separator>
  );
}

/** Width of the arrow pair on a separator, two 14px buttons and the line between them. */
const ARROWS_WIDTH = 31;

/**
 * The arrows on top of a separator, like a split pane's one-touch buttons: each arrow moves the separator to its side
 * by collapsing or restoring a pane; `null` disables an arrow. Rendered outside the group, since the group starts a
 * drag on any pointerdown inside a separator's hit area. `x` is the separator's distance from the left edge of the
 * positioned parent; the arrows stay inside that parent when the separator reaches its edge.
 */
export function SeparatorArrows({
  x,
  top,
  onLeft,
  onRight,
}: {
  x: number;
  top: number;
  onLeft: { label: string; run: () => void } | null;
  onRight: { label: string; run: () => void } | null;
}) {
  return (
    <div
      className="absolute z-10 flex h-6 -translate-x-1/2 overflow-hidden rounded-md border border-(--line) bg-(--surface-input) shadow-md"
      style={{ left: `clamp(${ARROWS_WIDTH / 2}px, ${x}px, calc(100% - ${ARROWS_WIDTH / 2}px))`, top, width: ARROWS_WIDTH }}
    >
      <ArrowButton action={onLeft} pointsLeft />
      <span className="w-px shrink-0 bg-(--line)" />
      <ArrowButton action={onRight} pointsLeft={false} />
    </div>
  );
}

function ArrowButton({ action, pointsLeft }: { action: { label: string; run: () => void } | null; pointsLeft: boolean }) {
  return (
    <button
      type="button"
      disabled={!action}
      onClick={() => {
        isArrowAction = true;
        try {
          action?.run();
        } finally {
          isArrowAction = false;
        }
      }}
      title={action?.label}
      aria-label={action?.label}
      className={
        "flex flex-1 items-center justify-center text-neutral-400 transition-colors outline-none hover:bg-(--row-hover) hover:text-white " +
        "focus-visible:bg-(--row-active) disabled:text-neutral-700"
      }
    >
      <ChevronIcon expanded={false} className={`size-3 ${pointsLeft ? "rotate-180" : ""}`} />
    </button>
  );
}

export { Panel, usePanelRef };
