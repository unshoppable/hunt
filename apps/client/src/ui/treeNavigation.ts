/** One visible row of a tree, in display order; a row's children follow it with a `depth` one greater. */
export type TreeNavRow = {
  key: string;
  depth: number;
  /** Whether the row's children show; absent on a row that has none (a file, a branch). */
  isExpanded?: boolean;
};

export type TreeNavAction = { type: "move" | "toggle" | "activate" | "check"; key: string };

/**
 * What a key does in a tree, as in WebStorm: ↑/↓ step through the visible rows, Home/End jump to the first and the last,
 * → expands a collapsed row and steps into an expanded one, ← collapses an expanded row and otherwise goes to the
 * parent, Enter toggles a row with children and activates any other, Space checks the row. Without a cursor on a
 * visible row every movement starts at the first row. `null` for a key the tree leaves alone.
 */
export function treeKeyAction(rows: readonly TreeNavRow[], cursor: string | null, key: string): TreeNavAction | null {
  const moveTo = (index: number): TreeNavAction | null => {
    const row = rows[index];
    return row ? { type: "move", key: row.key } : null;
  };
  if (key === "Home") return moveTo(0);
  if (key === "End") return moveTo(rows.length - 1);
  const index = cursor === null ? -1 : rows.findIndex((row) => row.key === cursor);
  const row = rows[index];
  if (!row) return key.startsWith("Arrow") ? moveTo(0) : null;
  switch (key) {
    case "ArrowDown":
      return moveTo(Math.min(index + 1, rows.length - 1));
    case "ArrowUp":
      return moveTo(Math.max(index - 1, 0));
    case "ArrowRight":
      if (row.isExpanded === false) return { type: "toggle", key: row.key };
      return row.isExpanded && (rows[index + 1]?.depth ?? 0) > row.depth ? moveTo(index + 1) : null;
    case "ArrowLeft":
      if (row.isExpanded) return { type: "toggle", key: row.key };
      return moveTo(parentIndex(rows, index));
    case "Enter":
      return { type: row.isExpanded === undefined ? "activate" : "toggle", key: row.key };
    case " ":
      return { type: "check", key: row.key };
    default:
      return null;
  }
}

/** Index of the nearest row above `index` that is less deep, i.e. its parent; -1 for a top-level row. */
function parentIndex(rows: readonly TreeNavRow[], index: number): number {
  for (let candidate = index - 1; candidate >= 0; candidate--) {
    if (rows[candidate].depth < rows[index].depth) return candidate;
  }
  return -1;
}
