import { describe, expect, it } from "vitest";
import { markedColor, type FolderMarks } from "./folder-colors.store";

describe("markedColor", () => {
  const marks: FolderMarks = { "apps/med": "yellow", "apps/med/admin-ui/src": "blue", "apps/backend": "rose" };

  it("returns the folder's own mark", () => {
    expect(markedColor(marks, "apps/med")).toBe("yellow");
  });

  it("inherits the nearest marked ancestor for folders and files", () => {
    expect(markedColor(marks, "apps/med/admin-ui")).toBe("yellow");
    expect(markedColor(marks, "apps/med/admin-ui/package.json")).toBe("yellow");
    expect(markedColor(marks, "apps/med/admin-ui/src/app/main.ts")).toBe("blue");
  });

  it("returns null outside of every marked folder, the root included", () => {
    expect(markedColor(marks, "apps")).toBeNull();
    expect(markedColor(marks, "apps/medical")).toBeNull();
    expect(markedColor(marks, "")).toBeNull();
    expect(markedColor({}, "apps/med")).toBeNull();
  });
});
