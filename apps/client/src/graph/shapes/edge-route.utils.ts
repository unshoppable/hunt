import { Position, type XYPosition } from "@xyflow/react";

/** A rectangle in flow coordinates that a route must go around: an element of the diagram. */
export type Obstacle = { x: number; y: number; width: number; height: number };
/** Where a route starts or ends: a handle and the side of its element it sits on. */
export type RouteEnd = XYPosition & { side: Position };

/** Room a route always keeps around every element. */
const CLEARANCE = 16;
/** Room a route keeps around every element when there is space for it; closer runs cost extra length. */
const COMFORT = 48;
/** Extra cost per px of a run along an element at `CLEARANCE`; it falls to 0 at `COMFORT`. */
const CLOSENESS_COST = 2;
/** How far around the box spanned by a route's two ends the elements still shape the grid. */
const NEARBY = 240;
/** Straight run out of a handle before the first bend; longer than the clearance, so a crow's foot sits on it. */
const STUB = 28;
/** What a bend costs in px of length: a route takes a detour of up to this much to save one. */
const BEND_COST = 40;

/** Unit steps of the four directions, in the order right, down, left, up; `(d + 2) % 4` reverses `d`. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const SIDE_DIRECTION: Record<Position, number> = { [Position.Right]: 0, [Position.Bottom]: 1, [Position.Left]: 2, [Position.Top]: 3 };

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * An orthogonal route from `source` to `target` that crosses no obstacle: it leaves and enters each handle straight
 * out of its side, keeps `CLEARANCE` to every element (the two it connects included), `COMFORT` where there is room,
 * and takes the shortest way with the fewest bends. A* runs on a grid of lines along the elements at both distances
 * and through the middle of the gaps between them, so a route through a narrow gap runs down its middle.
 * Returns the corner points from handle to handle, or null when the obstacles leave no way.
 */
export function routeAroundObstacles(source: RouteEnd, target: RouteEnd, obstacles: Obstacle[]): XYPosition[] | null {
  const startDirection = SIDE_DIRECTION[source.side];
  const endDirection = (SIDE_DIRECTION[target.side] + 2) % 4;
  const start = { x: source.x + DX[startDirection] * STUB, y: source.y + DY[startDirection] * STUB };
  const end = { x: target.x - DX[endDirection] * STUB, y: target.y - DY[endDirection] * STUB };
  // An element the stub already ends in cannot be avoided; the route ignores it instead of finding no way at all.
  const kept = obstacles.filter((obstacle) => !isInside(padded(obstacle, CLEARANCE), start.x, start.y) && !isInside(padded(obstacle, CLEARANCE), end.x, end.y));

  // The grid comes from the elements near the two ends first: a route rarely leaves that area, and the other elements
  // still block it. Only when that grid leaves no way do all elements shape it.
  const area = padded({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }, NEARBY);
  const nearby = kept.filter((obstacle) => overlaps(padded(obstacle, 0), area));
  const route = searchGrid(start, end, startDirection, endDirection, kept, nearby) ?? (nearby.length < kept.length ? searchGrid(start, end, startDirection, endDirection, kept, kept) : null);
  return route && withoutStraightPoints([{ x: source.x, y: source.y }, ...route, { x: target.x, y: target.y }]);
}

/**
 * A* from `start`, entered in `startDirection`, to `end`, left in `endDirection`, on the grid lines of `shaping`,
 * around all of `obstacles`. Returns the grid points of the cheapest way, or null when there is none.
 */
