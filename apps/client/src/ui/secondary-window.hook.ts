import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WindowKind } from "./window-bounds.utils";
import { useRememberWindowBounds } from "./window-bounds.hook";

/**
 * The behaviour every secondary window shares: its bounds are remembered as `kind`, it shows itself once mounted
 * and `isReady` (at once by default), and the traffic light, Escape and ⌘W call `close` (see `useWindowCloseKeys`).
 */
export function useSecondaryWindow(kind: WindowKind, close: () => void | Promise<void>, options: { isReady?: boolean } = {}): void {
  const isReady = options.isReady ?? true;

  useRememberWindowBounds(kind);
  useWindowCloseKeys(close);

  useEffect(() => {
    if (!isReady) return;
    void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
  }, [isReady]);
}

/**
 * The traffic light, Escape and ⌘W call `close`, which decides whether the window really goes, e.g. after asking
 * about unsaved edits. Both keys listen in the bubble phase; whatever takes Escape itself (a popover, a Monaco widget,
 * a selection) stops its propagation and keeps the window open.
 */
export function useWindowCloseKeys(close: () => void | Promise<void>): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A focused Monaco editor calls preventDefault on every Escape, so for Escape only a stopped propagation counts as taken.
      const isCloseKey = event.key === "Escape" || (event.key.toLowerCase() === "w" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.defaultPrevented);
      if (!isCloseKey) return;
      event.preventDefault();
      void closeRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const subscription = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void closeRef.current();
    });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}
