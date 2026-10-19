import { describe, expect, it } from "vitest";
import { layoutGraph } from "./commitGraph";

const commit = (id: string, ...parents: string[]) => ({ id, parents });

describe("layoutGraph", () => {
  it("keeps a linear history in one lane with one color", () => {
    const rows = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.color)).toEqual([0, 0, 0]);
    expect(rows[0].segments).toEqual([{ kind: "out", to: 0, color: 0 }]);
    expect(rows[1].segments).toEqual([
      { kind: "in", from: 0, color: 0 },
      { kind: "out", to: 0, color: 0 },
    ]);
    expect(rows[2].segments).toEqual([{ kind: "in", from: 0, color: 0 }]);
    expect(rows.every((row) => row.laneCount === 1)).toBe(true);
  });

  it("opens a second lane for the second parent of a merge and joins it again at the common ancestor", () => {
    // m merges f into the main line: m -> (b, f), f -> a, b -> a.
    const rows = layoutGraph([commit("m", "b", "f"), commit("f", "a"), commit("b", "a"), commit("a")]);
    expect(rows[0]).toMatchObject({ lane: 0, color: 0, laneCount: 2 });
    expect(rows[0].segments).toEqual([
      { kind: "out", to: 0, color: 0 },
      { kind: "out", to: 1, color: 1 },
    ]);
    // f sits in lane 1 while the main line passes through lane 0.
    expect(rows[1]).toMatchObject({ lane: 1, color: 1 });
    expect(rows[1].segments).toEqual([
      { kind: "in", from: 1, color: 1 },
      { kind: "through", lane: 0, color: 0 },
      { kind: "out", to: 1, color: 1 },
    ]);
    // b continues lane 0; lane 1 still waits for a.
    expect(rows[2]).toMatchObject({ lane: 0, color: 0 });
    // a receives both lanes and closes lane 1.
    expect(rows[3].segments).toEqual([
      { kind: "in", from: 0, color: 0 },
      { kind: "in", from: 1, color: 1 },
    ]);
    expect(rows[3].laneCount).toBe(2);
  });

  it("starts a new colored lane for a branch tip that no commit above points at", () => {
    // Two tips: x (branch) and c (master), both on top of a.
    const rows = layoutGraph([commit("x", "a"), commit("c", "a"), commit("a")]);
    expect(rows[0]).toMatchObject({ lane: 0, color: 0 });
    expect(rows[1]).toMatchObject({ lane: 1, color: 1 });
    expect(rows[1].segments).toEqual([
      { kind: "through", lane: 0, color: 0 },
      { kind: "out", to: 1, color: 1 },
    ]);
    expect(rows[2].lane).toBe(0);
  });

  it("reuses a freed lane and never repeats a color while a lane is open", () => {
    const rows = layoutGraph([commit("t1", "a"), commit("t2", "a"), commit("a", "z"), commit("t3", "z"), commit("z")]);
    expect(rows[3].lane).toBe(1);
    expect(rows[3].color).toBe(2);
  });

  it("ignores a parent listed twice", () => {
    const rows = layoutGraph([commit("m", "a", "a"), commit("a")]);
    expect(rows[0].segments).toEqual([{ kind: "out", to: 0, color: 0 }]);
  });
});
