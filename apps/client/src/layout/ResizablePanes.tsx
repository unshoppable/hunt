import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Group, Panel, Separator, useDefaultLayout, useGroupRef, usePanelRef, type GroupImperativeHandle, type Layout } from "react-resizable-panels";
import { HEADER_BAR } from "../ui/bars";
import { ChevronIcon } from "../ui/icons";

/** Set while a pane toggle runs, so the layout it leaves is saved like one the user dragged to. */
let isToggleAction = false;
/** How long the group animates the panes after a toggle; matches the transition in index.css. */
const PANE_ANIMATION_MS = 260;

/**
 * Resizable pane group whose layout survives restarts (persisted in localStorage under `id`). `toggleOnlyPanes` maps
 * the ids of collapsible panes that only their toggle collapses to their minimum size in pixels: a drag stops them
 * there and never pushes one that is not beside the dragged separator; other panes give way to a pushed neighbour.
 */
export function PersistentGroup({
  id,
  orientation = "horizontal",
  groupRef: givenGroupRef,
  toggleOnlyPanes = {},
  className,
  children,
}: {
  id: string;
  orientation?: "horizontal" | "vertical";
  groupRef?: RefObject<GroupImperativeHandle | null>;
  toggleOnlyPanes?: Record<string, number>;
  className?: string;
  children: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ groupId: id, onlySaveAfterUserInteractions: true });
  const ownGroupRef = useGroupRef();
  const groupRef = givenGroupRef ?? ownGroupRef;
  const groupElement = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<Layout | null>(null);
  /** The layout when the current drag began; the library recomputes every pointer move from it. */
  const dragStartLayout = useRef<Layout | null>(null);
  const isRestoring = useRef(false);
  const animationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const endDrag = () => {
      dragStartLayout.current = null;
    };
    window.addEventListener("pointerup", endDrag, true);
    return () => window.removeEventListener("pointerup", endDrag, true);
  }, []);

  // While a toggle animates the panes, each pane's content keeps the larger of its old and new size, so a frame only
  // changes how much of it the pane shows (index.css clips it) instead of laying the content out again.
  const animateToggle = (layout: Layout) => {
    const element = groupElement.current;
    if (!element) return;
    const isHorizontal = orientation === "horizontal";
    const panes = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-panel"));
    const paneSpace = panes.reduce((total, pane) => total + (isHorizontal ? pane.offsetWidth : pane.offsetHeight), 0);
    const contents = panes.map((pane) => {
      const content = pane.firstElementChild;
      if (!(content instanceof HTMLElement)) return null;
      const size = Math.max(isHorizontal ? pane.offsetWidth : pane.offsetHeight, ((layout[pane.id] ?? 0) / 100) * paneSpace);
      content.style[isHorizontal ? "minWidth" : "minHeight"] = `${size}px`;
      return content;
    });
    element.setAttribute("data-pane-animating", "");
    window.clearTimeout(animationTimer.current);
    animationTimer.current = window.setTimeout(() => {
      element.removeAttribute("data-pane-animating");
      for (const content of contents) {
        content?.style.removeProperty(isHorizontal ? "min-width" : "min-height");
      }
    }, PANE_ANIMATION_MS);
  };

  const handleLayoutChange = (layout: Layout) => {
    if (isToggleAction) {
      animateToggle(layout);
    }
    keepDragBesideSeparator(layout);
  };

  const keepDragBesideSeparator = (layout: Layout) => {
    const previous = previousLayout.current;
    previousLayout.current = layout;
    const element = groupElement.current;
    const separator = element?.querySelector(":scope > [data-separator='active']");
    if (!previous || !element || !separator || isRestoring.current || isToggleAction) return;
    dragStartLayout.current ??= previous;
    const start = dragStartLayout.current;
    const before = separator.previousElementSibling?.id;
    const after = separator.nextElementSibling?.id;
    if (!before || !after) return;
    const panes = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-panel"));
    const paneIds = panes.map((pane) => pane.id);
    const restored = { ...layout };
    // A toggle-only pane beyond the two neighbours keeps its size; the neighbour on the separator's other side gives back what it took.
    for (const paneId of paneIds) {
      if (paneId === before || paneId === after || !toggleOnlyPanes[paneId] || start[paneId] === undefined || restored[paneId] === undefined) continue;
      const neighbour = paneIds.indexOf(paneId) < paneIds.indexOf(after) ? after : before;
      restored[neighbour] += restored[paneId] - start[paneId];
      restored[paneId] = start[paneId];
    }
    // Layout percentages share out the panes' space, which excludes the separators.
    const paneSpace = panes.reduce((total, pane) => total + (orientation === "horizontal" ? pane.offsetWidth : pane.offsetHeight), 0);
    for (const [paneId, neighbour] of [
      [before, after],
      [after, before],
    ]) {
      const minimumPixels = toggleOnlyPanes[paneId];
      if (!minimumPixels) continue;
      const minimum = (minimumPixels / paneSpace) * 100;
      if (restored[paneId] >= minimum - 0.1 || start[paneId] < minimum - 0.1) continue;
      restored[neighbour] -= minimum - restored[paneId];
      restored[paneId] = minimum;
    }
    if (paneIds.every((paneId) => Math.abs(restored[paneId] - layout[paneId]) < 0.01)) return;
    isRestoring.current = true;
    try {
      groupRef.current?.setLayout(restored);
    } finally {
      isRestoring.current = false;
    }
  };

  return (
    <Group
      id={id}
      orientation={orientation}
      groupRef={groupRef}
      elementRef={groupElement}
      defaultLayout={defaultLayout}
      onLayoutChange={handleLayoutChange}
      onLayoutChanged={(layout, meta) => onLayoutChanged(layout, isToggleAction ? { ...meta, isUserInteraction: true } : meta)}
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

/** Width a collapsed pane keeps for its rail (`w-12`, 42px at the 14px root font). */
export const RAIL_SIZE = "3rem";
/**
 * `collapsedThreshold` of a toggle-only pane: a drag that squeezes it below its minimum pushes the panes beyond it
 * instead of collapsing it. Only a drag past the rail size still collapses it, which `PersistentGroup` undoes.
 */
export const PUSH_INSTEAD_OF_COLLAPSE = "100%";

/**
 * The row a pane toggle sits in: the row of the session sidebar's search field, so every toggle shares its height.
 * Panes that show a toggle keep their content clear of it.
 */
export const PANE_TOGGLE_ROW = "mt-[12px] flex h-10 shrink-0 items-center";

/**
 * Round button that collapses a pane to its rail or restores it; panes collapse to the left, so the chevron points
 * left while the pane is open. The panes of its group glide to their new widths.
 */
export function PaneToggle({ isOpen, name, onToggle }: { isOpen: boolean; name: string; onToggle: () => void }) {
  const label = `${isOpen ? "Hide" : "Show"} ${name}`;
  return (
    <button
      type="button"
      onClick={() => {
        isToggleAction = true;
        try {
          onToggle();
        } finally {
          isToggleAction = false;
        }
      }}
      title={label}
      aria-label={label}
      className={
        "flex size-[30px] shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/6 text-neutral-300 shadow-sm " +
        "shadow-black/30 backdrop-blur-md transition-[background-color,border-color,color,scale] duration-150 outline-none hover:border-white/20 " +
        "hover:bg-white/12 hover:text-white active:scale-92 focus-visible:ring-2 focus-visible:ring-blue-400/60"
      }
    >
      <ChevronIcon expanded={false} className={`size-4 ${isOpen ? "rotate-180" : ""}`} />
    </button>
  );
}

/** What a collapsed pane shows in its place: an empty header row that drags the window, then the toggle restoring it. */
export function PaneRail({ headerClassName = "", children }: { headerClassName?: string; children: ReactNode }) {
  return (
    <div className="flex w-12 shrink-0 animate-pane-in flex-col items-center">
      <div data-tauri-drag-region="" className={`${HEADER_BAR} w-full ${headerClassName}`} />
      <div className={PANE_TOGGLE_ROW}>{children}</div>
    </div>
  );
}

export { Panel, useGroupRef, usePanelRef };
