import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_IDE_SESSION, noteCaret, useIdeStore, type Location } from "./ideStore";
import { allPanes, findPane } from "./paneGrid";

const SESSION = "s1";

function session() {
  return useIdeStore.getState().sessions[SESSION] ?? EMPTY_IDE_SESSION;
}

function activePane() {
  const current = session();
  return current.activePaneId ? findPane(current.layout, current.activePaneId) : null;
}

function tabs(): string[][] {
  return allPanes(session().layout).map((pane) => pane.tabs);
}

/** Opens `path` in the active pane and reports the caret there, like the editor pane does once it shows the file. */
function openAndSit(path: string, line: number, options?: { inRightSplit?: boolean }) {
  useIdeStore.getState().openFile(SESSION, path, options);
  const pane = activePane();
  if (!pane) throw new Error("no active pane");
  noteCaret(SESSION, { paneId: pane.id, path, line, column: 1 });
}

function spots(locations: Location[]): string[] {
  return locations.map((location) => `${location.path}:${location.line}`);
}

beforeEach(() => {
  useIdeStore.setState({ sessions: {} });
});

describe("openFile", () => {
  it("reuses the tab of a pane that already shows the file instead of opening it again", () => {
    openAndSit("a.ts", 1);
    openAndSit("b.ts", 1, { inRightSplit: true });
    expect(tabs()).toEqual([["a.ts"], ["b.ts"]]);
    const rightPane = activePane();
    useIdeStore.getState().openFile(SESSION, "a.ts", { paneId: rightPane?.id });
    expect(tabs()).toEqual([["a.ts"], ["b.ts"]]);
    expect(activePane()?.activePath).toBe("a.ts");
    expect(activePane()?.id).not.toBe(rightPane?.id);
  });

  it("records where a navigation to another file came from", () => {
    openAndSit("a.ts", 12);
    useIdeStore.getState().openFile(SESSION, "b.ts", { line: 3 });
    expect(spots(session().history.back)).toEqual(["a.ts:12"]);
    expect(session().history.forward).toEqual([]);
  });

  it("records a jump within the same file but not a plain re-activation", () => {
    openAndSit("a.ts", 12);
    useIdeStore.getState().openFile(SESSION, "a.ts");
    expect(session().history.back).toEqual([]);
    useIdeStore.getState().openFile(SESSION, "a.ts", { line: 40 });
    expect(spots(session().history.back)).toEqual(["a.ts:12"]);
  });

  it("does not stack the same spot twice", () => {
    openAndSit("a.ts", 12);
    useIdeStore.getState().openFile(SESSION, "b.ts", { line: 3 });
    noteCaret(SESSION, { paneId: activePane()!.id, path: "a.ts", line: 12, column: 1 });
    useIdeStore.getState().openFile(SESSION, "c.ts", { line: 3 });
    expect(spots(session().history.back)).toEqual(["a.ts:12"]);
  });
});

describe("navigateBack / navigateForward", () => {
  it("returns to the previous file and position, and forward undoes that", () => {
    openAndSit("a.ts", 12);
    useIdeStore.getState().openFile(SESSION, "b.ts", { line: 3 });
    noteCaret(SESSION, { paneId: activePane()!.id, path: "b.ts", line: 3, column: 5 });

    useIdeStore.getState().navigateBack(SESSION);
    expect(activePane()?.activePath).toBe("a.ts");
    expect(session().pendingPosition).toMatchObject({ path: "a.ts", line: 12, column: 1 });
    expect(session().history.back).toEqual([]);
    expect(spots(session().history.forward)).toEqual(["b.ts:3"]);

    noteCaret(SESSION, { paneId: activePane()!.id, path: "a.ts", line: 12, column: 1 });
    useIdeStore.getState().navigateForward(SESSION);
    expect(activePane()?.activePath).toBe("b.ts");
    expect(session().pendingPosition).toMatchObject({ path: "b.ts", line: 3, column: 5 });
    expect(spots(session().history.back)).toEqual(["a.ts:12"]);
    expect(session().history.forward).toEqual([]);
  });

  it("uses the pane that still holds the file rather than opening another tab", () => {
    openAndSit("a.ts", 12);
    openAndSit("b.ts", 1, { inRightSplit: true });
    const leftPaneId = allPanes(session().layout)[0].id;
    useIdeStore.getState().openFile(SESSION, "c.ts", { line: 8 });
    noteCaret(SESSION, { paneId: activePane()!.id, path: "c.ts", line: 8, column: 1 });
    useIdeStore.getState().navigateBack(SESSION);
    expect(activePane()?.activePath).toBe("b.ts");
    useIdeStore.getState().navigateBack(SESSION);
    expect(activePane()?.id).toBe(leftPaneId);
    expect(activePane()?.activePath).toBe("a.ts");
    expect(tabs()).toEqual([["a.ts"], ["b.ts", "c.ts"]]);
  });

  it("reopens a closed file in the pane it was seen in", () => {
    openAndSit("a.ts", 12);
    const paneId = activePane()!.id;
    useIdeStore.getState().openFile(SESSION, "b.ts", { line: 3 });
    noteCaret(SESSION, { paneId, path: "b.ts", line: 3, column: 1 });
    useIdeStore.getState().closeTab(SESSION, paneId, "a.ts");
    useIdeStore.getState().navigateBack(SESSION);
    expect(tabs()).toEqual([["b.ts", "a.ts"]]);
    expect(activePane()?.activePath).toBe("a.ts");
  });

  it("does nothing without history", () => {
    openAndSit("a.ts", 12);
    const before = session();
    useIdeStore.getState().navigateBack(SESSION);
    expect(session()).toBe(before);
  });
});
