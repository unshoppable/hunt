import { useRef, useState } from "react";

const OPEN_DELAY = 350;
const CLOSE_DELAY = 180;

export type HoverAnchor<Key> = { key: Key; rect: DOMRect };

export type HoverAnchorState<Key> = {
  anchor: HoverAnchor<Key> | null;
  /** Arms the open delay for `element`; an earlier pending open or close is cancelled. */
  enter: (key: Key, element: HTMLElement) => void;
  /** Arms the close delay so the mouse can travel from the anchor into the popover without closing it. */
  leave: () => void;
  /** Cancels a pending close while the mouse rests inside the popover. */
  keep: () => void;
};

/**
 * Tracks which element the mouse rests on: `enter` arms a short delay before the element becomes the anchor,
 * `leave` arms a short delay before the anchor is hidden again, `keep` cancels that so the popover itself can
 * be hovered and its text selected. One anchor at a time, so a list shares one instance. `openDelay` is in ms.
 */
export function useHoverAnchor<Key>(openDelay = OPEN_DELAY): HoverAnchorState<Key> {
  const [anchor, setAnchor] = useState<HoverAnchor<Key> | null>(null);
  const timerRef = useRef<number | null>(null);

  function clearTimer() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function enter(key: Key, element: HTMLElement) {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setAnchor({ key, rect: element.getBoundingClientRect() });
    }, openDelay);
  }

  function leave() {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setAnchor(null);
    }, CLOSE_DELAY);
  }

  function keep() {
    clearTimer();
  }

  return { anchor, enter, leave, keep };
}
