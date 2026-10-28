import { useCallback, useRef, useState } from "react";
import type { SelectionRequest } from "../../editor/selection-request.monaco";
import type { SelectionContext } from "../../editor/selection-context.types";

/** The popover a code view shows: a new sub chat about `request`, or the existing sub session `subSessionId` about it. */
export type ShownSubChat = { key: number; request: SelectionRequest; subSessionId?: string };

/**
 * State of a code view's sub chat popover. `open` shows a new sub chat about a selection or, with `subSessionId`,
 * an existing one; every call remounts the popover (see `key`).
 */
export function useSubChatPopover(): {
  shown: ShownSubChat | null;
  open: (request: SelectionRequest, subSessionId?: string) => void;
  /** Opens the popover for `request`, or closes it when it already shows a chat about the same lines. */
  toggle: (request: SelectionRequest) => void;
  close: () => void;
} {
  const [shown, setShown] = useState<ShownSubChat | null>(null);
  const counter = useRef(0);
  const open = useCallback((request: SelectionRequest, subSessionId?: string) => {
    counter.current += 1;
    setShown({ key: counter.current, request, subSessionId });
  }, []);
  const toggle = useCallback((request: SelectionRequest) => {
    setShown((current) => {
      if (current && isSameLines(current.request.selection, request.selection)) return null;
      counter.current += 1;
      return { key: counter.current, request };
    });
  }, []);
  const close = useCallback(() => setShown(null), []);
  return { shown, open, toggle, close };
}

/** Whether both selections cover the same lines of the same file on the same side of a diff. */
function isSameLines(first: SelectionContext, second: SelectionContext): boolean {
  return (
    first.path === second.path && first.startLine === second.startLine && first.endLine === second.endLine && !!first.isOriginal === !!second.isOriginal
  );
}
