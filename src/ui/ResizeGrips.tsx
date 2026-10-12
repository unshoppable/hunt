import type { PointerEvent as ReactPointerEvent } from "react";
import { trackDrag } from "./pointerDrag";

/** Width of the invisible strips along the edges that resize the host. */
const GRIP = 5;
/** Side of the squares in the corners; wider than the strips because a rounded corner clips part of them. */
const CORNER = 14;

/**
 * How far the dragged edges moved outward: `dx` / `dy` are the growth in width and height (negative when shrinking),
 * `shiftX` / `shiftY` how far the top-left corner moved while the opposite edge stayed put, i.e. `-dx` when the
 * left edge is dragged and `-dy` when the top edge is, 0 otherwise.
 */
export type ResizeGrowth = { dx: number; dy: number; shiftX: number; shiftY: number };

/** Which edges of the host carry a grip. */
export type ResizeEdges = { left?: boolean; top?: boolean; right?: boolean; bottom?: boolean };

/** Which axes the host stays centered on: a dragged edge then moves both sides, so the growth is doubled and the corner does not shift. */
export type ResizeCentered = { x?: boolean; y?: boolean };

export type ResizeHandlers = {
  /** Called once when a drag starts, before the first `onDrag`, with the host's rendered outer size. */
  onStart: (rendered: { width: number; height: number }) => void;
  onDrag: (growth: ResizeGrowth) => void;
  /** Called once when the pointer is released. */
  onEnd: () => void;
};

type ResizeGripsProps = ResizeHandlers & {
  /** Edges that resize the host; the corner between two of them resizes in both directions. */
  edges: ResizeEdges;
  centered?: ResizeCentered;
};

type Axes = { x?: -1 | 1; y?: -1 | 1 };

const CURSORS: Record<string, string> = { "-1,0": "cursor-ew-resize", "1,0": "cursor-ew-resize", "0,-1": "cursor-ns-resize", "0,1": "cursor-ns-resize", "-1,-1": "cursor-nwse-resize", "1,1": "cursor-nwse-resize", "1,-1": "cursor-nesw-resize", "-1,1": "cursor-nesw-resize" };

/**
 * Invisible strips along the edges of a floating element (which must be positioned) that resize it by dragging,
 * with the matching resize cursors. The host keeps its size state: it reads the start size in `onStart` and applies
 * each `onDrag` growth to it, so it can clamp the result as it sees fit (see usePopupSize).
 */
export function ResizeGrips({ edges, centered = {}, onStart, onDrag, onEnd }: ResizeGripsProps) {
  const begin = (event: ReactPointerEvent<HTMLDivElement>, axes: Axes) => {
    if (event.button !== 0) return;
    const host = event.currentTarget.parentElement ?? event.currentTarget;
    onStart({ width: host.offsetWidth, height: host.offsetHeight });
    trackDrag(
      event,
      (dx, dy) => {
        const growX = axes.x ? dx * axes.x : 0;
        const growY = axes.y ? dy * axes.y : 0;
        onDrag({
          dx: centered.x ? growX * 2 : growX,
          dy: centered.y ? growY * 2 : growY,
          shiftX: axes.x === -1 && !centered.x ? -growX : 0,
          shiftY: axes.y === -1 && !centered.y ? -growY : 0,
        });
      },
      onEnd,
    );
  };
  const grip = (axes: Axes, position: string, size: { width?: number; height?: number }) => (
    <div className={`absolute ${position} ${CURSORS[`${axes.x ?? 0},${axes.y ?? 0}`]}`} style={size} onPointerDown={(event) => begin(event, axes)} />
  );
  const corner = { width: CORNER, height: CORNER };
  return (
    <>
      {edges.left ? grip({ x: -1 }, "top-0 bottom-0 left-0", { width: GRIP }) : null}
      {edges.right ? grip({ x: 1 }, "top-0 right-0 bottom-0", { width: GRIP }) : null}
      {edges.top ? grip({ y: -1 }, "top-0 right-0 left-0", { height: GRIP }) : null}
      {edges.bottom ? grip({ y: 1 }, "right-0 bottom-0 left-0", { height: GRIP }) : null}
      {edges.top && edges.left ? grip({ x: -1, y: -1 }, "top-0 left-0", corner) : null}
      {edges.top && edges.right ? grip({ x: 1, y: -1 }, "top-0 right-0", corner) : null}
      {edges.bottom && edges.left ? grip({ x: -1, y: 1 }, "bottom-0 left-0", corner) : null}
      {edges.bottom && edges.right ? grip({ x: 1, y: 1 }, "right-0 bottom-0", corner) : null}
    </>
  );
}
