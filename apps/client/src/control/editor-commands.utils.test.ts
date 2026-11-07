import { describe, expect, it } from "vitest";
import type { IdeSession } from "../ide/ide.store";
import { PaneLayout, type Pane } from "../ide/pane-layout.value-object";
import { editorState, paneHolding } from "./editor-commands.utils";

const LEFT: Pane = { id: "left", tabs: ["a.ts", "b.ts"], activePath: "a.ts" };
const RIGHT: Pane = { id: "right", tabs: ["b.ts"], activePath: "b.ts" };
const EMPTY: IdeSession = { layout: PaneLayout.EMPTY, activePaneId: null, pendingPosition: null, revealRequest: null, history: { back: [], forward: [] } };

describe("paneHolding", () => {
  it("prefers the active pane among those that have the file open", () => {
    expect(paneHolding([LEFT, RIGHT], "right", "b.ts")).toBe(RIGHT);
    expect(paneHolding([LEFT, RIGHT], "left", "b.ts")).toBe(LEFT);
    expect(paneHolding([LEFT, RIGHT], null, "b.ts")).toBe(LEFT);
    expect(paneHolding([LEFT, RIGHT], "right", "a.ts")).toBe(LEFT);
  });

  it("is null for a file no pane has open", () => {
    expect(paneHolding([LEFT, RIGHT], "left", "c.ts")).toBeNull();
  });
});

describe("editorState", () => {
  it("reports the panes, the active pane, the dirty files and whether back and forward lead anywhere", () => {
    const location = { paneId: "left", path: "a.ts", line: 1, column: 1 };
    const session: IdeSession = {
      ...EMPTY,
      layout: new PaneLayout({ rows: [{ id: "row", panes: [LEFT, RIGHT] }] }),
      activePaneId: "right",
      history: { back: [location], forward: [] },
    };

    expect(editorState(session, ["b.ts"])).toStrictEqual({ panes: [LEFT, RIGHT], activePaneId: "right", dirty: ["b.ts"], canGoBack: true, canGoForward: false });
  });

  it("reports an empty editor", () => {
    expect(editorState(EMPTY, [])).toStrictEqual({ panes: [], activePaneId: null, dirty: [], canGoBack: false, canGoForward: false });
  });
});
