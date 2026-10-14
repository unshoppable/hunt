import { useEffect, useRef } from "react";

/**
 * Closes an in-app dialog on Escape wherever the focus is, as long as `isEnabled` holds. The key is taken before
 * anything else sees it, so the window-wide Escape shortcuts (interrupting the chat, closing a secondary window)
 * stay quiet while the dialog is open.
 */
export function useEscapeToClose(close: () => void, isEnabled = true): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!isEnabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isEnabled]);
}