function searchGrid(start: XYPosition, end: XYPosition, startDirection: number, endDirection: number, obstacles: Obstacle[], shaping: Obstacle[]): XYPosition[] | null {
  const boxes = obstacles.map((obstacle) => padded(obstacle, CLEARANCE));
  const elements = obstacles.map((obstacle) => padded(obstacle, 0));
  const xs = gridLines(start.x, end.x, shaping.map((obstacle) => [obstacle.x, obstacle.x + obstacle.width]));
  const ys = gridLines(start.y, end.y, shaping.map((obstacle) => [obstacle.y, obstacle.y + obstacle.height]));
  const columns = xs.length;
  const cellCount = columns * ys.length;
  const startCell = ys.indexOf(start.y) * columns + xs.indexOf(start.x);
  const endCell = ys.indexOf(end.y) * columns + xs.indexOf(end.x);
  const isFree = (x: number, y: number) => {
    for (const box of boxes) if (isInside(box, x, y)) return false;
    return true;
  };
  // Whether a cell lies outside every element (0 not yet known), and the cost of the step to the cell on the right
  // (`2 * cell`) and below (`2 * cell + 1`): NaN not yet known, Infinity when it crosses an element. The search asks for
  // the same cells and steps many times, so each is worked out once.
  const freeCells = new Int8Array(cellCount);
  const stepCosts = new Float64Array(cellCount * 2).fill(NaN);
  const isFreeCell = (cell: number) => {
    if (!freeCells[cell]) freeCells[cell] = isFree(xs[cell % columns], ys[Math.floor(cell / columns)]) ? 1 : -1;
    return freeCells[cell] > 0;
  };
  /**
   * Cost of the step between `cell` and its neighbour to the right or below: its length plus the extra for running
   * closer than `COMFORT` to an element. No padded border lies strictly between two neighbouring grid lines, so the
   * step crosses an element exactly when its middle does.
   */
  const stepCost = (cell: number, isDown: boolean) => {
    const key = cell * 2 + (isDown ? 1 : 0);
    if (Number.isNaN(stepCosts[key])) {
      const neighbour = isDown ? cell + columns : cell + 1;
      const [x1, y1, x2, y2] = [xs[cell % columns], ys[Math.floor(cell / columns)], xs[neighbour % columns], ys[Math.floor(neighbour / columns)]];
      if (!isFreeCell(cell) || !isFreeCell(neighbour) || !isFree((x1 + x2) / 2, (y1 + y2) / 2)) {
        stepCosts[key] = Infinity;
      } else {
        let distance = COMFORT;
        for (const element of elements) distance = Math.min(distance, distanceToSegment(element, x1, y1, x2, y2));
        stepCosts[key] = (x2 - x1 + y2 - y1) * (1 + (CLOSENESS_COST * (COMFORT - distance)) / (COMFORT - CLEARANCE));
      }
    }
    return stepCosts[key];
  };
  const remaining = (cell: number) => Math.abs(xs[cell % columns] - end.x) + Math.abs(ys[Math.floor(cell / columns)] - end.y);

  // A state is a cell entered in one of the four directions, so a bend can cost more than its length.
  const cost = new Float64Array(cellCount * 4).fill(Infinity);
  const previous = new Int32Array(cellCount * 4).fill(-1);
  const open = new MinHeap();
  const startState = startCell * 4 + startDirection;
  cost[startState] = 0;
  open.push(startState, remaining(startCell));
  let goal = -1;
  while (open.size) {
    const state = open.pop();
    const cell = Math.floor(state / 4);
    if (cell === endCell) {
      goal = state;
      break;
    }
    const direction = state % 4;
    const column = cell % columns;
    const row = Math.floor(cell / columns);
    for (let next = 0; next < 4; next++) {
      if (next === (direction + 2) % 4) continue;
      const nextColumn = column + DX[next];
      const nextRow = row + DY[next];
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= ys.length) continue;
      const nextCell = nextRow * columns + nextColumn;
      const step = next < 2 ? stepCost(cell, next === 1) : stepCost(nextCell, next === 3);
      if (step === Infinity) continue;
      // Entering the end cell already pays for the bend into the target's handle.
      const isEnd = nextCell === endCell;
      if (isEnd && next === (endDirection + 2) % 4) continue;
      const bends = (next === direction ? 0 : 1) + (isEnd && next !== endDirection ? 1 : 0);
      const nextCost = cost[state] + step + bends * BEND_COST;
      const nextState = nextCell * 4 + next;
      if (nextCost >= cost[nextState]) continue;
      cost[nextState] = nextCost;
      previous[nextState] = state;
      open.push(nextState, nextCost + remaining(nextCell));
    }
  }
  if (goal < 0) return null;

  const cells: XYPosition[] = [];
  for (let state = goal; state >= 0; state = previous[state]) {
    const cell = Math.floor(state / 4);
    cells.push({ x: xs[cell % columns], y: ys[Math.floor(cell / columns)] });
  }
  return cells.reverse();
}

/**
 * The course of a connection through the corners the user fixed: the first and the last corner follow their handle,
 * so the connection still leaves and enters it straight after an element moved, and a step that is no longer
 * horizontal or vertical gets a corner of its own. Returns the corner points from handle to handle.
 */
