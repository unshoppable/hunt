import { describe, expect, it } from "vitest";
import { ANCHOR_GAP, placeCard, type Obstacles, type Rect } from "./cardPlacement";

const canvas = { width: 1200, height: 800 };
const card = { width: 300, height: 200 };
const anchor: Rect = { left: 500, top: 300, right: 700, bottom: 360 };
const nothing: Obstacles = { rects: [], points: [] };
/** Points of a vertical line at `x` from `top` to `bottom`, every 10 px. */
const line = (x: number, top: number, bottom: number) => Array.from({ length: (bottom - top) / 10 + 1 }, (_, index) => ({ x, y: top + index * 10 }));

describe("placeCard", () => {
  it("sits to the left of the file, top-aligned, when nothing lit is there", () => {
    expect(placeCard({ canvas, card, anchor, obstacles: nothing })).toEqual({ x: 500 - ANCHOR_GAP - 300, y: 300 });
  });

  it("moves to the right when a lit edge runs along the file's left side", () => {
    const obstacles: Obstacles = { rects: [], points: line(450, 300, 600) };
    expect(placeCard({ canvas, card, anchor, obstacles })).toEqual({ x: 700 + ANCHOR_GAP, y: 300 });
  });

  it("moves above the file when lit edges leave it on both sides", () => {
    const obstacles: Obstacles = { rects: [], points: [...line(450, 300, 600), ...line(750, 300, 600)] };
    expect(placeCard({ canvas, card, anchor, obstacles })).toEqual({ x: 500, y: 300 - ANCHOR_GAP - 200 });
  });

  it("moves below when a lit file sits above and lit edges run down both sides", () => {
    const above: Rect = { left: 500, top: 60, right: 700, bottom: 150 };
    const obstacles: Obstacles = { rects: [above], points: [...line(450, 300, 600), ...line(850, 300, 600)] };
    expect(placeCard({ canvas, card, anchor, obstacles })).toEqual({ x: 500, y: 360 + ANCHOR_GAP });
  });

  it("keeps the card inside the canvas and off the file when the file sits at the canvas border", () => {
    const atBorder: Rect = { left: 20, top: 20, right: 220, bottom: 80 };
    const spot = placeCard({ canvas, card, anchor: atBorder, obstacles: nothing });
    expect(spot).toEqual({ x: 220 + ANCHOR_GAP, y: 20 });
  });

  it("moves to the nearest free grid spot when every spot next to the file covers something lit", () => {
    const above: Rect = { left: 500, top: 0, right: 700, bottom: 292 };
    const below: Rect = { left: 500, top: 368, right: 700, bottom: 800 };
    const obstacles: Obstacles = { rects: [above, below], points: [...line(450, 0, 800), ...line(850, 0, 800)] };
    const spot = placeCard({ canvas, card, anchor, obstacles });
    expect(spot.x + card.width).toBeLessThanOrEqual(442);
    expect(spot.y + card.height).toBeGreaterThanOrEqual(anchor.top);
    expect(spot.y).toBeLessThanOrEqual(anchor.bottom);
  });

  it("covers the least when every spot covers something lit", () => {
    const everywhere: Rect = { left: 0, top: 0, right: 1200, bottom: 800 };
    const small: Rect = { left: 505, top: 100, right: 515, bottom: 110 };
    const obstacles: Obstacles = { rects: [everywhere, small], points: [] };
    const spot = placeCard({ canvas, card, anchor, obstacles });
    expect(spot).toEqual({ x: 500 - ANCHOR_GAP - 300, y: 300 });
  });
});
