import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutFromPixels, pixelsFromLayout, readLegacyLayout, readPaneSizes, writePaneSizes } from "./pane-sizes.utils";

describe("layoutFromPixels", () => {
  it("gives every pane but the fill pane its remembered width and the fill pane the rest", () => {
    expect(layoutFromPixels({ sessions: 480, chat: 920 }, ["sessions", "chat", "inspector"], "inspector", 4000)).toEqual({
      sessions: 12,
      chat: 23,
      inspector: 65,
    });
  });

  it("keeps the remembered widths in a narrower group, so only the fill pane shrinks", () => {
    expect(layoutFromPixels({ files: 500 }, ["files", "viewer"], "viewer", 2000)).toEqual({ files: 25, viewer: 75 });
  });

  it("leaves the fill pane a negative share when the remembered widths overflow the group", () => {
    expect(layoutFromPixels({ files: 500 }, ["files", "viewer"], "viewer", 400)).toEqual({ files: 125, viewer: -25 });
  });

  it("returns null when a pane has no remembered width", () => {
    expect(layoutFromPixels({ refs: 300 }, ["refs", "log", "commit"], "log", 2000)).toBeNull();
  });

  it("returns null while the group has no space or lacks the fill pane", () => {
    expect(layoutFromPixels({ files: 500 }, ["files", "viewer"], "viewer", 0)).toBeNull();
    expect(layoutFromPixels({ files: 500 }, ["files", "viewer"], "preview", 2000)).toBeNull();
  });
});

describe("pixelsFromLayout", () => {
  it("returns the rounded pixel widths of every pane but the fill pane", () => {
    expect(pixelsFromLayout({ sessions: 12.507, chat: 23.887, inspector: 63.606 }, "inspector", 3838)).toEqual({ sessions: 480, chat: 917 });
  });

  it("round-trips through layoutFromPixels", () => {
    const sizes = { refs: 360, commit: 900 };
    const layout = layoutFromPixels(sizes, ["refs", "log", "commit"], "log", 2400);
    expect(layout && pixelsFromLayout(layout, "log", 2400)).toEqual(sizes);
  });
});

describe("pane size storage", () => {
  let entries: Map<string, string>;

  beforeEach(() => {
    entries = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the sizes of every group under one key", () => {
    writePaneSizes("hunt-panes", { sessions: 480, chat: 917 });
    writePaneSizes("hunt-diff", { files: 506 });
    expect(readPaneSizes("hunt-panes")).toEqual({ sessions: 480, chat: 917 });
    expect(readPaneSizes("hunt-diff")).toEqual({ files: 506 });
    expect(readPaneSizes("hunt-git")).toBeNull();
  });

  it("reads the percentage layout of a group until it stores pixels, then drops it", () => {
    entries.set("react-resizable-panels:hunt-diff", '{"files":20.75,"viewer":79.25}');
    expect(readLegacyLayout("hunt-diff")).toEqual({ files: 20.75, viewer: 79.25 });
    writePaneSizes("hunt-diff", { files: 506 });
    expect(readLegacyLayout("hunt-diff")).toBeUndefined();
  });

  it("ignores stored values that are not size maps", () => {
    entries.set("hunt-pane-sizes", '{"hunt-panes":{"sessions":"wide"},"hunt-diff":{"files":506}}');
    entries.set("react-resizable-panels:hunt-git", "not json");
    expect(readPaneSizes("hunt-panes")).toBeNull();
    expect(readPaneSizes("hunt-diff")).toEqual({ files: 506 });
    expect(readLegacyLayout("hunt-git")).toBeUndefined();
  });
});
