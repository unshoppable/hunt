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
export const STUB = 28;
/** What a bend costs in px of length: a route takes a detour of up to this much to save one. */
const BEND_COST = 40;
/** What crossing a routed connection costs in px of length: a route takes a detour of up to this much to avoid one. */
const CROSSING_COST = 200;
/**
 * Extra cost per px of a run on top of a routed connection that does not end in the same handle; low, since a
 * narrow gap between elements often has room for one run only, and sharing it reads better than a detour that
 * crosses other connections.
 */
const OVERLAP_COST = 3;
/** Room between two connections that run side by side. */
const WIRE_GAP = 12;

/** Unit steps of the four directions, in the order right, down, left, up; `(d + 2) % 4` reverses `d`. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const SIDE_DIRECTION: Record<Position, number> = { [Position.Right]: 0, [Position.Bottom]: 1, [Position.Left]: 2, [Position.Top]: 3 };

type Box = { left: number; top: number; right: number; bottom: number };

/** A connection to route: its id and the two handles it joins. */
export type Connection = { id: string; source: RouteEnd; target: RouteEnd };
/** A connection with the corner points of its route from handle to handle, absent where the obstacles left no way. */
export type RoutedConnection = Connection & { points?: XYPosition[] };
/**
 * One straight run of a connection routed before, in flow coordinates, that a later route keeps clear of; a run
 * `isMerged` when both connections end in the same handle, so their runs may join on the way to it.
 */
type Wire = { a: XYPosition; b: XYPosition; isMerged: boolean };

/**
 * An orthogonal route from `source` to `target` that crosses no obstacle: it leaves and enters each handle straight
 * out of its side, keeps `CLEARANCE` to every element (the two it connects included), `COMFORT` where there is room,
 * and takes the shortest way with the fewest bends. A* runs on a grid of lines along the elements at both distances
 * and through the middle of the gaps between them, so a route through a narrow gap runs down its middle. The
 * `routed` connections are soft obstacles: crossing one costs `CROSSING_COST`, running on top of one `OVERLAP_COST`
 * per px, so the route keeps `WIRE_GAP` beside them where it can; a connection into the same handle costs nothing
 * on the way to it. Returns the corner points from handle to handle, or null when the obstacles leave no way.
 */
export function routeAroundObstacles(source: RouteEnd, target: RouteEnd, obstacles: Obstacle[], routed: RoutedConnection[] = []): XYPosition[] | null {
  const startDirection = SIDE_DIRECTION[source.side];
  const endDirection = (SIDE_DIRECTION[target.side] + 2) % 4;
  const start = { x: source.x + DX[startDirection] * STUB, y: source.y + DY[startDirection] * STUB };
  const end = { x: target.x - DX[endDirection] * STUB, y: target.y - DY[endDirection] * STUB };
  // An element the stub already ends in cannot be avoided; the route ignores it instead of finding no way at all.
  const kept = obstacles.filter((obstacle) => !isInside(padded(obstacle, CLEARANCE), start.x, start.y) && !isInside(padded(obstacle, CLEARANCE), end.x, end.y));
  const wires = routed.flatMap((connection): Wire[] => {
    const points = connection.points ?? [];
    const isMerged = [connection.source, connection.target].some((end) => isSameHandle(end, source) || isSameHandle(end, target));
    return points.slice(1).map((point, index) => ({ a: points[index], b: point, isMerged }));
  });

  // The grid comes from the elements near the two ends first: a route rarely leaves that area, and the other elements
  // still block it. Only when that grid leaves no way do all elements shape it.
  const area = padded({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }, NEARBY);
  const nearby = kept.filter((obstacle) => overlaps(padded(obstacle, 0), area));
  const nearbyWires = wires.filter((wire) => overlaps(grown(wireBox(wire), WIRE_GAP), area));
  const route =
    searchGrid(start, end, startDirection, endDirection, kept, nearby, nearbyWires) ??
    (nearby.length < kept.length || nearbyWires.length < wires.length ? searchGrid(start, end, startDirection, endDirection, kept, kept, wires) : null);
  return route && withoutStraightPoints([{ x: source.x, y: source.y }, ...route, { x: target.x, y: target.y }]);
}

