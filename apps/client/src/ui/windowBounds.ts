import { useEffect } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { availableMonitors, currentMonitor, getCurrentWindow, primaryMonitor, type Window } from "@tauri-apps/api/window";

/**
 * The kinds of native windows whose bounds are remembered: the main window, the per-session editor, diff and
 * guardrails windows and the settings window. Windows of one kind share their remembered bounds.
 */
export type WindowKind = "main" | "editor" | "diff" | "guardrails" | "settings";

const WINDOW_KINDS: readonly WindowKind[] = ["main", "editor", "diff", "guardrails", "settings"];

/** Where a window last was, in logical px; `maximized` keeps the size and position from before the window was maximized. */
export type WindowBounds = { width: number; height: number; x: number; y: number; maximized: boolean };

/** Remembered bounds ready to apply; the position is dropped when it no longer lies on a connected display. */
export type WindowPlacement = Omit<WindowBounds, "x" | "y"> & { x?: number; y?: number };

/**
 * localStorage key of the remembered bounds, one entry per window kind. Every window has its own copy of the zustand
 * stores, so the bounds bypass them and are read fresh from storage, which all windows share.
 */
const STORAGE_KEY = "hunt-window-bounds";

/** Delay between the last resize/move event and the write to storage. */
const REMEMBER_DELAY_MS = 300;

/** Width of a window that fills the screen on first open; a narrower work area gives the window its full width instead. */
const FILL_SCREEN_MAX_WIDTH = 1600;

function isWindowBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Record<string, unknown>;
  return (
    ["width", "height", "x", "y"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key])) &&
    typeof bounds.maximized === "boolean"
  );
}

function readStoredBounds(): Partial<Record<WindowKind, WindowBounds>> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    const result: Partial<Record<WindowKind, WindowBounds>> = {};
    for (const kind of WINDOW_KINDS) {
      const bounds = (stored as Record<string, unknown>)[kind];
      if (isWindowBounds(bounds)) {
        result[kind] = bounds;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredBounds(kind: WindowKind, bounds: WindowBounds): void {
  const rounded = { ...bounds, width: Math.round(bounds.width), height: Math.round(bounds.height), x: Math.round(bounds.x), y: Math.round(bounds.y) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStoredBounds(), [kind]: rounded }));
  } catch {
    // Storage may be unavailable; the window then simply opens with its defaults next time.
  }
}

/** The bounds `kind` was last seen with, or null when no window of that kind was remembered yet. */
export async function storedWindowPlacement(kind: WindowKind): Promise<WindowPlacement | null> {
  const bounds = readStoredBounds()[kind];
  if (!bounds) return null;
  // The probe is a point in the window's title row; a window whose title row is off every display cannot be dragged back.
  const probeX = bounds.x + bounds.width / 2;
  const probeY = bounds.y + 20;
  const monitors = await availableMonitors();
  const isOnScreen = monitors.some((monitor) => {
    const position = monitor.position.toLogical(monitor.scaleFactor);
    const size = monitor.size.toLogical(monitor.scaleFactor);
    return probeX >= position.x && probeX <= position.x + size.width && probeY >= position.y && probeY <= position.y + size.height;
  });
  if (isOnScreen) return bounds;
  return { width: bounds.width, height: bounds.height, maximized: bounds.maximized };
}

/**
 * Sizes `window` to the full height of its monitor's work area and to `FILL_SCREEN_MAX_WIDTH`, or the work area's
 * width when that is narrower, centred horizontally. Without a known monitor the window keeps its configured size.
 */
async function fillScreen(window: Window): Promise<void> {
  const monitor = (await currentMonitor()) ?? (await primaryMonitor());
  if (!monitor) return;
  const areaPosition = monitor.workArea.position.toLogical(monitor.scaleFactor);
  const areaSize = monitor.workArea.size.toLogical(monitor.scaleFactor);
  const width = Math.min(FILL_SCREEN_MAX_WIDTH, areaSize.width);
  await window.setSize(new LogicalSize(width, areaSize.height));
  await window.setPosition(new LogicalPosition(areaPosition.x + (areaSize.width - width) / 2, areaPosition.y));
}

/**
 * Applies the remembered bounds of `kind` to the current window. Without remembered bounds the window keeps its
 * configured size, or fills the screen (see `fillScreen`) when `fillScreenByDefault` is set.
 */
export async function restoreWindowBounds(kind: WindowKind, options: { fillScreenByDefault?: boolean } = {}): Promise<void> {
  const window = getCurrentWindow();
  const placement = await storedWindowPlacement(kind);
  if (!placement) {
    if (options.fillScreenByDefault) {
      await fillScreen(window);
    }
    return;
  }
  await window.setSize(new LogicalSize(placement.width, placement.height));
  if (placement.x !== undefined && placement.y !== undefined) {
    await window.setPosition(new LogicalPosition(placement.x, placement.y));
  } else {
    await window.center();
  }
  if (placement.maximized) {
    await window.maximize();
  }
}

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
