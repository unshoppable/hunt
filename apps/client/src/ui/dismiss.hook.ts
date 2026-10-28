import { useEffect, useRef, type RefObject } from "react";
import { useEscapeToClose } from "./escape-to-close.hook";

type DismissOptions = {
  /** Elements that count as inside besides `rootRef`, e.g. the button that opened the popover, so that pressing it closes without reopening. */
  anchorRefs?: RefObject<Element | null>[];
  /** Also closes when the window loses focus, e.g. a context menu that must not outlive a switch to another window. */
  closeOnWindowBlur?: boolean;
  isEnabled?: boolean;
};

/**
 * Closes an anchored popover or menu on Escape (taken in the capture phase, so the window-wide Escape shortcuts stay
 * quiet) and on a mouse press outside of `rootRef` and the `anchorRefs`. Modal dialogs with a backdrop use
 * `Modal` instead; this hook is for elements that float next to their anchor.
 */
export function useDismiss(rootRef: RefObject<Element | null>, onClose: () => void, options: DismissOptions = {}): void {
  const { anchorRefs = [], closeOnWindowBlur = false, isEnabled = true } = options;
  const latest = useRef({ onClose, anchorRefs });
  latest.current = { onClose, anchorRefs };

  useEscapeToClose(onClose, isEnabled);

  useEffect(() => {
    if (!isEnabled) return;
    function onMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      const insideRefs = [rootRef, ...latest.current.anchorRefs];
      if (insideRefs.some((ref) => ref.current?.contains(target))) return;
      latest.current.onClose();
    }
    function onBlur() {
      latest.current.onClose();
    }
    window.addEventListener("mousedown", onMouseDown, true);
    if (closeOnWindowBlur) {
      window.addEventListener("blur", onBlur);
    }
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [rootRef, isEnabled, closeOnWindowBlur]);
}
