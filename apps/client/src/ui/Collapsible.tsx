import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Body of a disclosure that grows open and shrinks shut as `isOpen` changes, by animating its grid row between 0fr and
 * 1fr; a body open from the start shows without animation. `children` mount when opening starts and unmount when
 * closing ends, and are inert while closing. Padding and borders go on `children`, so the wrapper can shrink to zero.
 */
export function Collapsible({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isRendered, setIsRendered] = useState(isOpen);
  const [isShown, setIsShown] = useState(isOpen);
  if (isOpen && !isRendered) setIsRendered(true);

  useLayoutEffect(() => {
    if (!isOpen) {
      setIsShown(false);
      return;
    }
    if (isShown) return;
    // Lays out the closed row first, so the switch to 1fr transitions from zero height.
    rootRef.current?.getBoundingClientRect();
    setIsShown(true);
  }, [isOpen, isShown]);

  if (!isRendered) return null;
  return (
    <div
      ref={rootRef}
      inert={!isOpen}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !isOpen) setIsRendered(false);
      }}
      className={`grid overflow-hidden transition-[grid-template-rows] duration-150 ease-out ${isShown ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
    >
      <div className="min-h-0 min-w-0">{children}</div>
    </div>
  );
}
