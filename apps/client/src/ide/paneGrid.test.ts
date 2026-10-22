import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT, allPanes, closeTab, closeTabsWhere, findPane, moveActiveTab, openInPane, openInRightSplit, withFreshIds, type PaneLayout } from "./paneGrid";

function shape(layout: PaneLayout): string[][][] {
  return layout.rows.map((row) => row.panes.map((pane) => pane.tabs));
}

describe("openInPane", () => {
  it("creates the first pane when the layout is empty", () => {
    const { layout, paneId } = openInPane(EMPTY_LAYOUT, null, "a.ts");
    expect(shape(layout)).toEqual([[["a.ts"]]]);
    expect(findPane(layout, paneId)?.activePath).toBe("a.ts");
  });

  it("adds a tab once and activates it", () => {
    const first = openInPane(EMPTY_LAYOUT, null, "a.ts");
    const second = openInPane(first.layout, first.paneId, "b.ts");
    const third = openInPane(second.layout, second.paneId, "a.ts");
    expect(shape(third.layout)).toEqual([[["a.ts", "b.ts"]]]);
    expect(findPane(third.layout, third.paneId)?.activePath).toBe("a.ts");
  });
});

describe("openInRightSplit", () => {
  it("creates the first pane when the layout is empty", () => {
    const { layout, paneId } = openInRightSplit(EMPTY_LAYOUT, null, "a.ts");
    expect(shape(layout)).toEqual([[["a.ts"]]]);
    expect(findPane(layout, paneId)?.activePath).toBe("a.ts");
  });

  it("creates a pane right of the source and keeps the source's tabs", () => {
    const first = openInPane(EMPTY_LAYOUT, null, "a.ts");
    const split = openInRightSplit(first.layout, first.paneId, "b.ts");
    expect(shape(split.layout)).toEqual([[["a.ts"], ["b.ts"]]]);
    expect(split.paneId).not.toBe(first.paneId);
    expect(findPane(split.layout, split.paneId)?.activePath).toBe("b.ts");
  });

  it("reuses an existing right neighbour and activates the file there", () => {
    const first = openInPane(EMPTY_LAYOUT, null, "a.ts");
    const split = openInRightSplit(first.layout, first.paneId, "b.ts");
    const again = openInRightSplit(split.layout, first.paneId, "c.ts");
    expect(shape(again.layout)).toEqual([[["a.ts"], ["b.ts", "c.ts"]]]);
    expect(again.paneId).toBe(split.paneId);
    expect(findPane(again.layout, again.paneId)?.activePath).toBe("c.ts");
  });

  it("splits from the first pane when the source pane is gone", () => {
    const first = openInPane(EMPTY_LAYOUT, null, "a.ts");
    const split = openInRightSplit(first.layout, "pane-missing", "b.ts");
    expect(shape(split.layout)).toEqual([[["a.ts"], ["b.ts"]]]);
  });
});

describe("closeTabsWhere", () => {
  it("closes the matching tabs of every pane and removes the panes it empties", () => {
    let { layout, paneId } = openInPane(EMPTY_LAYOUT, null, "src/a.ts");
    ({ layout } = openInPane(layout, paneId, "b.ts"));
    const right = openInRightSplit(layout, paneId, "src/c.ts");
    layout = closeTabsWhere(right.layout, (path) => path.startsWith("src/"));
    expect(shape(layout)).toEqual([[["b.ts"]]]);
    expect(findPane(layout, paneId)?.activePath).toBe("b.ts");
  });
});

describe("closeTab", () => {
  it("activates the right neighbour, then the left one, and removes empty panes", () => {
    let { layout, paneId } = openInPane(EMPTY_LAYOUT, null, "a.ts");
    ({ layout } = openInPane(layout, paneId, "b.ts"));
    ({ layout } = openInPane(layout, paneId, "c.ts"));
    ({ layout } = openInPane(layout, paneId, "b.ts"));
    layout = closeTab(layout, paneId, "b.ts");
    expect(findPane(layout, paneId)?.activePath).toBe("c.ts");
    layout = closeTab(layout, paneId, "c.ts");
    expect(findPane(layout, paneId)?.activePath).toBe("a.ts");
    layout = closeTab(layout, paneId, "a.ts");
    expect(layout.rows).toEqual([]);
  });
});

