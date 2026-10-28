import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";

export type Direction = "left" | "right" | "up" | "down";

const PANE_RULE = "a pane shows at least one tab";
const TABS_RULE = "a pane shows each file once";
const ACTIVE_TAB_RULE = "the active tab of a pane is one of its tabs";
const ROW_RULE = "a row holds at least one pane";
const IDS_RULE = "every row and pane has an id of its own";

const ZodPaneState = z
  .object({
    id: z.string(),
    /** Worktree-relative paths of the files the pane shows, left to right. */
    tabs: z.array(z.string()).check(z.minLength(1, PANE_RULE), z.refine((tabs) => new Set(tabs).size === tabs.length, TABS_RULE)),
    activePath: z.string(),
  })
  .check(z.refine((pane) => pane.tabs.includes(pane.activePath), ACTIVE_TAB_RULE));

const ZodPaneRowState = z.object({
  id: z.string(),
  /** Left to right. */
  panes: z.array(ZodPaneState).check(z.minLength(1, ROW_RULE)),
});

const ZodPaneLayoutState = z
  .object({
    /** Top to bottom. */
    rows: z.array(ZodPaneRowState),
  })
  .check(z.refine((layout) => hasUniqueIds(layout.rows), IDS_RULE));

export type Pane = z.infer<typeof ZodPaneState>;
export type PaneRow = z.infer<typeof ZodPaneRowState>;

/** The pane the tab of an operation now lives in, with the layout after it. */
export type PaneLayoutChange = { layout: PaneLayout; paneId: string };

export interface PaneLayout extends z.infer<typeof ZodPaneLayoutState> {}

/**
 * The layout of the editor area: rows stacked top to bottom, each a row of panes left to right. A pane shows tabs
 * (worktree-relative file paths), one of them active; a pane whose last tab closes disappears, and so does a row
 * without panes. Every `with…` returns a new layout, or this one when nothing changes.
 */
export class PaneLayout extends ValueObject<typeof ZodPaneLayoutState> {
  static readonly schema = ZodPaneLayoutState;
  static readonly EMPTY = new PaneLayout({ rows: [] });

  constructor(value: z.input<typeof ZodPaneLayoutState>) {
    super(value);
  }

  /** The layout `toJSON` stored; the empty layout for anything that is no valid layout. */
  static fromStored(stored: unknown): PaneLayout {
    const parsed = ZodPaneLayoutState.safeParse(stored);
    return parsed.success ? new PaneLayout(parsed.data) : PaneLayout.EMPTY;
  }

  /** Every pane, row by row. */
  get panes(): Pane[] {
    return this.rows.flatMap((row) => row.panes);
  }

  get firstPane(): Pane | null {
    return this.rows[0]?.panes[0] ?? null;
  }

  findPane(paneId: string): Pane | null {
    return paneIn(this.rows, paneId);
  }

  /** Every pane whose tabs include `path`. */
  panesShowing(path: string): Pane[] {
    return this.panes.filter((pane) => pane.tabs.includes(path));
  }

  /** The layout under fresh row and pane ids, as a layout restored after a restart needs; `paneIds` maps each old pane id to its new one. */
  withFreshIds(): { layout: PaneLayout; paneIds: Map<string, string> } {
    const paneIds = new Map<string, string>();
    const rows = this.rows.map((row) => ({
      id: nextId("row"),
      panes: row.panes.map((pane) => {
        const id = nextId("pane");
        paneIds.set(pane.id, id);
        return { ...pane, id };
      }),
    }));
    return { layout: new PaneLayout({ rows }), paneIds };
  }

  /** Shows `path` in `paneId` (adding a tab when needed); without a pane, or when it is gone, in the first pane, which is created when there is none. */
  withFileOpened(paneId: string | null, path: string): PaneLayoutChange {
    const pane = (paneId && this.findPane(paneId)) || this.firstPane;
    if (!pane) {
      const created = createPane(path);
      return { layout: new PaneLayout({ rows: [{ id: nextId("row"), panes: [created] }] }), paneId: created.id };
    }
    const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
    return { layout: new PaneLayout({ rows: replacePane(this.rows, pane.id, { ...pane, tabs, activePath: path }) }), paneId: pane.id };
  }

  /**
   * Shows `path` right of `paneId`, like WebStorm's "Open in Right Split": an existing right neighbour gets the file
   * as a tab, otherwise a new pane is created there. Without a pane to split from, the file opens in a first pane.
   */
  withFileInRightSplit(paneId: string | null, path: string): PaneLayoutChange {
    const source = (paneId && this.findPane(paneId)) || this.firstPane;
    const location = source ? locatePane(this.rows, source.id) : null;
    if (!location) return this.withFileOpened(null, path);
    const { rowIndex, paneIndex } = location;
    const neighbour = this.rows[rowIndex].panes[paneIndex + 1];
    if (neighbour) return this.withFileOpened(neighbour.id, path);
    const created = createPane(path);
    const rows = this.rows.map((row, index) => (index === rowIndex ? { ...row, panes: [...row.panes, created] } : row));
    return { layout: new PaneLayout({ rows }), paneId: created.id };
  }

  /** Makes `path` the active tab of `paneId`; this layout when the pane does not show it. */
  withActiveTab(paneId: string, path: string): PaneLayout {
    const pane = this.findPane(paneId);
    if (!pane || !pane.tabs.includes(path)) return this;
    return new PaneLayout({ rows: replacePane(this.rows, paneId, { ...pane, activePath: path }) });
  }

