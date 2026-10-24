import type { ScreenRect } from "../ipc/types";
import type { PopupSize } from "../state/settings";

/**
 * Where a popup window opens relative to its host window's page: with its top-left corner at a point of the page (CSS
 * px), centered on the page, or centered horizontally near its top like a command palette (see ui/Modal.tsx).
 */
export type PopupAnchor = { x: number; y: number } | "center" | "top";

/** Share of the page height above a popup that opens near the top, as `Modal`'s `pt-[8vh]`. */
const TOP_SHARE = 0.08;

/** The popup window's bounds on screen for `anchor`, given the host page's bounds on screen and the popup's size. */
export function popupBounds(anchor: PopupAnchor, page: ScreenRect, size: PopupSize): ScreenRect {
  if (anchor === "center" || anchor === "top") {
    const x = page.x + (page.width - size.width) / 2;
    const y = anchor === "top" ? page.y + page.height * TOP_SHARE : page.y + (page.height - size.height) / 2;
    return rounded({ x, y, ...size });
  }
  return rounded({ x: page.x + anchor.x, y: page.y + anchor.y, ...size });
}

/**
 * `bounds` moved into the work area that holds its top-left corner, or the nearest one when none does, and shrunk to
 * that area when it is larger; without areas it stays as it is.
 */
export function fitIntoWorkArea(bounds: ScreenRect, areas: readonly ScreenRect[]): ScreenRect {
  const area = areas.find((candidate) => contains(candidate, bounds.x, bounds.y)) ?? nearest(areas, bounds.x, bounds.y);
  if (!area) return bounds;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

function contains(area: ScreenRect, x: number, y: number): boolean {
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}

function nearest(areas: readonly ScreenRect[], x: number, y: number): ScreenRect | undefined {
  let best: { area: ScreenRect; distance: number } | undefined;
  for (const area of areas) {
    const dx = Math.max(area.x - x, 0, x - (area.x + area.width));
    const dy = Math.max(area.y - y, 0, y - (area.y + area.height));
    const distance = dx * dx + dy * dy;
    if (!best || distance < best.distance) {
      best = { area, distance };
    }
  }
  return best?.area;
}

function rounded(bounds: ScreenRect): ScreenRect {
  return { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
}
