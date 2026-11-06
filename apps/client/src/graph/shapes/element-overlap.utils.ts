import type { XYPosition } from "@xyflow/react";

/** An element at its place in flow coordinates. */
export type PlacedBox = XYPosition & { id: string; width: number; height: number };

/** Room left between an element moved aside and the others: enough for a connection to pass between them. */
const ELEMENT_GAP = 48;

/**
 * The places of `boxes` with no two of them overlapping. Each box in turn keeps its place unless it overlaps a box
 * before it; then it moves the shortest way, horizontally or vertically, next to one of those boxes, to a spot that
 * keeps `ELEMENT_GAP` to all of them. Earlier boxes win, so the caller lists those that should stay first.
 */
export function placeWithoutOverlaps(boxes: PlacedBox[]): Map<string, XYPosition> {
  const placed: PlacedBox[] = [];
  for (const box of boxes) {
    const isFree = (x: number, y: number, gap: number) =>
      placed.every((other) => x >= other.x + other.width + gap || x + box.width + gap <= other.x || y >= other.y + other.height + gap || y + box.height + gap <= other.y);
    if (isFree(box.x, box.y, 0)) {
      placed.push(box);
      continue;
    }
    // Right of the right-most box is always free, so there is a spot.
    const spots = placed.flatMap((other) => [
      { x: other.x + other.width + ELEMENT_GAP, y: box.y },
      { x: other.x - box.width - ELEMENT_GAP, y: box.y },
      { x: box.x, y: other.y + other.height + ELEMENT_GAP },
      { x: box.x, y: other.y - box.height - ELEMENT_GAP },
    ]);
    const free = spots.filter((spot) => isFree(spot.x, spot.y, ELEMENT_GAP));
    const nearest = free.reduce((best, spot) => (Math.abs(spot.x - box.x) + Math.abs(spot.y - box.y) < Math.abs(best.x - box.x) + Math.abs(best.y - box.y) ? spot : best));
    placed.push({ ...box, ...nearest });
  }
  return new Map(placed.map((box) => [box.id, { x: box.x, y: box.y }]));
}