  /** Closes the tab `path` of `paneId`; this layout when there is no such pane. */
  withoutTab(paneId: string, path: string): PaneLayout {
    const pane = this.findPane(paneId);
    if (!pane) return this;
    return new PaneLayout({ rows: replacePane(this.rows, paneId, paneWithoutTab(pane, path)) });
  }

  /** Closes every tab whose path `isClosed` accepts, in every pane, as `withoutTab` closes one. */
  withoutTabsWhere(isClosed: (path: string) => boolean): PaneLayout {
    let rows = this.rows;
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (!isClosed(tab)) continue;
        const current = paneIn(rows, pane.id);
        if (!current) continue;
        rows = replacePane(rows, pane.id, paneWithoutTab(current, tab));
      }
    }
    return rows === this.rows ? this : new PaneLayout({ rows });
  }

  /**
   * Moves the active tab of `paneId` to the neighbouring pane in `direction`, like WebStorm's "Move Right/Left/Up/Down".
   * Without a neighbour a new pane is created there (a new column of the row for left/right, a new row for up/down);
   * an existing neighbour gets the file as an additional tab. The source pane closes when it has no tabs left.
   * Null when nothing moved.
   */
  withActiveTabMoved(paneId: string, direction: Direction): PaneLayoutChange | null {
    const location = locatePane(this.rows, paneId);
    const source = this.findPane(paneId);
    if (!location || !source) return null;
    const path = source.activePath;
    const { rowIndex, paneIndex } = location;
    const row = this.rows[rowIndex];

    const isHorizontal = direction === "left" || direction === "right";
    const step = direction === "left" || direction === "up" ? -1 : 1;
    const neighbour = isHorizontal ? (row.panes[paneIndex + step] ?? null) : neighbourInRow(this.rows[rowIndex + step], paneIndex);

    // A lone tab moved into empty space would only recreate the same pane there.
    if (!neighbour && source.tabs.length === 1) return null;

    const shrunkSource = paneWithoutTab(source, path);
    if (neighbour) {
      const tabs = neighbour.tabs.includes(path) ? neighbour.tabs : [...neighbour.tabs, path];
      const rows = replacePane(replacePane(this.rows, source.id, shrunkSource), neighbour.id, { ...neighbour, tabs, activePath: path });
      return { layout: new PaneLayout({ rows }), paneId: neighbour.id };
    }

    const created = createPane(path);
    let rows: PaneRow[];
    if (isHorizontal) {
      const panes = [...row.panes];
      panes.splice(paneIndex + (step === 1 ? 1 : 0), 0, created);
      rows = this.rows.map((candidate, index) => (index === rowIndex ? { ...candidate, panes } : candidate));
    } else {
      rows = [...this.rows];
      rows.splice(rowIndex + (step === 1 ? 1 : 0), 0, { id: nextId("row"), panes: [created] });
    }
    return { layout: new PaneLayout({ rows: replacePane(rows, source.id, shrunkSource) }), paneId: created.id };
  }
}

let idCounter = 0;

/** A fresh id for a pane or a row; `prefix` keeps React keys of rows and panes apart. */
function nextId(prefix: "pane" | "row"): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function createPane(path: string): Pane {
  return { id: nextId("pane"), tabs: [path], activePath: path };
}

function hasUniqueIds(rows: readonly PaneRow[]): boolean {
  const ids = rows.flatMap((row) => [row.id, ...row.panes.map((pane) => pane.id)]);
  return new Set(ids).size === ids.length;
}

function paneIn(rows: readonly PaneRow[], paneId: string): Pane | null {
  for (const row of rows) {
    const pane = row.panes.find((candidate) => candidate.id === paneId);
    if (pane) return pane;
  }
  return null;
}

/** Row and column index of a pane; null when `rows` hold no such pane. */
function locatePane(rows: readonly PaneRow[], paneId: string): { rowIndex: number; paneIndex: number } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const paneIndex = rows[rowIndex].panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) return { rowIndex, paneIndex };
  }
  return null;
}

/** `rows` with the pane `paneId` replaced by `replacement`, or removed for null; a row left without panes is removed too. */
function replacePane(rows: readonly PaneRow[], paneId: string, replacement: Pane | null): PaneRow[] {
  return rows
    .map((row) => ({ ...row, panes: row.panes.flatMap((pane) => (pane.id !== paneId ? [pane] : replacement ? [replacement] : [])) }))
    .filter((row) => row.panes.length > 0);
}

/** `pane` without the tab `path`, whose right neighbour, else its left one, becomes active when it was; null once no tab is left. */
function paneWithoutTab(pane: Pane, path: string): Pane | null {
  const tabs = pane.tabs.filter((tab) => tab !== path);
  if (!tabs.length) return null;
  if (pane.activePath !== path) return { ...pane, tabs };
  const index = pane.tabs.indexOf(path);
  return { ...pane, tabs, activePath: pane.tabs[index + 1] ?? pane.tabs[index - 1] };
}

/** The pane of `row` in the same column as `paneIndex`, or its last pane when the row is shorter. */
function neighbourInRow(row: PaneRow | undefined, paneIndex: number): Pane | null {
  if (!row) return null;
  return row.panes[Math.min(paneIndex, row.panes.length - 1)] ?? null;
}
