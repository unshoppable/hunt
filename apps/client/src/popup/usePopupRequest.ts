import { useCallback, useState } from "react";

/** The last request to show a popup: its value and how many requests came since the popup opened. */
type ShowRequest<Value> = { value: Value; revision: number };

/**
 * State of a popup that a shortcut shows: each `show` replaces the value and counts up `revision`, also while the popup
 * is open, so that its window comes to the front again (see useDetachedPopup.ts); `close` drops the request.
 */
export function usePopupRequest<Value>(): { request: ShowRequest<Value> | null; show: (value: Value) => void; close: () => void } {
  const [request, setRequest] = useState<ShowRequest<Value> | null>(null);
  const show = useCallback((value: Value) => setRequest((current) => ({ value, revision: (current?.revision ?? 0) + 1 })), []);
  const close = useCallback(() => setRequest(null), []);
  return { request, show, close };
}
