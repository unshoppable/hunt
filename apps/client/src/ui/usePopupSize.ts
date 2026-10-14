import { useRef, useState } from "react";
import { useSettingsStore, type PopupKey, type PopupSize } from "../state/settings";
import type { ResizeHandlers } from "./ResizeGrips";

/** Pixels a popup may grow beyond each of its edges before it hits the window, its container or its anchor. */
export type Room = { left: number; top: number; right: number; bottom: number };

export type PopupBounds = {
  /** Smallest size the popup shrinks to. */
  min: PopupSize;
  /** Largest size the popup may take; the remembered size is clamped to it. */
  max: PopupSize;
  /**
   * Room beyond each edge when a drag starts, given the popup's rendered size; the dragged edge stops there. Without
   * it every edge may grow up to `max`, which suits a dialog that stays centered and a popover that only grows away
   * from its anchor.
   */
  room?: (rendered: PopupSize) => Partial<Room>;
};

export type PopupResize = {
  size: PopupSize;
  /** How far the top-left corner moved by dragging the left or top edge; a positioned host adds it to its place. */
  shift: { x: number; y: number };
  /** True once the user dragged the height: a popup that is as tall as its content keeps the dragged height instead. */
  isHeightSet: boolean;
  /** The handlers for the popup's `ResizeGrips`. */
  grips: ResizeHandlers;
};

/**
 * `size` kept between `min` and `max`; `min` gives way when it does not fit either. A dragged height is not raised
 * to the minimum: it started from the rendered height, which may be lower.
 */
function fitSize(size: PopupSize, { min, max }: PopupBounds, isHeightSet: boolean): PopupSize {
  return {
    width: Math.max(Math.min(min.width, max.width), Math.min(size.width, max.width)),
    height: Math.max(isHeightSet ? 0 : Math.min(min.height, max.height), Math.min(size.height, max.height)),
  };
}

/** New length and corner shift of one axis: the dragged edge stops at the room beyond it and at the minimum length. */
function growAxis(length: number, min: number, growth: number, shift: number, room: { near: number; far: number }): { length: number; shift: number } {
  const near = Math.min(-shift, room.near);
  const far = Math.min(growth + shift, room.far);
  const next = Math.max(min, length + near + far);
  return { length: next, shift: near ? length - next : 0 };
}

/**
 * Size state of a resizable popup: starts from the size remembered under `key`, follows the grips' drags within
 * `bounds` and remembers the final size when a drag ends. A popup that is as tall as its content (`height` unset,
 * `maxHeight` the remembered height) grows from its rendered height, not from the remembered one.
 */
export function usePopupSize(key: PopupKey, bounds: PopupBounds): PopupResize {
  const stored = useSettingsStore((state) => state.popupSizes[key]);
  const setPopupSize = useSettingsStore((state) => state.setPopupSize);
  const [size, setSize] = useState(stored);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [isHeightSet, setIsHeightSet] = useState(false);
  const fitted = fitSize(size, bounds, isHeightSet);
  const latest = useRef({ fitted, shift, bounds });
  latest.current = { fitted, shift, bounds };
  /** What a drag started from: the remembered size, the rendered size and the room around the popup. */
  const start = useRef({ size: fitted, rendered: fitted, shift, room: { left: 0, top: 0, right: 0, bottom: 0 } });

  const grips: ResizeHandlers = {
    onStart: (rendered) => {
      const { fitted: current, shift: origin, bounds: limits } = latest.current;
      const full = { left: limits.max.width - rendered.width, right: limits.max.width - rendered.width, top: limits.max.height - rendered.height, bottom: limits.max.height - rendered.height };
      start.current = { size: current, rendered, shift: origin, room: { ...full, ...limits.room?.(rendered) } };
    },
    onDrag: (growth) => {
      const { size: origin, rendered, shift: corner, room } = start.current;
      const { min } = latest.current.bounds;
      const x = growAxis(origin.width, Math.min(min.width, rendered.width), growth.dx, growth.shiftX, { near: room.left, far: room.right });
      // The height follows only a vertical drag; a popup not yet set to a height grows from the height it renders at.
      const y = growth.dy ? growAxis(rendered.height, Math.min(min.height, rendered.height), growth.dy, growth.shiftY, { near: room.top, far: room.bottom }) : { length: origin.height, shift: 0 };
      setSize({ width: x.length, height: y.length });
      setShift({ x: corner.x + x.shift, y: corner.y + y.shift });
      if (growth.dy) {
        setIsHeightSet(true);
      }
    },
    onEnd: () => setPopupSize(key, latest.current.fitted),
  };

  return { size: fitted, shift, isHeightSet, grips };
}
