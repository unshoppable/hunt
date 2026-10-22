/**
 * Layout of the editor area: rows stacked top to bottom, each a row of panes left to right. A pane holds
 * tabs (worktree-relative file paths) and one active tab. All functions return a new layout.
 */

export type Pane = { id: string; tabs: string[]; activePath: string | null };

export type PaneRow = { id: string; panes: Pane[] };

export type PaneLayout = { rows: PaneRow[] };

export type Direction = "left" | "right" | "up" | "down";

export const EMPTY_LAYOUT: PaneLayout = { rows: [] };

let idCounter = 0;

/** Unique ids for panes and rows; `prefix` keeps React keys of rows and panes apart. */
export function nextId(prefix: "pane" | "row"): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function createPane(tabs: string[] = []): Pane {
  return { id: nextId("pane"), tabs, activePath: tabs[tabs.length - 1] ?? null };
}

/** `layout` with fresh row and pane ids, as a layout restored after a restart needs; `paneIds` maps each old pane id to its new one. */
export function withFreshIds(layout: PaneLayout): { layout: PaneLayout; paneIds: Map<string, string> } {
  const paneIds = new Map<string, string>();
  const rows = layout.rows.map((row) => ({
    id: nextId("row"),
    panes: row.panes.map((pane) => {
      const id = nextId("pane");
      paneIds.set(pane.id, id);
      return { ...pane, id };
    }),
  }));
  return { layout: { rows }, paneIds };
}

export function findPane(layout: PaneLayout, paneId: string): Pane | null {
  for (const row of layout.rows) {
    const pane = row.panes.find((candidate) => candidate.id === paneId);
    if (pane) return pane;
  }
  return null;
}

/** Row and column index of a pane; `null` when the layout has no such pane. */
export function locatePane(layout: PaneLayout, paneId: string): { rowIndex: number; paneIndex: number } | null {
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex++) {
    const paneIndex = layout.rows[rowIndex].panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) return { rowIndex, paneIndex };
  }
  return null;
}

export function firstPane(layout: PaneLayout): Pane | null {
  return layout.rows[0]?.panes[0] ?? null;
}

export function allPanes(layout: PaneLayout): Pane[] {
  return layout.rows.flatMap((row) => row.panes);
}

function replacePane(layout: PaneLayout, pane: Pane): PaneLayout {
  return { rows: layout.rows.map((row) => ({ ...row, panes: row.panes.map((candidate) => (candidate.id === pane.id ? pane : candidate)) })) };
}

/** Drops empty panes and the rows that end up without panes. */
function prune(layout: PaneLayout): PaneLayout {
  const rows = layout.rows.map((row) => ({ ...row, panes: row.panes.filter((pane) => pane.tabs.length > 0) })).filter((row) => row.panes.length > 0);
  return { rows };
}

/** Shows `path` in `paneId` (adding a tab when needed); without a pane, or when it is gone, a first pane is created. */
export function openInPane(layout: PaneLayout, paneId: string | null, path: string): { layout: PaneLayout; paneId: string } {
  const pane = (paneId && findPane(layout, paneId)) || firstPane(layout);
  if (!pane) {
    const created = createPane([path]);
    return { layout: { rows: [{ id: nextId("row"), panes: [created] }] }, paneId: created.id };
  }
  const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
  return { layout: replacePane(layout, { ...pane, tabs, activePath: path }), paneId: pane.id };
}

/**
 * Shows `path` right of `paneId`, like WebStorm's "Open in Right Split": an existing right neighbour gets the file
 * as a tab, otherwise a new pane is created there. Without a pane to split from, the file opens in a first pane.
 */
export function openInRightSplit(layout: PaneLayout, paneId: string | null, path: string): { layout: PaneLayout; paneId: string } {
  const source = (paneId && findPane(layout, paneId)) || firstPane(layout);
  const location = source ? locatePane(layout, source.id) : null;
  if (!location) return openInPane(layout, null, path);
  const { rowIndex, paneIndex } = location;
  const neighbour = layout.rows[rowIndex].panes[paneIndex + 1];
  if (neighbour) return openInPane(layout, neighbour.id, path);
  const created = createPane([path]);
  const rows = layout.rows.map((row, index) => (index === rowIndex ? { ...row, panes: [...row.panes, created] } : row));
  return { layout: { rows }, paneId: created.id };
}

