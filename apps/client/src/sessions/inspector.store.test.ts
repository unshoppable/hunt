import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_VIEW_LIMIT, withSessionView, type InspectorView } from "./inspector.store";

describe("withSessionView", () => {
  it("merges the change into the session's view and moves it to the end", () => {
    const views: Record<string, InspectorView> = { first: { tab: "git", diffPath: "a.ts" }, second: { tab: "diff" } };
    const result = withSessionView(views, "first", { diffPath: "b.ts" });
    expect(Object.keys(result)).toEqual(["second", "first"]);
    expect(result.first).toEqual({ tab: "git", diffPath: "b.ts" });
  });

  it("drops the least recently changed views beyond the limit", () => {
    const views = Object.fromEntries(Array.from({ length: SESSION_VIEW_LIMIT }, (_, index) => [`session-${index}`, { tab: "diff" as const }]));
    const result = withSessionView(views, "new", { tab: "editor" });
    expect(Object.keys(result)).toHaveLength(SESSION_VIEW_LIMIT);
    expect(result["session-0"]).toBeUndefined();
    expect(result.new).toEqual({ tab: "editor" });
  });
});

describe("persisted editors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("stores the layout of an editor as its rows and reads it back as an equal PaneLayout", async () => {
    const entries = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    };
    // `persist` reads `window.localStorage` when the store is created, so the store module is loaded again with it.
    vi.stubGlobal("window", { localStorage });
    vi.resetModules();
    const { useSessionViewStore } = await import("./inspector.store");
    const { PaneLayout } = await import("../ide/pane-layout.value-object");
    const opened = PaneLayout.EMPTY.withFileOpened(null, "a.ts");
    const { layout } = opened.layout.withFileInRightSplit(opened.paneId, "b.ts");

    useSessionViewStore.getState().setEditor("s1", { layout, activePaneId: opened.paneId, viewStates: {} });
    expect(JSON.parse(entries.get("hunt-session-views") ?? "{}").state.views.s1.editor.layout).toEqual({ rows: layout.rows });

    await useSessionViewStore.persist.rehydrate();
    const reloaded = useSessionViewStore.getState().views.s1?.editor?.layout;
    expect(reloaded).toBeInstanceOf(PaneLayout);
    expect(reloaded).not.toBe(layout);
    expect(reloaded?.isEqualTo(layout)).toBe(true);
  });
});