export function routeThroughBends(source: RouteEnd, target: RouteEnd, bends: XYPosition[]): XYPosition[] {
  const corners = bends.map((bend) => ({ x: bend.x, y: bend.y }));
  alignWith(corners[0], source);
  alignWith(corners[corners.length - 1], target);
  const points: XYPosition[] = [{ x: source.x, y: source.y }];
  for (const point of [...corners, { x: target.x, y: target.y }]) {
    const before = points[points.length - 1];
    if (before.x !== point.x && before.y !== point.y) {
      points.push({ x: point.x, y: before.y });
    }
    points.push(point);
  }
  return withoutStraightPoints(points);
}

/** True for a segment of `points` the user may move: every one but the two that leave and enter a handle. */
export function isMovableSegment(points: XYPosition[], index: number): boolean {
  return index >= 1 && index <= points.length - 3;
}

/** The corner points with segment `index` (from `points[index]` to the next) moved across its direction by `offset`. */
export function moveSegment(points: XYPosition[], index: number, offset: XYPosition): XYPosition[] {
  const isHorizontal = points[index].y === points[index + 1].y;
  return points.map((point, position) => {
    if (position !== index && position !== index + 1) return point;
    return isHorizontal ? { x: point.x, y: point.y + offset.y } : { x: point.x + offset.x, y: point.y };
  });
}

/** Moves `corner` onto the line its handle leaves along, so the run between them is straight. */
function alignWith(corner: XYPosition, end: RouteEnd) {
  if (end.side === Position.Left || end.side === Position.Right) {
    corner.y = end.y;
  } else {
    corner.x = end.x;
  }
}

function padded(obstacle: Obstacle, room: number): Box {
  return { left: obstacle.x - room, top: obstacle.y - room, right: obstacle.x + obstacle.width + room, bottom: obstacle.y + obstacle.height + room };
}

/**
 * The grid lines on one axis: the route's ends, each element's sides at `CLEARANCE` and at `COMFORT`, and the middle
 * between every two neighbouring sides at `CLEARANCE`, so a route can take the middle of a gap too narrow for `COMFORT`.
 */
function gridLines(start: number, end: number, spans: [number, number][]): number[] {
  const borders = uniqueSorted(spans.flatMap(([low, high]) => [low - CLEARANCE, high + CLEARANCE]));
  const middles = borders.slice(1).map((border, index) => (border + borders[index]) / 2);
  const comfortable = spans.flatMap(([low, high]) => [low - COMFORT, high + COMFORT]);
  return uniqueSorted([start, end, ...borders, ...middles, ...comfortable]);
}

/** Distance between an element and the axis-parallel segment from (x1, y1) to (x2, y2); 0 when they touch. */
function distanceToSegment(box: Box, x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.max(box.left - Math.max(x1, x2), 0, Math.min(x1, x2) - box.right);
  const dy = Math.max(box.top - Math.max(y1, y2), 0, Math.min(y1, y2) - box.bottom);
  return Math.hypot(dx, dy);
}

/** Strictly inside: a route may run along a padded border. */
function isInside(box: Box, x: number, y: number): boolean {
  return x > box.left && x < box.right && y > box.top && y < box.bottom;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The corners of the polyline through `points`: drops repeated points and those in the middle of a straight run. */
function withoutStraightPoints(points: XYPosition[]): XYPosition[] {
  const distinct = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  return distinct.filter((point, index) => {
    if (!index || index === distinct.length - 1) return true;
    const before = distinct[index - 1];
    const after = distinct[index + 1];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

/** Binary min-heap of states by priority, the open set of the A* search. */
class MinHeap {
  private readonly states: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.states.length;
  }

  push(state: number, priority: number): void {
    let index = this.states.length;
    this.states.push(state);
    this.priorities.push(priority);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent] <= priority) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop(): number {
    const top = this.states[0];
    const lastState = this.states.pop();
    const lastPriority = this.priorities.pop();
    if (this.states.length && lastState !== undefined && lastPriority !== undefined) {
      this.states[0] = lastState;
      this.priorities[0] = lastPriority;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.states.length && this.priorities[left] < this.priorities[smallest]) smallest = left;
        if (right < this.states.length && this.priorities[right] < this.priorities[smallest]) smallest = right;
        if (smallest === index) break;
        this.swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.states[a], this.states[b]] = [this.states[b], this.states[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
  }
}
