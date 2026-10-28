import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { SelectionRequest } from "../../editor/selection-request.monaco";
import { trackDrag } from "../../ui/pointer-drag.utils";
import { usePopupSize, type PopupResize } from "../../ui/popup-size.hook";
import { useViewportSize } from "../../ui/viewport-size.hook";

const MIN_SIZE = { width: 420, height: 240 };
/** Space the popover keeps from the window's edges. */
const MARGIN = 12;

/** Where the in-app sub chat popover sits and how large it is, with the handlers that move and resize it. */
export type SubChatPlacement = Pick<PopupResize, "size" | "isHeightSet" | "grips"> & {
  left: number;
  top: number;
  /** Hands `onPlaced` the anchored corner's distance from the anchor. */
  reportPlace: () => void;
  /** Drags the popover by its header; on release the offset snaps to where it stopped at the window's margin. */
  beginMove: (event: ReactPointerEvent<HTMLElement>) => void;
};

/**
 * Places the sub chat popover whose root is `rootRef` at `anchor` and lets the user move it by its header and resize it
 * by its edges; `onPlaced` learns how far its anchored corner sits from the anchor after each move or resize.
 */
export function useSubChatPlacement(
  anchor: SelectionRequest["anchor"],
  rootRef: RefObject<HTMLDivElement | null>,
  onPlaced: ((offset: { x: number; y: number }) => void) | undefined,
): SubChatPlacement {
  const viewport = useViewportSize();
  // Once the height was dragged, the popover keeps that height instead of following its content.
  const { size, shift, isHeightSet, grips } = usePopupSize("subChat", {
    min: MIN_SIZE,
    max: { width: viewport.width - 2 * MARGIN, height: viewport.height - 2 * MARGIN },
    room: (rendered) => ({ left: left - MARGIN, top: top - MARGIN, right: viewport.width - MARGIN - left - rendered.width, bottom: viewport.height - MARGIN - top - rendered.height }),
  });
  // The popover opens with its anchored corner at the anchor, its remembered size counted from there, moved as far as
  // needed to stay inside the window's margin, so that it can grow with its content without moving. From there a
  // dragged left or top edge moves it by `shift`.
  const isBottomRight = anchor.corner === "bottomRight";
  const [origin] = useState(() => {
    const anchoredX = isBottomRight ? anchor.x - size.width : anchor.x;
    const anchoredY = isBottomRight ? anchor.y - size.height : anchor.y;
    return {
      x: Math.max(MARGIN, Math.min(anchoredX, window.innerWidth - size.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(anchoredY, window.innerHeight - size.height - MARGIN)),
    };
  });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // A popover as tall as its content may be moved down as far as its rendered height, not its remembered one, allows.
  const [renderedHeight, setRenderedHeight] = useState(size.height);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setRenderedHeight(root.offsetHeight);
    const observer = new ResizeObserver(() => setRenderedHeight(root.offsetHeight));
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef]);
  // A bottom-anchored popover as tall as its content keeps its bottom edge in place and grows upwards; `slack` is the
  // remembered height its content does not use yet.
  const slack = isBottomRight && !isHeightSet ? Math.max(0, size.height - renderedHeight) : 0;
  const latestSlack = useRef(slack);
  // A dragged height drops the slack; the offset takes it over so that the popover does not jump.
  useLayoutEffect(() => {
    if (!isHeightSet || !latestSlack.current) return;
    const taken = latestSlack.current;
    setOffset((current) => ({ x: current.x, y: current.y + taken }));
  }, [isHeightSet]);
  useLayoutEffect(() => {
    latestSlack.current = slack;
  });
  const left = Math.max(MARGIN, Math.min(origin.x + offset.x + shift.x, viewport.width - size.width - MARGIN));
  const top = Math.max(MARGIN, Math.min(origin.y + slack + offset.y + shift.y, viewport.height - (isHeightSet ? size.height : renderedHeight) - MARGIN));
  const height = isHeightSet ? size.height : renderedHeight;
  const latestPlace = useRef({ left, top, shift, slack, height });
  latestPlace.current = { left, top, shift, slack, height };

  function reportPlace() {
    if (!onPlaced) return;
    const { left: placedLeft, top: placedTop, height: placedHeight } = latestPlace.current;
    const corner = isBottomRight ? { x: placedLeft + size.width, y: placedTop + placedHeight } : { x: placedLeft, y: placedTop };
    onPlaced({ x: corner.x - anchor.x, y: corner.y - anchor.y });
  }

  function beginMove(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const start = { ...offset };
    trackDrag(
      event,
      (deltaX, deltaY) => setOffset({ x: start.x + deltaX, y: start.y + deltaY }),
      () => {
        const { left: endLeft, top: endTop, shift: moved, slack: unused } = latestPlace.current;
        setOffset({ x: endLeft - origin.x - moved.x, y: endTop - origin.y - unused - moved.y });
        reportPlace();
      },
    );
  }

  return { size, isHeightSet, grips, left, top, reportPlace, beginMove };
}
