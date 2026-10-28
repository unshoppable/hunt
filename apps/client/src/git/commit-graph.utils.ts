import type { Commit } from "./git.types";

/** One line of a log row's graph cell: its lane at the top edge (`from`) and at the bottom edge (`to`) of the row. */
export type GraphSegment =
  /** A lane passing the row: a straight line from top to bottom. */
  | { kind: "through"; lane: number; color: number }
  /** A line from the top edge in lane `from` into the row's node. */
  | { kind: "in"; from: number; color: number }
  /** A line from the row's node to the bottom edge in lane `to`. */
  | { kind: "out"; to: number; color: number };

/** How one row of the log draws its part of the commit graph; `laneCount` is how many lanes the row spans. */
export type GraphRow = { lane: number; color: number; segments: GraphSegment[]; laneCount: number };

/**
 * Lays the commit graph out lane by lane for commits in date or topological order (every parent after its children).
 * A lane waits for one commit: the first parent of a commit keeps its lane, every other parent gets the first free
 * lane unless one already waits for it, and lanes waiting for the same commit join at its node. Each lane keeps its
 * color from the commit that opened it until it closes, so a branch reads as one colored line.
 */
export function layoutGraph(commits: readonly Pick<Commit, "id" | "parents">[]): GraphRow[] {
  /** The commit each lane waits for; `null` is a free lane. */
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const allocate = (id: string): number => {
    let lane = lanes.indexOf(null);
    if (lane === -1) {
      lane = lanes.length;
    }
    lanes[lane] = id;
    colors[lane] = nextColor++;
    return lane;
  };

  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const segments: GraphSegment[] = [];
    let lane = lanes.indexOf(commit.id);
    const isNew = lane === -1;
    if (isNew) {
      lane = allocate(commit.id);
    }
    const color = colors[lane];
    if (!isNew) {
      segments.push({ kind: "in", from: lane, color });
    }
    for (let other = 0; other < lanes.length; other++) {
      if (other === lane) continue;
      if (lanes[other] === commit.id) {
        segments.push({ kind: "in", from: other, color: colors[other] });
        lanes[other] = null;
      } else if (lanes[other] !== null) {
        segments.push({ kind: "through", lane: other, color: colors[other] });
      }
    }

    const [firstParent, ...otherParents] = commit.parents;
    lanes[lane] = firstParent ?? null;
    if (firstParent) {
      segments.push({ kind: "out", to: lane, color });
    }
    for (const parent of otherParents) {
      if (parent === firstParent) continue;
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = allocate(parent);
      }
      segments.push({ kind: "out", to: target, color: colors[target] });
    }

    const laneCount = Math.max(lane + 1, ...segments.map((segment) => (segment.kind === "through" ? segment.lane : segment.kind === "in" ? segment.from : segment.to) + 1));
    rows.push({ lane, color, segments, laneCount });

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }
  }
  return rows;
}
