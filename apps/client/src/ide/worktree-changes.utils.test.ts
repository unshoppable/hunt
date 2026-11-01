import { describe, expect, it } from "vitest";
import { changesSince, foldersToRelist } from "./worktree-changes.utils";

const CHANGES = { paths: ["src/a.ts", "src/b.ts", "old"], entryPaths: ["src/b.ts", "old"] };

describe("changesSince", () => {
  it("names the watch's paths only when its bump is the one since the last refresh", () => {
    expect(changesSince(4, 5, { editVersion: 5, changes: CHANGES })).toBe(CHANGES);
  });

  it("counts every other bump, two bumps at once and no bump as a change of anything", () => {
    expect(changesSince(4, 5, null)).toBeNull();
    expect(changesSince(4, 6, { editVersion: 5, changes: CHANGES })).toBeNull();
    expect(changesSince(3, 5, { editVersion: 5, changes: CHANGES })).toBeNull();
    expect(changesSince(5, 5, { editVersion: 5, changes: CHANGES })).toBeNull();
  });
});

describe("foldersToRelist", () => {
  const listed = ["", "src", "src/app", "old", "docs"];

  it("relists the folders whose entries were created, removed or renamed, and such a folder itself", () => {
    expect(foldersToRelist(listed, CHANGES)).toEqual(["", "src", "old"]);
  });

  it("relists nothing when only file contents changed", () => {
    expect(foldersToRelist(listed, { paths: ["src/a.ts"], entryPaths: [] })).toEqual([]);
  });

  it("relists every listed folder when anything may have changed", () => {
    expect(foldersToRelist(listed, null)).toEqual(listed);
  });
});
