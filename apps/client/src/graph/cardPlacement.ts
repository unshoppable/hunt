import type { XYPosition } from "@xyflow/react";

/** Axis-aligned box in canvas coordinates. */
export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };
/**
 * What the card must not cover: the boxes of the lit dependencies and edge labels and points sampled along the lit
 * edges, all in canvas coordinates. The hovered file itself is passed separately as the anchor.
 */
export type Obstacles = { rects: Rect[]; points: XYPosition[] };

/** Space between the card and the canvas edge. */
export const CARD_GAP = 8;
/** Space between the card and the hovered file; short enough for the mouse to cross before the hover is released. */
export const ANCHOR_GAP = 24;
/** Distance between two grid spots tried when no spot next to the file is free. */
const GRID_STEP = 24;
/** Penalty of one sampled edge point under the card, comparable to a small patch of a covered box. */
const POINT_PENALTY = 100;

/**
 * Picks where the card of the hovered file goes. The spots next to the file come first: left of it, right of it,
 * above and below, aligned with the file's top or left edge, then with its bottom or right edge. After them every
 * spot of a grid over the canvas is tried. Every spot is pushed inside the canvas by at most `CARD_GAP` from its
 * border. The spot covering the least of what is lit wins (the file plus a margin counts as lit); among equals the
 * one closest to the file, and among those the earliest, so a free spot next to the file always beats a free spot
 * farther away.
 */
export function placeCard({ canvas, card, anchor, obstacles }: { canvas: Size; card: Size; anchor: Rect; obstacles: Obstacles }): XYPosition {
  const blocked: Obstacles = { rects: [inflate(anchor, ANCHOR_GAP), ...obstacles.rects], points: obstacles.points };
  let best: { spot: XYPosition; penalty: number; distance: number } | null = null;
  for (const candidate of [...spotsNextTo(anchor, card), ...gridSpots(canvas, card)]) {
    const spot = clampToCanvas(candidate, card, canvas);
    const rect = { left: spot.x, top: spot.y, right: spot.x + card.width, bottom: spot.y + card.height };
    const penalty = coverage(rect, blocked);
    const distance = gap(rect, anchor);
    if (!best || penalty < best.penalty || (penalty === best.penalty && distance < best.distance)) {
      best = { spot, penalty, distance };
    }
  }
  return best?.spot ?? { x: CARD_GAP, y: CARD_GAP };
}

function spotsNextTo(anchor: Rect, card: Size): XYPosition[] {
  return [
    { x: anchor.left - ANCHOR_GAP - card.width, y: anchor.top },
    { x: anchor.right + ANCHOR_GAP, y: anchor.top },
    { x: anchor.left, y: anchor.top - ANCHOR_GAP - card.height },
    { x: anchor.left, y: anchor.bottom + ANCHOR_GAP },
    { x: anchor.left - ANCHOR_GAP - card.width, y: anchor.bottom - card.height },
    { x: anchor.right + ANCHOR_GAP, y: anchor.bottom - card.height },
    { x: anchor.right - card.width, y: anchor.top - ANCHOR_GAP - card.height },
    { x: anchor.right - card.width, y: anchor.bottom + ANCHOR_GAP },
  ];
}

function gridSpots(canvas: Size, card: Size): XYPosition[] {
  const spots: XYPosition[] = [];
  for (let y = CARD_GAP; y <= canvas.height - CARD_GAP - card.height; y += GRID_STEP) {
    for (let x = CARD_GAP; x <= canvas.width - CARD_GAP - card.width; x += GRID_STEP) {
      spots.push({ x, y });
    }
  }
  return spots;
}

function clampToCanvas(spot: XYPosition, card: Size, canvas: Size): XYPosition {
  return {
    x: Math.max(CARD_GAP, Math.min(spot.x, canvas.width - CARD_GAP - card.width)),
    y: Math.max(CARD_GAP, Math.min(spot.y, canvas.height - CARD_GAP - card.height)),
  };
}

function inflate(rect: Rect, by: number): Rect {
  return { left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by };
}

/** Shortest distance between two boxes; zero when they touch or overlap. */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
  return Math.hypot(dx, dy);
}

/** Covered area of the boxes plus a penalty per covered edge point; zero when the card covers nothing lit. */
function coverage(card: Rect, obstacles: Obstacles): number {
  let penalty = 0;
  for (const rect of obstacles.rects) {
    const width = Math.min(card.right, rect.right) - Math.max(card.left, rect.left);
    const height = Math.min(card.bottom, rect.bottom) - Math.max(card.top, rect.top);
    if (width > 0 && height > 0) {
      penalty += width * height;
    }
  }
  for (const point of obstacles.points) {
    if (point.x >= card.left && point.x <= card.right && point.y >= card.top && point.y <= card.bottom) {
      penalty += POINT_PENALTY;
    }
  }
  return penalty;
}
