import { describe, expect, it } from "vitest";
import { treeKeyAction, type TreeNavRow } from "./treeNavigation";

// src (open) > app (open) > main.ts, app/index.ts; src/lib (closed); README.md
const rows: TreeNavRow[] = [
  { key: "src", depth: 0, isExpanded: true },
  { key: "src/app", depth: 1, isExpanded: true },
  { key: "src/app/main.ts", depth: 2 },
  { key: "src/index.ts", depth: 1 },
  { key: "src/lib", depth: 1, isExpanded: false },
  { key: "README.md", depth: 0 },
];

describe("treeKeyAction", () => {
  it("steps through the visible rows and stays at either end", () => {
    expect(treeKeyAction(rows, "src/app/main.ts", "ArrowDown")).toEqual({ type: "move", key: "src/index.ts" });
    expect(treeKeyAction(rows, "src/index.ts", "ArrowUp")).toEqual({ type: "move", key: "src/app/main.ts" });
    expect(treeKeyAction(rows, "README.md", "ArrowDown")).toEqual({ type: "move", key: "README.md" });
    expect(treeKeyAction(rows, "src", "ArrowUp")).toEqual({ type: "move", key: "src" });
  });

  it("jumps to the first and the last row", () => {
    expect(treeKeyAction(rows, "src/index.ts", "Home")).toEqual({ type: "move", key: "src" });
    expect(treeKeyAction(rows, null, "End")).toEqual({ type: "move", key: "README.md" });
  });

  it("starts at the first row without a visible cursor", () => {
    expect(treeKeyAction(rows, null, "ArrowUp")).toEqual({ type: "move", key: "src" });
    expect(treeKeyAction(rows, "src/lib/hidden.ts", "ArrowDown")).toEqual({ type: "move", key: "src" });
    expect(treeKeyAction(rows, null, "Enter")).toBeNull();
    expect(treeKeyAction([], null, "ArrowDown")).toBeNull();
  });

  it("expands a collapsed row on → and steps into an expanded one", () => {
    expect(treeKeyAction(rows, "src/lib", "ArrowRight")).toEqual({ type: "toggle", key: "src/lib" });
    expect(treeKeyAction(rows, "src/app", "ArrowRight")).toEqual({ type: "move", key: "src/app/main.ts" });
    expect(treeKeyAction(rows, "src/index.ts", "ArrowRight")).toBeNull();
  });

  it("does not step into an expanded row whose children are not listed yet", () => {
    expect(treeKeyAction([{ key: "a", depth: 0, isExpanded: true }, { key: "b", depth: 0 }], "a", "ArrowRight")).toBeNull();
  });

  it("collapses an expanded row on ← and otherwise goes to the parent", () => {
    expect(treeKeyAction(rows, "src/app", "ArrowLeft")).toEqual({ type: "toggle", key: "src/app" });
    expect(treeKeyAction(rows, "src/app/main.ts", "ArrowLeft")).toEqual({ type: "move", key: "src/app" });
    expect(treeKeyAction(rows, "src/lib", "ArrowLeft")).toEqual({ type: "move", key: "src" });
    expect(treeKeyAction(rows, "README.md", "ArrowLeft")).toBeNull();
  });

  it("toggles a row with children on Enter, activates any other and checks on Space", () => {
    expect(treeKeyAction(rows, "src/lib", "Enter")).toEqual({ type: "toggle", key: "src/lib" });
    expect(treeKeyAction(rows, "src/index.ts", "Enter")).toEqual({ type: "activate", key: "src/index.ts" });
    expect(treeKeyAction(rows, "src/app", " ")).toEqual({ type: "check", key: "src/app" });
    expect(treeKeyAction(rows, "src/app", "a")).toBeNull();
  });
});
