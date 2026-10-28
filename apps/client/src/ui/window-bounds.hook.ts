import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readStoredBounds, writeStoredBounds, type WindowKind } from "./window-bounds.utils";

/** Delay between the last resize/move event and the write to storage. */
const REMEMBER_DELAY_MS = 300;

/** Keeps storage up to date with the current window's bounds so the next window of `kind` opens the same way. */
export function useRememberWindowBounds(kind: WindowKind): void {
  useEffect(() => {
    const window = getCurrentWindow();
    let timer: number | undefined;

    const remember = async () => {
      const [isFullscreen, isMaximized, scaleFactor, size, position] = await Promise.all([
        window.isFullscreen(),
        window.isMaximized(),
        window.scaleFactor(),
        window.innerSize(),
        window.outerPosition(),
      ]);
      if (isFullscreen) return;
      const logicalSize = size.toLogical(scaleFactor);
      const logicalPosition = position.toLogical(scaleFactor);
      const current = { width: logicalSize.width, height: logicalSize.height, x: logicalPosition.x, y: logicalPosition.y };
      // The maximized frame is not worth remembering; the bounds from before it come back once the window leaves that state.
      const previous = readStoredBounds()[kind];
      writeStoredBounds(kind, isMaximized ? { ...current, ...previous, maximized: true } : { ...current, maximized: false });
    };
    const schedule = () => {
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => void remember(), REMEMBER_DELAY_MS);
    };

    const subscriptions = [window.onResized(schedule), window.onMoved(schedule)];
    return () => {
      globalThis.clearTimeout(timer);
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [kind]);
}