describe("moveActiveTab", () => {
  function twoTabs() {
    const first = openInPane(EMPTY_LAYOUT, null, "a.ts");
    const second = openInPane(first.layout, first.paneId, "b.ts");
    return { layout: second.layout, paneId: second.paneId };
  }

  it("does nothing for a lone tab without a neighbour", () => {
    const { layout, paneId } = openInPane(EMPTY_LAYOUT, null, "a.ts");
    expect(moveActiveTab(layout, paneId, "right")).toBeNull();
    expect(moveActiveTab(layout, paneId, "down")).toBeNull();
  });

  it("creates a pane to the right and to the left", () => {
    const { layout, paneId } = twoTabs();
    const right = moveActiveTab(layout, paneId, "right");
    expect(right && shape(right.layout)).toEqual([[["a.ts"], ["b.ts"]]]);
    const left = moveActiveTab(layout, paneId, "left");
    expect(left && shape(left.layout)).toEqual([[["b.ts"], ["a.ts"]]]);
  });

  it("creates a row below and above", () => {
    const { layout, paneId } = twoTabs();
    const down = moveActiveTab(layout, paneId, "down");
    expect(down && shape(down.layout)).toEqual([[["a.ts"]], [["b.ts"]]]);
    const up = moveActiveTab(layout, paneId, "up");
    expect(up && shape(up.layout)).toEqual([[["b.ts"]], [["a.ts"]]]);
  });

  it("adds the tab to an existing neighbour and closes the emptied source", () => {
    const { layout, paneId } = twoTabs();
    const split = moveActiveTab(layout, paneId, "right");
    expect(split).not.toBeNull();
    const back = moveActiveTab(split!.layout, split!.paneId, "left");
    expect(back && shape(back.layout)).toEqual([[["a.ts", "b.ts"]]]);
    expect(back && findPane(back.layout, back.paneId)?.activePath).toBe("b.ts");
  });

  it("targets the pane in the same column of the neighbouring row, clamped to the row length", () => {
    let { layout, paneId } = twoTabs();
    ({ layout } = openInPane(layout, paneId, "c.ts"));
    const right = moveActiveTab(layout, paneId, "right")!;
    const { layout: withD } = openInPane(right.layout, right.paneId, "d.ts");
    const down = moveActiveTab(withD, right.paneId, "down")!;
    expect(shape(down.layout)).toEqual([[["a.ts", "b.ts"], ["c.ts"]], [["d.ts"]]]);
    const { layout: withE } = openInPane(down.layout, down.paneId, "e.ts");
    const up = moveActiveTab(withE, down.paneId, "up")!;
    expect(shape(up.layout)).toEqual([[["a.ts", "b.ts", "e.ts"], ["c.ts"]], [["d.ts"]]]);
  });
});

describe("withFreshIds", () => {
  it("renames rows and panes and maps the old pane ids to the new ones", () => {
    const layout: PaneLayout = { rows: [{ id: "stored-row", panes: [{ id: "stored-a", tabs: ["a.ts", "b.ts"], activePath: "b.ts" }, { id: "stored-b", tabs: ["c.ts"], activePath: "c.ts" }] }] };
    const { layout: fresh, paneIds } = withFreshIds(layout);
    const panes = allPanes(fresh);
    expect(fresh.rows[0]?.id).not.toBe("stored-row");
    expect(panes.map((pane) => pane.id)).toEqual([paneIds.get("stored-a"), paneIds.get("stored-b")]);
    expect(panes.map((pane) => pane.id)).not.toContain("stored-a");
    expect(new Set(panes.map((pane) => pane.id)).size).toBe(2);
    expect(panes.map(({ tabs, activePath }) => ({ tabs, activePath }))).toEqual([
      { tabs: ["a.ts", "b.ts"], activePath: "b.ts" },
      { tabs: ["c.ts"], activePath: "c.ts" },
    ]);
  });
});
