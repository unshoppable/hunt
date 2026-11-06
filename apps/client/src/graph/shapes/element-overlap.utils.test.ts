import { describe, expect, it } from "vitest";
import { placeWithoutOverlaps, type PlacedBox } from "./element-overlap.utils";

function overlap(a: PlacedBox, b: PlacedBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("placeWithoutOverlaps", () => {
  it("keeps boxes that overlap nothing where they are, close ones too", () => {
    const boxes = [
      { id: "a", x: 0, y: 0, width: 200, height: 100 },
      { id: "b", x: 210, y: 0, width: 200, height: 100 },
    ];
    expect(placeWithoutOverlaps(boxes)).toEqual(
      new Map([
        ["a", { x: 0, y: 0 }],
        ["b", { x: 210, y: 0 }],
      ]),
    );
  });

  it("moves a later box the shortest way next to the one it overlaps", () => {
    const boxes = [
      { id: "a", x: 0, y: 0, width: 200, height: 400 },
      { id: "b", x: 150, y: 100, width: 200, height: 100 },
    ];
    expect(placeWithoutOverlaps(boxes).get("b")).toEqual({ x: 248, y: 100 });
  });

  it("leaves no two boxes overlapping, however many were stacked", () => {
    const boxes = Array.from({ length: 12 }, (_, index) => ({ id: String(index), x: index * 20, y: index * 15, width: 300, height: 250 }));
    const places = placeWithoutOverlaps(boxes);
    const moved = boxes.map((box) => ({ ...box, ...places.get(box.id) }));
    for (const [index, box] of moved.entries()) {
      for (const other of moved.slice(index + 1)) expect(overlap(box, other)).toBe(false);
    }
    expect(places.get("0")).toEqual({ x: 0, y: 0 });
  });
});