/** How long the routing runs before it lets the page breathe. */
const SLICE_MS = 16;

/**
 * Routes every connection like `routeAroundObstacles`, the short ones first, each around the elements and clear of
 * the connections routed before it as far as the elements allow, then once more each clear of all the others: a
 * connection routed early only avoided the few before it. Returns the corner points per connection id, null where
 * the obstacles leave no way. Routing a large diagram takes a while, so it yields to the page every `SLICE_MS` and
 * rejects once `signal` aborts.
 */
export async function routeConnections(connections: Connection[], obstacles: Obstacle[], signal?: AbortSignal): Promise<Map<string, XYPosition[] | null>> {
  const span = (connection: Connection) => Math.abs(connection.target.x - connection.source.x) + Math.abs(connection.target.y - connection.source.y);
  const ordered = [...connections].sort((a, b) => span(a) - span(b));
  const routed: RoutedConnection[] = [];
  let sliceStart = performance.now();
  const breathe = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    sliceStart = performance.now();
  };
  for (const connection of ordered) {
    await breathe();
    routed.push({ ...connection, points: routeAroundObstacles(connection.source, connection.target, obstacles, routed) ?? undefined });
  }
  for (const connection of routed) {
    await breathe();
    const others = routed.filter((other) => other !== connection);
    connection.points = routeAroundObstacles(connection.source, connection.target, obstacles, others) ?? undefined;
  }
  return new Map(routed.map((connection) => [connection.id, connection.points ?? null]));
}

/**
 * A* from `start`, entered in `startDirection`, to `end`, left in `endDirection`, on the grid lines of `shaping`
 * and beside `wires`, around all of `obstacles`. Returns the grid points of the cheapest way, or null when there is none.
 */
