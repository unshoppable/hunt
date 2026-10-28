import { describe, expect, it } from "vitest";
import { PaneLayout } from "./pane-layout.value-object";

function shape(layout: PaneLayout): string[][][] {
  return layout.rows.map((row) => row.panes.map((pane) => pane.tabs));
}

function twoTabs(): { layout: PaneLayout; paneId: string } {
  const first = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
  return first.layout.withFileOpened(first.paneId, "b.ts");
}

describe("PaneLayout", () => {
  it("rejects a pane without tabs", () => {
    expect(() => new PaneLayout({ rows: [{ id: "row", panes: [{ id: "pane", tabs: [], activePath: "a.ts" }] }] })).toThrow(/at least one tab/);
  });

  it("rejects a pane that shows a file twice", () => {
    expect(() => new PaneLayout({ rows: [{ id: "row", panes: [{ id: "pane", tabs: ["a.ts", "a.ts"], activePath: "a.ts" }] }] })).toThrow(/each file once/);
  });

  it("rejects an active tab the pane does not show", () => {
    expect(() => new PaneLayout({ rows: [{ id: "row", panes: [{ id: "pane", tabs: ["a.ts"], activePath: "b.ts" }] }] })).toThrow(/one of its tabs/);
  });

  it("rejects a row without panes", () => {
    expect(() => new PaneLayout({ rows: [{ id: "row", panes: [] }] })).toThrow(/at least one pane/);
  });

  it("rejects two rows or panes with the same id", () => {
    const pane = { id: "pane", tabs: ["a.ts"], activePath: "a.ts" };
    expect(() => new PaneLayout({ rows: [{ id: "row", panes: [pane, { ...pane, tabs: ["b.ts"], activePath: "b.ts" }] }] })).toThrow(/id of its own/);
    expect(() => new PaneLayout({ rows: [{ id: "same", panes: [pane] }, { id: "same", panes: [{ ...pane, id: "other" }] }] })).toThrow(/id of its own/);
  });

  it("opens the first pane when the layout is empty", () => {
    const { layout, paneId } = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    expect(shape(layout)).toEqual([[["a.ts"]]]);
    expect(layout.findPane(paneId)?.activePath).toBe("a.ts");
    expect(layout.firstPane?.id).toBe(paneId);
  });

  it("adds a tab once and activates it", () => {
    const first = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    const second = first.layout.withFileOpened(first.paneId, "b.ts");
    const third = second.layout.withFileOpened(second.paneId, "a.ts");
    expect(shape(third.layout)).toEqual([[["a.ts", "b.ts"]]]);
    expect(third.layout.findPane(third.paneId)?.activePath).toBe("a.ts");
  });

  it("opens a right split as the first pane when the layout is empty", () => {
    const { layout, paneId } = PaneLayout.EMPTY.withFileInRightSplit(null, "a.ts");
    expect(shape(layout)).toEqual([[["a.ts"]]]);
    expect(layout.findPane(paneId)?.activePath).toBe("a.ts");
  });

  it("splits right of the source and keeps the source's tabs", () => {
    const first = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    const split = first.layout.withFileInRightSplit(first.paneId, "b.ts");
    expect(shape(split.layout)).toEqual([[["a.ts"], ["b.ts"]]]);
    expect(split.paneId).not.toBe(first.paneId);
    expect(split.layout.findPane(split.paneId)?.activePath).toBe("b.ts");
  });

  it("splits into an existing right neighbour and activates the file there", () => {
    const first = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    const split = first.layout.withFileInRightSplit(first.paneId, "b.ts");
    const again = split.layout.withFileInRightSplit(first.paneId, "c.ts");
    expect(shape(again.layout)).toEqual([[["a.ts"], ["b.ts", "c.ts"]]]);
    expect(again.paneId).toBe(split.paneId);
    expect(again.layout.findPane(again.paneId)?.activePath).toBe("c.ts");
  });

  it("splits from the first pane when the source pane is gone", () => {
    const first = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    expect(shape(first.layout.withFileInRightSplit("pane-missing", "b.ts").layout)).toEqual([[["a.ts"], ["b.ts"]]]);
  });

  it("activates a tab the pane shows and stays unchanged for any other", () => {
    const { layout, paneId } = twoTabs();
    expect(layout.withActiveTab(paneId, "a.ts").findPane(paneId)?.activePath).toBe("a.ts");
    expect(layout.withActiveTab(paneId, "c.ts")).toBe(layout);
    expect(layout.withActiveTab("pane-missing", "a.ts")).toBe(layout);
  });

  it("closes a tab, activating its right neighbour, then its left one, and removes the emptied pane", () => {
    let { layout, paneId } = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    ({ layout } = layout.withFileOpened(paneId, "b.ts"));
    ({ layout } = layout.withFileOpened(paneId, "c.ts"));
    ({ layout } = layout.withFileOpened(paneId, "b.ts"));
    layout = layout.withoutTab(paneId, "b.ts");
    expect(layout.findPane(paneId)?.activePath).toBe("c.ts");
    layout = layout.withoutTab(paneId, "c.ts");
    expect(layout.findPane(paneId)?.activePath).toBe("a.ts");
    layout = layout.withoutTab(paneId, "a.ts");
    expect(layout.rows).toEqual([]);
    expect(layout.withoutTab("pane-missing", "a.ts")).toBe(layout);
  });

  it("closes the matching tabs of every pane and removes the panes it empties", () => {
    let { layout, paneId } = PaneLayout.EMPTY.withFileOpened(null, "src/a.ts");
    ({ layout } = layout.withFileOpened(paneId, "b.ts"));
    const right = layout.withFileInRightSplit(paneId, "src/c.ts");
    layout = right.layout.withoutTabsWhere((path) => path.startsWith("src/"));
    expect(shape(layout)).toEqual([[["b.ts"]]]);
    expect(layout.findPane(paneId)?.activePath).toBe("b.ts");
    expect(layout.withoutTabsWhere((path) => path.startsWith("src/"))).toBe(layout);
  });

  it("lists the panes row by row and those that show a file", () => {
    const first = twoTabs();
    const split = first.layout.withFileInRightSplit(first.paneId, "b.ts");
    expect(split.layout.panes.map((pane) => pane.id)).toEqual([first.paneId, split.paneId]);
    expect(split.layout.panesShowing("b.ts").map((pane) => pane.id)).toEqual([first.paneId, split.paneId]);
    expect(split.layout.panesShowing("a.ts").map((pane) => pane.id)).toEqual([first.paneId]);
  });

  it("does not move a lone tab without a neighbour", () => {
    const { layout, paneId } = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    expect(layout.withActiveTabMoved(paneId, "right")).toBeNull();
    expect(layout.withActiveTabMoved(paneId, "down")).toBeNull();
    expect(layout.withActiveTabMoved("pane-missing", "down")).toBeNull();
  });

  it("moves the active tab into a new pane to the right and to the left", () => {
    const { layout, paneId } = twoTabs();
    const right = layout.withActiveTabMoved(paneId, "right");
    expect(right && shape(right.layout)).toEqual([[["a.ts"], ["b.ts"]]]);
    const left = layout.withActiveTabMoved(paneId, "left");
    expect(left && shape(left.layout)).toEqual([[["b.ts"], ["a.ts"]]]);
  });

  it("moves the active tab into a new row below and above", () => {
    const { layout, paneId } = twoTabs();
    const down = layout.withActiveTabMoved(paneId, "down");
    expect(down && shape(down.layout)).toEqual([[["a.ts"]], [["b.ts"]]]);
    const up = layout.withActiveTabMoved(paneId, "up");
    expect(up && shape(up.layout)).toEqual([[["b.ts"]], [["a.ts"]]]);
  });

  it("moves the active tab into an existing neighbour and closes the emptied source", () => {
    const { layout, paneId } = twoTabs();
    const split = layout.withActiveTabMoved(paneId, "right")!;
    const back = split.layout.withActiveTabMoved(split.paneId, "left");
    expect(back && shape(back.layout)).toEqual([[["a.ts", "b.ts"]]]);
    expect(back && back.layout.findPane(back.paneId)?.activePath).toBe("b.ts");
  });

  it("moves into the pane in the same column of the neighbouring row, clamped to the row length", () => {
    let { layout, paneId } = twoTabs();
    ({ layout } = layout.withFileOpened(paneId, "c.ts"));
    const right = layout.withActiveTabMoved(paneId, "right")!;
    const { layout: withD } = right.layout.withFileOpened(right.paneId, "d.ts");
    const down = withD.withActiveTabMoved(right.paneId, "down")!;
    expect(shape(down.layout)).toEqual([[["a.ts", "b.ts"], ["c.ts"]], [["d.ts"]]]);
    const { layout: withE } = down.layout.withFileOpened(down.paneId, "e.ts");
    const up = withE.withActiveTabMoved(down.paneId, "up")!;
    expect(shape(up.layout)).toEqual([[["a.ts", "b.ts", "e.ts"], ["c.ts"]], [["d.ts"]]]);
  });

  it("renames rows and panes under fresh ids and maps the old pane ids to the new ones", () => {
    const layout = new PaneLayout({
      rows: [{ id: "stored-row", panes: [{ id: "stored-a", tabs: ["a.ts", "b.ts"], activePath: "b.ts" }, { id: "stored-b", tabs: ["c.ts"], activePath: "c.ts" }] }],
    });
    const { layout: fresh, paneIds } = layout.withFreshIds();
    expect(fresh.rows[0]?.id).not.toBe("stored-row");
    expect(fresh.panes.map((pane) => pane.id)).toEqual([paneIds.get("stored-a"), paneIds.get("stored-b")]);
    expect(fresh.panes.map((pane) => pane.id)).not.toContain("stored-a");
    expect(fresh.panes.map(({ tabs, activePath }) => ({ tabs, activePath }))).toEqual([
      { tabs: ["a.ts", "b.ts"], activePath: "b.ts" },
      { tabs: ["c.ts"], activePath: "c.ts" },
    ]);
  });

  it("is stored as its rows and read back as an equal layout", () => {
    const { layout: oneRow, paneId } = twoTabs();
    const { layout } = oneRow.withActiveTabMoved(paneId, "down")!;
    const stored: unknown = JSON.parse(JSON.stringify(layout));
    expect(stored).toEqual({ rows: layout.rows });
    expect(PaneLayout.fromStored(stored).isEqualTo(layout)).toBe(true);
  });

  it("reads anything that is no valid layout as the empty layout", () => {
    expect(PaneLayout.fromStored(undefined)).toBe(PaneLayout.EMPTY);
    expect(PaneLayout.fromStored({ rows: [{ id: "row", panes: [] }] })).toBe(PaneLayout.EMPTY);
    expect(PaneLayout.fromStored({ rows: "none" })).toBe(PaneLayout.EMPTY);
  });
});
