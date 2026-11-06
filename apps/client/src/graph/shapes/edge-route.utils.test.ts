import { Position, type XYPosition } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { countCrossings, isMovableSegment, moveSegment, routeAroundObstacles, routeConnections, routeThroughBends, type Obstacle } from "./edge-route.utils";

/** True when a segment of the route runs through the inside of `obstacle`. */
function crosses(points: XYPosition[], obstacle: Obstacle): boolean {
  return points.slice(1).some((point, index) => {
    const before = points[index];
    const [left, right] = [Math.min(before.x, point.x), Math.max(before.x, point.x)];
    const [top, bottom] = [Math.min(before.y, point.y), Math.max(before.y, point.y)];
    return left < obstacle.x + obstacle.width && right > obstacle.x && top < obstacle.y + obstacle.height && bottom > obstacle.y;
  });
}

/** Smallest distance between `obstacle` and a segment of the polyline through `points`. */
function distance(points: XYPosition[], obstacle: Obstacle): number {
  return Math.min(
    ...points.slice(1).map((point, index) => {
      const before = points[index];
      const dx = Math.max(obstacle.x - Math.max(before.x, point.x), 0, Math.min(before.x, point.x) - obstacle.x - obstacle.width);
      const dy = Math.max(obstacle.y - Math.max(before.y, point.y), 0, Math.min(before.y, point.y) - obstacle.y - obstacle.height);
      return Math.hypot(dx, dy);
    }),
  );
}

function isOrthogonal(points: XYPosition[]): boolean {
  return points.slice(1).every((point, index) => point.x === points[index].x || point.y === points[index].y);
}

describe("routeAroundObstacles", () => {
  it("runs straight between two facing handles with nothing in between", () => {
    const source: Obstacle = { x: 0, y: 0, width: 200, height: 100 };
    const target: Obstacle = { x: 400, y: 0, width: 200, height: 100 };
    const route = routeAroundObstacles({ x: 200, y: 50, side: Position.Right }, { x: 400, y: 50, side: Position.Left }, [source, target]);
    expect(route).toEqual([
      { x: 200, y: 50 },
      { x: 400, y: 50 },
    ]);
  });

  it("goes around a table that sits between the two it connects", () => {
    const source: Obstacle = { x: 0, y: 0, width: 300, height: 300 };
    const between: Obstacle = { x: 450, y: 0, width: 300, height: 400 };
    const target: Obstacle = { x: 900, y: 1000, width: 300, height: 300 };
    const obstacles = [source, between, target];
    const route = routeAroundObstacles({ x: 300, y: 180, side: Position.Right }, { x: 900, y: 1070, side: Position.Left }, obstacles)!;
    expect(route[0]).toEqual({ x: 300, y: 180 });
    expect(route[route.length - 1]).toEqual({ x: 900, y: 1070 });
    expect(isOrthogonal(route)).toBe(true);
    expect(crosses(route, between)).toBe(false);
  });

  it("leaves and enters each handle straight out of its side", () => {
    const source: Obstacle = { x: 0, y: 0, width: 200, height: 100 };
    const target: Obstacle = { x: 0, y: 300, width: 200, height: 100 };
    const route = routeAroundObstacles({ x: 200, y: 50, side: Position.Right }, { x: 0, y: 350, side: Position.Left }, [source, target])!;
    expect(route[1].y).toBe(50);
    expect(route[1].x).toBeGreaterThan(200);
    expect(route[route.length - 2].y).toBe(350);
    expect(route[route.length - 2].x).toBeLessThan(0);
    expect(crosses(route, source) || crosses(route, target)).toBe(false);
  });

  it("loops around the table of a relationship onto itself", () => {
    const table: Obstacle = { x: 0, y: 0, width: 200, height: 200 };
    const route = routeAroundObstacles({ x: 200, y: 60, side: Position.Right }, { x: 0, y: 120, side: Position.Left }, [table])!;
    expect(isOrthogonal(route)).toBe(true);
    expect(crosses(route, table)).toBe(false);
  });

  it("prefers fewer bends over a slightly shorter way", () => {
    const source: Obstacle = { x: 0, y: 0, width: 200, height: 100 };
    const target: Obstacle = { x: 400, y: 200, width: 200, height: 100 };
    const route = routeAroundObstacles({ x: 200, y: 50, side: Position.Right }, { x: 400, y: 250, side: Position.Left }, [source, target])!;
    expect(route).toHaveLength(4);
  });

  it("runs down the middle of a gap too narrow to keep the comfortable distance", () => {
    const source: Obstacle = { x: 0, y: 0, width: 200, height: 100 };
    const upper: Obstacle = { x: 300, y: -500, width: 200, height: 860 };
    const lower: Obstacle = { x: 300, y: 420, width: 200, height: 800 };
    const target: Obstacle = { x: 700, y: 600, width: 200, height: 100 };
    const route = routeAroundObstacles({ x: 200, y: 50, side: Position.Right }, { x: 700, y: 650, side: Position.Left }, [source, upper, lower, target])!;
    expect(route.some((point) => point.y === 390)).toBe(true);
    expect(crosses(route, upper) || crosses(route, lower)).toBe(false);
  });

  it("keeps the comfortable distance to the elements when there is room", () => {
    const source: Obstacle = { x: 0, y: 0, width: 200, height: 100 };
    const between: Obstacle = { x: 300, y: 150, width: 200, height: 400 };
    const target: Obstacle = { x: 800, y: 600, width: 200, height: 100 };
    const route = routeAroundObstacles({ x: 200, y: 50, side: Position.Right }, { x: 800, y: 650, side: Position.Left }, [source, between, target])!;
    expect(distance(route.slice(1, -1), between)).toBeGreaterThanOrEqual(48);
  });

  it("finds no way when the target's handle is walled in", () => {
    const source: Obstacle = { x: 0, y: 0, width: 100, height: 100 };
    const walls: Obstacle[] = [
      { x: 300, y: 100, width: 300, height: 20 },
      { x: 300, y: 300, width: 300, height: 20 },
      { x: 300, y: 100, width: 20, height: 220 },
      { x: 580, y: 100, width: 20, height: 220 },
    ];
    expect(routeAroundObstacles({ x: 100, y: 50, side: Position.Right }, { x: 450, y: 210, side: Position.Left }, [source, ...walls])).toBeNull();
  });
});

