import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Group,
  Panel as LibraryPanel,
  Separator,
  useGroupRef,
  usePanelRef,
  type GroupImperativeHandle,
  type Layout,
  type PanelProps,
} from "react-resizable-panels";
import type { CommandId } from "../common/keymap/keymap-commands.data";
import { HEADER_BAR } from "./bars.constants";
import { ChevronIcon } from "./Icons";
import { withShortcut } from "./shortcuts.utils";
import { useShortcutLabel } from "./shortcut-label.hook";
import { layoutFromPixels, pixelsFromLayout, readLegacyLayout, readPaneSizes, writePaneSizes } from "./pane-sizes.utils";

/** Set while a pane toggle runs, so the layout it leaves is saved like one the user dragged to. */
let isToggleAction = false;
/** How long the group animates the panes after a toggle; matches the transition in index.css. */
const PANE_ANIMATION_MS = 260;

/** What the panes of a `PersistentGroup` get from it: which of them fills the group and what that one reports its resizes to. */
const PersistentGroupContext = createContext<{ fillPane: string; onFillPaneResize: () => void } | null>(null);

/** The panes of the group `element`, in their order. */
function panesOf(element: HTMLElement): HTMLElement[] {
  return [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-panel"));
}

/** The pixels `panes` share out along `orientation`: the group's size without its separators. */
function paneSpaceOf(panes: HTMLElement[], orientation: "horizontal" | "vertical"): number {
  return panes.reduce((total, pane) => total + (orientation === "horizontal" ? pane.offsetWidth : pane.offsetHeight), 0);
}

/**
 * Resizable pane group whose pane sizes survive restarts and are the same in every window: each pane but `fillPane`
 * keeps the pixel size the user last gave it (see `ui/pane-sizes.utils.ts`), whatever the size of the window, and
 * `fillPane` takes the rest. `toggleOnlyPanes` maps the ids of collapsible panes that only their toggle collapses to
 * their minimum size in pixels: a drag stops them there and never pushes one that is not beside the dragged separator;
 * other panes give way to a pushed neighbour.
 */
export function PersistentGroup({
  id,
  fillPane,
  orientation = "horizontal",
  groupRef: givenGroupRef,
  toggleOnlyPanes = {},
  className,
  children,
}: {
  id: string;
  fillPane: string;
  orientation?: "horizontal" | "vertical";
  groupRef?: RefObject<GroupImperativeHandle | null>;
  toggleOnlyPanes?: Record<string, number>;
  className?: string;
  children: ReactNode;
}) {
  /** A group without remembered pixel sizes opens with the percentage layout it stored before. */
  const [legacyLayout] = useState(() => (readPaneSizes(id) ? undefined : readLegacyLayout(id)));
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

  /** The pane space the remembered sizes were last laid out for; a drag inside the group leaves it unchanged. */
  const shownPaneSpace = useRef<number | null>(null);

  /**
   * Gives the panes their remembered pixel sizes again once the group's own size has changed (first layout, window
   * resize, a drag in the group around it). It runs from the fill pane's `onResize`, which the library calls after it
   * has measured the group anew; a ResizeObserver of our own could run before that and validate against stale limits.
   */
  const showRememberedSizes = useCallback(() => {
    const element = groupElement.current;
    const sizes = readPaneSizes(id);
    if (!element || !sizes) return;
    const panes = panesOf(element);
    const paneSpace = paneSpaceOf(panes, orientation);
    if (paneSpace === shownPaneSpace.current) return;
    const layout = layoutFromPixels(sizes, panes.map((pane) => pane.id), fillPane, paneSpace);
    if (!layout) return;
    shownPaneSpace.current = paneSpace;
    isRestoring.current = true;
    try {
      groupRef.current?.setLayout(layout);
    } finally {
      isRestoring.current = false;
    }
  }, [id, fillPane, orientation, groupRef]);

  // The first layout gets the remembered sizes before it is painted.
  useLayoutEffect(() => showRememberedSizes(), [showRememberedSizes]);

  const paneContext = useMemo(() => ({ fillPane, onFillPaneResize: showRememberedSizes }), [fillPane, showRememberedSizes]);

  /** Remembers the pixel sizes of `layout`, which the user dragged to or a pane toggle left. */
  const rememberSizes = (layout: Layout) => {
    const element = groupElement.current;
    if (!element) return;
    writePaneSizes(id, pixelsFromLayout(layout, fillPane, paneSpaceOf(panesOf(element), orientation)));
  };

  // While a toggle animates the panes, each pane's content keeps the larger of its old and new size, so a frame only
  // changes how much of it the pane shows (index.css clips it) instead of laying the content out again.
  const animateToggle = (layout: Layout) => {
    const element = groupElement.current;
    if (!element) return;
    const isHorizontal = orientation === "horizontal";
    const panes = panesOf(element);
    const paneSpace = paneSpaceOf(panes, orientation);
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
    const panes = panesOf(element);
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
    const paneSpace = paneSpaceOf(panes, orientation);
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
      defaultLayout={legacyLayout}
      onLayoutChange={handleLayoutChange}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction || isToggleAction) {
          rememberSizes(layout);
        }
      }}
      className={className}
    >
      <PersistentGroupContext.Provider value={paneContext}>{children}</PersistentGroupContext.Provider>
    </Group>
  );
}

/**
 * `Panel` of react-resizable-panels; the fill pane of a `PersistentGroup` also reports its resizes to the group. The
 * group's context ends at its panes, so the panes of a group nested in one are never taken for its own.
 */
export function Panel({ onResize, children, ...props }: PanelProps) {
  const group = useContext(PersistentGroupContext);
  const isFillPane = !!group && props.id === group.fillPane;
  return (
    <LibraryPanel
      {...props}
      onResize={
        isFillPane
          ? (size, paneId, previousSize) => {
              group.onFillPaneResize();
              onResize?.(size, paneId, previousSize);
            }
          : onResize
      }
    >
      <PersistentGroupContext.Provider value={null}>{children}</PersistentGroupContext.Provider>
    </LibraryPanel>
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

/** Runs `toggle`, which collapses or restores panes of a `PersistentGroup`, so the panes glide like after a toggle click. */
export function runPaneToggle(toggle: () => void) {
  isToggleAction = true;
  try {
    toggle();
  } finally {
    isToggleAction = false;
  }
}

/**
 * Round button that collapses a pane to its rail or restores it; panes collapse to the left, so the chevron points
 * left while the pane is open. The panes of its group glide to their new widths. `shortcutId` names the keymap command
 * that toggles the pane too, for the tooltip.
 */
export function PaneToggle({ isOpen, name, shortcutId, onToggle }: { isOpen: boolean; name: string; shortcutId: CommandId; onToggle: () => void }) {
  const label = `${isOpen ? "Hide" : "Show"} ${name}`;
  const shortcut = useShortcutLabel(shortcutId);
  return (
    <button
      type="button"
      onClick={() => runPaneToggle(onToggle)}
      title={withShortcut(label, shortcut)}
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

export { useGroupRef, usePanelRef };