function searchGrid(start: XYPosition, end: XYPosition, startDirection: number, endDirection: number, obstacles: Obstacle[], shaping: Obstacle[], wires: Wire[]): XYPosition[] | null {
  const verticalWires = wires.filter((wire) => wire.a.x === wire.b.x);
  const horizontalWires = wires.filter((wire) => wire.a.y === wire.b.y);
  const xs = gridLines(
    start.x,
    end.x,
    shaping.map((obstacle) => [obstacle.x, obstacle.x + obstacle.width]),
    verticalWires.map((wire) => wire.a.x),
  );
  const ys = gridLines(
    start.y,
    end.y,
    shaping.map((obstacle) => [obstacle.y, obstacle.y + obstacle.height]),
    horizontalWires.map((wire) => wire.a.y),
  );
  const columns = xs.length;
  const cellCount = columns * ys.length;
  const startCell = ys.indexOf(start.y) * columns + xs.indexOf(start.x);
  const endCell = ys.indexOf(end.y) * columns + xs.indexOf(end.x);
  // A step along a row or a column only comes closer than `COMFORT` to the elements whose padded box that line
  // crosses, and only those can block it, so each step looks at a handful of elements instead of all of them.
  const near = obstacles.map((obstacle) => ({ element: padded(obstacle, 0), box: padded(obstacle, CLEARANCE), reach: padded(obstacle, COMFORT) }));
  const rowNear = ys.map((y) => near.filter(({ reach }) => y > reach.top && y < reach.bottom));
  const columnNear = xs.map((x) => near.filter(({ reach }) => x > reach.left && x < reach.right));
  // Likewise the wires a step along a row or a column can cross (the ones across it that span the line, their ends
  // included, so a run through the corner of a wire counts as crossing it) or run on (the ones along it on the same
  // line); a merged wire may be run on for free and joined at its corner, so it is left out of `along` and spans
  // without its ends.
  const spans = (wire: Wire, axis: "x" | "y", at: number) => {
    const [low, high] = [Math.min(wire.a[axis], wire.b[axis]), Math.max(wire.a[axis], wire.b[axis])];
    return wire.isMerged ? at > low && at < high : at >= low && at <= high;
  };
  const rowWires = ys.map((y) => ({ across: verticalWires.filter((wire) => spans(wire, "y", y)), along: horizontalWires.filter((wire) => !wire.isMerged && wire.a.y === y) }));
  const columnWires = xs.map((x) => ({ across: horizontalWires.filter((wire) => spans(wire, "x", x)), along: verticalWires.filter((wire) => !wire.isMerged && wire.a.x === x) }));
  /**
   * What the step from `from` to `to` along one line pays for the wires there: a crossing for each wire across it
   * that it starts on or passes (the step that reaches a wire pays nothing, so a run that turns onto it is not
   * charged for crossing it), and the overlap with each wire along it.
   */
  const wireCost = (from: number, to: number, { across, along }: { across: Wire[]; along: Wire[] }, axis: "x" | "y") => {
    let cost = 0;
    for (const wire of across) {
      if (wire.a[axis] >= from && wire.a[axis] < to) cost += CROSSING_COST;
    }
    for (const wire of along) {
      cost += OVERLAP_COST * Math.max(0, Math.min(to, Math.max(wire.a[axis], wire.b[axis])) - Math.max(from, Math.min(wire.a[axis], wire.b[axis])));
    }
    return cost;
  };
  // Whether a cell lies outside every element (0 not yet known), and the cost of the step to the cell on the right
  // (`2 * cell`) and below (`2 * cell + 1`): NaN not yet known, Infinity when it crosses an element. The search asks for
  // the same cells and steps many times, so each is worked out once.
  const freeCells = new Int8Array(cellCount);
  const stepCosts = new Float64Array(cellCount * 2).fill(NaN);
  const isFreeCell = (cell: number) => {
    if (!freeCells[cell]) {
      const [x, y] = [xs[cell % columns], ys[Math.floor(cell / columns)]];
      freeCells[cell] = rowNear[Math.floor(cell / columns)].some(({ box }) => isInside(box, x, y)) ? -1 : 1;
    }
    return freeCells[cell] > 0;
  };
  /**
   * Cost of the step between `cell` and its neighbour to the right or below: its length plus the extra for running
   * closer than `COMFORT` to an element and for the wires it crosses or runs on. No padded border lies strictly
   * between two neighbouring grid lines, so the step crosses an element exactly when its middle does.
   */
  const stepCost = (cell: number, isDown: boolean) => {
    const key = cell * 2 + (isDown ? 1 : 0);
    if (Number.isNaN(stepCosts[key])) {
      const neighbour = isDown ? cell + columns : cell + 1;
      const [x1, y1, x2, y2] = [xs[cell % columns], ys[Math.floor(cell / columns)], xs[neighbour % columns], ys[Math.floor(neighbour / columns)]];
      const candidates = isDown ? columnNear[cell % columns] : rowNear[Math.floor(cell / columns)];
      if (!isFreeCell(cell) || !isFreeCell(neighbour) || candidates.some(({ box }) => isInside(box, (x1 + x2) / 2, (y1 + y2) / 2))) {
        stepCosts[key] = Infinity;
      } else {
        let distance = COMFORT;
        for (const { element } of candidates) distance = Math.min(distance, distanceToSegment(element, x1, y1, x2, y2));
        const wiring = isDown ? wireCost(y1, y2, columnWires[cell % columns], "y") : wireCost(x1, x2, rowWires[Math.floor(cell / columns)], "x");
        stepCosts[key] = (x2 - x1 + y2 - y1) * (1 + (CLOSENESS_COST * (COMFORT - distance)) / (COMFORT - CLEARANCE)) + wiring;
      }
    }
    return stepCosts[key];
  };
  /**
   * Lower bound of what is left from `cell`, entered in `direction`: the distance to the end and the bends it takes
   * at least to enter the end in `endDirection` (none straight ahead, one from the side, two otherwise). Among states
   * of the same bound the one further along goes first, so the search does not widen over a row of equal ways.
   */
  const remaining = (cell: number, direction: number, spent: number) => {
    const dx = end.x - xs[cell % columns];
    const dy = end.y - ys[Math.floor(cell / columns)];
    const isAhead = cell === endCell || (dx * DY[endDirection] === dy * DX[endDirection] && dx * DX[endDirection] + dy * DY[endDirection] > 0);
    const bends = direction === endDirection ? (isAhead ? 0 : 2) : direction === (endDirection + 2) % 4 ? 2 : 1;
    return Math.abs(dx) + Math.abs(dy) + (cell === endCell ? 0 : bends * BEND_COST) - spent * 1e-6;
  };

  // A state is a cell entered in one of the four directions, so a bend can cost more than its length.
  const cost = new Float64Array(cellCount * 4).fill(Infinity);
  const previous = new Int32Array(cellCount * 4).fill(-1);
  const open = new MinHeap();
  const startState = startCell * 4 + startDirection;
  cost[startState] = 0;
  open.push(startState, remaining(startCell, startDirection, 0));
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
      open.push(nextState, nextCost + remaining(nextCell, next, nextCost));
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

/**
 * How often the routes cross each other: a horizontal run of one and a vertical run of another that meet away from
 * both runs' ends. Runs that merge into one handle touch but do not cross.
 */
export function countCrossings(routes: XYPosition[][]): number {
  const runs = routes.flatMap((points, route) => points.slice(1).map((point, index) => ({ a: points[index], b: point, route })));
  const horizontal = runs.filter((run) => run.a.y === run.b.y);
  const vertical = runs.filter((run) => run.a.x === run.b.x);
  let crossings = 0;
  for (const across of horizontal) {
    const [left, right] = [Math.min(across.a.x, across.b.x), Math.max(across.a.x, across.b.x)];
    for (const down of vertical) {
      if (down.route === across.route) continue;
      const [top, bottom] = [Math.min(down.a.y, down.b.y), Math.max(down.a.y, down.b.y)];
      if (down.a.x > left && down.a.x < right && across.a.y > top && across.a.y < bottom) crossings++;
    }
  }
  return crossings;
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

function grown(box: Box, room: number): Box {
  return { left: box.left - room, top: box.top - room, right: box.right + room, bottom: box.bottom + room };
}

function padded(obstacle: Obstacle, room: number): Box {
  return { left: obstacle.x - room, top: obstacle.y - room, right: obstacle.x + obstacle.width + room, bottom: obstacle.y + obstacle.height + room };
}

/**
 * The grid lines on one axis: the route's ends, each element's sides at `CLEARANCE` and at `COMFORT`, the middle
 * between every two neighbouring sides at `CLEARANCE`, so a route can take the middle of a gap too narrow for
 * `COMFORT`, and each wire along the axis with a line at `WIRE_GAP` on either side, so a route can run beside it or
 * join it.
 */
function gridLines(start: number, end: number, spans: [number, number][], wires: number[]): number[] {
  const borders = uniqueSorted(spans.flatMap(([low, high]) => [low - CLEARANCE, high + CLEARANCE]));
  const middles = borders.slice(1).map((border, index) => (border + borders[index]) / 2);
  const comfortable = spans.flatMap(([low, high]) => [low - COMFORT, high + COMFORT]);
  const beside = wires.flatMap((wire) => [wire - WIRE_GAP, wire, wire + WIRE_GAP]);
  return uniqueSorted([start, end, ...borders, ...middles, ...comfortable, ...beside]);
}

/** The box a wire spans; flat along its axis. */
function wireBox(wire: Wire): Box {
  return { left: Math.min(wire.a.x, wire.b.x), top: Math.min(wire.a.y, wire.b.y), right: Math.max(wire.a.x, wire.b.x), bottom: Math.max(wire.a.y, wire.b.y) };
}

/** True when both ends sit on the same handle. */
function isSameHandle(a: RouteEnd, b: RouteEnd): boolean {
  return a.x === b.x && a.y === b.y && a.side === b.side;
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