describe("routeAroundObstacles with routed connections", () => {
  const source: Obstacle = { x: 0, y: 0, width: 200, height: 300 };
  const target: Obstacle = { x: 600, y: 0, width: 200, height: 300 };

  it("runs beside a connection on its way instead of on top of it", () => {
    const routed = { id: "other", source: { x: 200, y: 50, side: Position.Right }, target: { x: 600, y: 250, side: Position.Left }, points: [{ x: 200, y: 50 }, { x: 400, y: 50 }, { x: 400, y: 250 }, { x: 600, y: 250 }] };
    const route = routeAroundObstacles({ x: 200, y: 250, side: Position.Right }, { x: 600, y: 50, side: Position.Left }, [source, target], [routed])!;
    expect(isOrthogonal(route)).toBe(true);
    expect(route.some((point) => point.x === 400)).toBe(false);
  });

  it("counts a run through the corner of a connection as crossing it", () => {
    // The other connection turns at (400, 50): a run along y = 50 that reaches x = 400 from the left would cut its corner.
    const other = { id: "other", source: { x: 200, y: 50, side: Position.Right }, target: { x: 600, y: 250, side: Position.Left }, points: [{ x: 200, y: 50 }, { x: 400, y: 50 }, { x: 400, y: 250 }, { x: 600, y: 250 }] };
    const route = routeAroundObstacles({ x: 200, y: 150, side: Position.Right }, { x: 600, y: 50, side: Position.Left }, [source, target], [other])!;
    expect(route.some((point) => point.y === 50 && point.x < 400)).toBe(false);
  });

  it("may run on top of a connection that ends in the same handle", () => {
    const sibling = { id: "sibling", source: { x: 200, y: 20, side: Position.Right }, target: { x: 600, y: 50, side: Position.Left }, points: [{ x: 200, y: 20 }, { x: 400, y: 20 }, { x: 400, y: 50 }, { x: 600, y: 50 }] };
    const route = routeAroundObstacles({ x: 200, y: 80, side: Position.Right }, { x: 600, y: 50, side: Position.Left }, [source, target], [sibling])!;
    expect(route).toHaveLength(4);
    const lastRun = route.slice(-2);
    expect(lastRun[0].y).toBe(50);
    expect(lastRun[0].x).toBeLessThan(600);
  });
});

