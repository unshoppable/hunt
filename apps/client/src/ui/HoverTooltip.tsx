import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const VIEWPORT_MARGIN = 8;
const OFFSET = 4;
const OPEN_DELAY = 400;

/**
 * A `div` that shows `text` on one line below itself once the mouse rests on it for `OPEN_DELAY` ms, instead of the
 * native `title` tooltip with its longer delay and wrapping. The tooltip moves left to stay inside the window; a click
 * or wheel hides it, since both may move the element away from under it.
 */
export function HoverTooltip({ text, className, children }: { text: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef(0);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  function show() {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (!ref.current) return;
      setAnchor(ref.current.getBoundingClientRect());
    }, OPEN_DELAY);
  }

  function hide() {
    window.clearTimeout(timerRef.current);
    setAnchor(null);
  }

  return (
    <div ref={ref} className={className} onMouseEnter={show} onMouseLeave={hide} onPointerDown={hide} onWheel={hide}>
      {children}
      {anchor ? <Tooltip text={text} anchor={anchor} /> : null}
    </div>
  );
}

function Tooltip({ text, anchor }: { text: string; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);

  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 0;
    setLeft(Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - width - VIEWPORT_MARGIN)));
  }, [anchor, text]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[80] rounded-md border border-neutral-600 bg-(--surface-inset) px-1.5 py-0.5 text-[12px] whitespace-nowrap text-neutral-200 shadow-lg shadow-black/40"
      style={{ left, top: anchor.bottom + OFFSET }}
    >
      {text}
    </div>,
    document.body,
  );
}
