import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Tracks a pointer drag that started with `event` on `event.currentTarget` until the pointer is released: `onMove`
 * gets the distance from the press, `onEnd` runs once on release or cancel. The press is captured, so the drag goes on
 * outside the element, and its default (text selection, focus change) is suppressed.
 */
export function trackDrag(event: ReactPointerEvent<HTMLElement>, onMove: (dx: number, dy: number) => void, onEnd: () => void): void {
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const origin = { x: event.clientX, y: event.clientY };
  const handleMove = (move: PointerEvent) => onMove(move.clientX - origin.x, move.clientY - origin.y);
  const handleEnd = () => {
    target.removeEventListener("pointermove", handleMove);
    target.removeEventListener("pointerup", handleEnd);
    target.removeEventListener("pointercancel", handleEnd);
    onEnd();
  };
  target.setPointerCapture(event.pointerId);
  target.addEventListener("pointermove", handleMove);
  target.addEventListener("pointerup", handleEnd);
  target.addEventListener("pointercancel", handleEnd);
}