describe("routeConnections", () => {
  it("routes every connection clear of the others and returns them by id", async () => {
    const left: Obstacle = { x: 0, y: 0, width: 200, height: 200 };
    const right: Obstacle = { x: 600, y: 0, width: 200, height: 200 };
    const routes = await routeConnections(
      [
        { id: "upper", source: { x: 200, y: 50, side: Position.Right }, target: { x: 600, y: 150, side: Position.Left } },
        { id: "lower", source: { x: 200, y: 150, side: Position.Right }, target: { x: 600, y: 50, side: Position.Left } },
        { id: "straight", source: { x: 200, y: 180, side: Position.Right }, target: { x: 600, y: 180, side: Position.Left } },
      ],
      [left, right],
    );
    expect([...routes.keys()].sort()).toEqual(["lower", "straight", "upper"]);
    const points = [...routes.values()].map((route) => route!);
    expect(points.every((route) => isOrthogonal(route))).toBe(true);
    // The two that swap rows must cross once; neither crosses the straight one below them.
    expect(countCrossings(points)).toBe(1);
    expect(routes.get("straight")).toEqual([
      { x: 200, y: 180 },
      { x: 600, y: 180 },
    ]);
  });

  it("returns null for a connection the obstacles wall in", async () => {
    const walls: Obstacle[] = [
      { x: 300, y: 100, width: 300, height: 20 },
      { x: 300, y: 300, width: 300, height: 20 },
      { x: 300, y: 100, width: 20, height: 220 },
      { x: 580, y: 100, width: 20, height: 220 },
    ];
    const routes = await routeConnections([{ id: "in", source: { x: 100, y: 50, side: Position.Right }, target: { x: 450, y: 210, side: Position.Left } }], walls);
    expect(routes.get("in")).toBeNull();
  });

  it("rejects once the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const connections = Array.from({ length: 40 }, (_, index) => ({ id: String(index), source: { x: 0, y: index * 30, side: Position.Right }, target: { x: 2000, y: 1500 - index * 30, side: Position.Left } }));
    await expect(routeConnections(connections, [], controller.signal)).rejects.toThrow();
  });
});

describe("countCrossings", () => {
  it("counts a horizontal run of one route meeting a vertical run of another, not runs that merge", () => {
    const across = [{ x: 0, y: 50 }, { x: 100, y: 50 }];
    const down = [{ x: 50, y: 0 }, { x: 50, y: 100 }];
    const merging = [{ x: 0, y: 80 }, { x: 50, y: 80 }, { x: 50, y: 100 }];
    expect(countCrossings([across, down])).toBe(1);
    expect(countCrossings([down, merging])).toBe(0);
    expect(countCrossings([across])).toBe(0);
  });
});

describe("routeThroughBends", () => {
  it("runs through the corners the user fixed", () => {
    const bends = [
      { x: 260, y: 50 },
      { x: 260, y: 400 },
    ];
    expect(routeThroughBends({ x: 200, y: 50, side: Position.Right }, { x: 500, y: 400, side: Position.Left }, bends)).toEqual([
      { x: 200, y: 50 },
      { x: 260, y: 50 },
      { x: 260, y: 400 },
      { x: 500, y: 400 },
    ]);
  });

  it("keeps leaving and entering the handles straight after the elements moved", () => {
    const bends = [
      { x: 260, y: 50 },
      { x: 260, y: 400 },
    ];
    expect(routeThroughBends({ x: 200, y: 80, side: Position.Right }, { x: 500, y: 300, side: Position.Left }, bends)).toEqual([
      { x: 200, y: 80 },
      { x: 260, y: 80 },
      { x: 260, y: 300 },
      { x: 500, y: 300 },
    ]);
  });

  it("adds a corner where a step is no longer horizontal or vertical", () => {
    const bends = [
      { x: 260, y: 50 },
      { x: 300, y: 200 },
      { x: 400, y: 400 },
    ];
    const route = routeThroughBends({ x: 200, y: 50, side: Position.Right }, { x: 500, y: 400, side: Position.Left }, bends);
    expect(isOrthogonal(route)).toBe(true);
  });
});

describe("moveSegment", () => {
  const route = [
    { x: 200, y: 50 },
    { x: 260, y: 50 },
    { x: 260, y: 400 },
    { x: 500, y: 400 },
  ];

  it("moves a vertical segment sideways and a horizontal one up or down", () => {
    expect(moveSegment(route, 1, { x: 40, y: 15 })).toEqual([
      { x: 200, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 400 },
      { x: 500, y: 400 },
    ]);
    const stepped = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 200 }, { x: 200, y: 200 }];
    expect(moveSegment(stepped, 2, { x: 10, y: -30 })[2]).toEqual({ x: 40, y: 70 });
  });

  it("keeps the segments at the handles fixed", () => {
    expect([0, 1, 2].map((index) => isMovableSegment(route, index))).toEqual([false, true, false]);
  });
});