export function activateTab(layout: PaneLayout, paneId: string, path: string): PaneLayout {
  const pane = findPane(layout, paneId);
  if (!pane || !pane.tabs.includes(path)) return layout;
  return replacePane(layout, { ...pane, activePath: path });
}

/** The tab that becomes active when `path` leaves `pane`: its right neighbour, else its left one. */
function nextActive(pane: Pane, path: string): string | null {
  if (pane.activePath !== path) return pane.activePath;
  const index = pane.tabs.indexOf(path);
  return pane.tabs[index + 1] ?? pane.tabs[index - 1] ?? null;
}

function withoutTab(pane: Pane, path: string): Pane {
  return { ...pane, tabs: pane.tabs.filter((tab) => tab !== path), activePath: nextActive(pane, path) };
}

/** Closes a tab; a pane without tabs disappears, and so does a row without panes. */
export function closeTab(layout: PaneLayout, paneId: string, path: string): PaneLayout {
  const pane = findPane(layout, paneId);
  if (!pane) return layout;
  return prune(replacePane(layout, withoutTab(pane, path)));
}

/** Every pane whose tabs include `path`. */
export function panesShowing(layout: PaneLayout, path: string): Pane[] {
  return allPanes(layout).filter((pane) => pane.tabs.includes(path));
}

/**
 * Moves the active tab of `paneId` to the neighbouring pane in `direction`, like WebStorm's "Move Right/Left/Up/Down".
 * Without a neighbour a new pane is created there (a new column of the row for left/right, a new row for up/down);
 * an existing neighbour gets the file as an additional tab. The source pane closes when it has no tabs left.
 * Returns the id of the pane the tab now lives in, or `null` when nothing moved.
 */
export function moveActiveTab(layout: PaneLayout, paneId: string, direction: Direction): { layout: PaneLayout; paneId: string } | null {
  const location = locatePane(layout, paneId);
  const source = findPane(layout, paneId);
  if (!location || !source?.activePath) return null;
  const path = source.activePath;
  const { rowIndex, paneIndex } = location;
  const row = layout.rows[rowIndex];

  const isHorizontal = direction === "left" || direction === "right";
  const step = direction === "left" || direction === "up" ? -1 : 1;
  const neighbour = isHorizontal ? (row.panes[paneIndex + step] ?? null) : neighbourInRow(layout.rows[rowIndex + step], paneIndex);

  // A lone tab moved into empty space would only recreate the same pane there.
  if (!neighbour && source.tabs.length === 1) return null;

  const shrunkSource = withoutTab(source, path);
  if (neighbour) {
    const tabs = neighbour.tabs.includes(path) ? neighbour.tabs : [...neighbour.tabs, path];
    const moved = replacePane(replacePane(layout, shrunkSource), { ...neighbour, tabs, activePath: path });
    return { layout: prune(moved), paneId: neighbour.id };
  }

  const created = createPane([path]);
  let rows: PaneRow[];
  if (isHorizontal) {
    const panes = [...row.panes];
    panes.splice(paneIndex + (step === 1 ? 1 : 0), 0, created);
    rows = layout.rows.map((candidate, index) => (index === rowIndex ? { ...candidate, panes } : candidate));
  } else {
    rows = [...layout.rows];
    rows.splice(rowIndex + (step === 1 ? 1 : 0), 0, { id: nextId("row"), panes: [created] });
  }
  return { layout: prune(replacePane({ rows }, shrunkSource)), paneId: created.id };
}

/** The pane of `row` in the same column as `paneIndex`, or its last pane when the row is shorter. */
function neighbourInRow(row: PaneRow | undefined, paneIndex: number): Pane | null {
  if (!row) return null;
  return row.panes[Math.min(paneIndex, row.panes.length - 1)] ?? null;
}
